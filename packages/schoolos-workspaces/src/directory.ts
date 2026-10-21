import {
  ID_PREFIXES,
  SchoolOsError,
  type Action,
  type AuthorizationRequest,
  type CourseOffering,
  type DistrictDirectorySnapshot,
  type OfferingId,
  type ResourceRef,
  type TermId,
  type TermState,
  type WorkspaceId,
  ArtifactId,
} from "@schoolos/contracts";
import type { AcademicStore, Caller } from "@schoolos/academics";
import type { PolicyDecider } from "@schoolos/policy";
import { workspaceLifecycle } from "./lifecycle.ts";
import {
  RetentionPolicy,
  type CourseGrant,
  type CourseWorkspace,
  type GrantRevocationReason,
  type PersonalWorkspace,
  type PromotionLink,
  type TermRolloverPreview,
  type Workspace,
  type WorkspaceEvent,
  type WorkspaceState,
  type WorkspaceView,
} from "./model.ts";
import type { WorkspaceStore } from "./store.ts";

/** What a {@link WorkspaceDirectory} is built from. */
export interface WorkspaceDirectoryOptions {
  /** Where the district's workspace records are kept. */
  workspaces: WorkspaceStore;
  /** The district's academic directory, read for principals, offerings, terms and enrollments. Never written. */
  directory: AcademicStore;
  /** Decides and audits every access. */
  policy: PolicyDecider;
  /** How long course workspaces are kept after their term closes. */
  retention: RetentionPolicy;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

/** What {@link WorkspaceDirectory.closeTerm} changed. */
export interface TermCloseResult {
  /** Course workspaces now retained. */
  retained: number;
  /** Live course grants revoked. */
  grantsRevoked: number;
  /** `course-ai-funding.cancelled` events emitted, one per offering. */
  fundingCancellations: number;
}

/** A resource to authorize against, with the state of the term it belongs to, if any. */
interface Target {
  resource: ResourceRef;
  termState?: TermState;
}

/** One attempt at a change: the state to commit, if anything changed, and the result to return. */
interface Mutation<T> {
  next?: WorkspaceState;
  result: T;
}

/** Commit attempts before a write gives up on concurrent changes and reports the conflict. */
const COMMIT_ATTEMPTS = 3;

function notFound(kind: string, id: string): SchoolOsError {
  return new SchoolOsError("not-found", `${kind} ${id} was not found.`);
}

function offeringScope(offering: CourseOffering): ResourceRef["scope"] {
  return { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id };
}

/**
 * The SchoolOS workspace directory (roadmap W01): one district's logical workspaces, separate from
 * whatever storage backs them.
 *
 * - **Personal** workspaces: one per principal, permanent, visible only to their owner.
 * - **Course** workspaces: one per student per offering, holding live course grants while the
 *   student is enrolled and the term is open, and retained after the term closes.
 *
 * Workspaces are provisioned lazily, on the owner's first access, and never in bulk. Every read
 * and list is decided by the policy engine from a `ResourceRef` built only from stored records:
 * the student as owner, `personal-private` or `course` classification, and the offering's term
 * state. Reads the caller may not make answer `not-found`. Nothing is ever deleted here; a roster
 * drop revokes grants, and only retention (never the roster) makes a workspace eligible for
 * deletion.
 */
export class WorkspaceDirectory {
  readonly #workspaces: WorkspaceStore;
  readonly #directory: AcademicStore;
  readonly #policy: PolicyDecider;
  readonly #retention: RetentionPolicy;
  readonly #now: () => Date;

  constructor(options: WorkspaceDirectoryOptions) {
    this.#workspaces = options.workspaces;
    this.#directory = options.directory;
    this.#policy = options.policy;
    this.#retention = RetentionPolicy.parse(options.retention);
    this.#now = options.now ?? (() => new Date());
  }

  // Provisioning

  /**
   * The caller's personal workspace, created on first access. Any student or staff principal of
   * the district has one; a service principal does not.
   */
  async ensurePersonalWorkspace(caller: Caller): Promise<WorkspaceView> {
    const access = this.#access(caller);
    return this.#mutate(async (state, snapshot) => {
      const { workspace, next } = await access.personalWorkspace(state, snapshot);
      return { ...(next === undefined ? {} : { next }), result: this.#view(caller, workspace, snapshot, state) };
    });
  }

  /**
   * The caller's workspace for an offering, created on first access with live course grants. Only
   * a student actively enrolled in the offering may create one, and only while policy lets them
   * create course work there (not once the term is completed). A student who already has one keeps
   * reading it after leaving the roster; if they are enrolled again, their grants are reissued.
   */
  async ensureCourseWorkspace(caller: Caller, offeringId: OfferingId): Promise<WorkspaceView> {
    const access = this.#access(caller);
    return this.#mutate(async (state, snapshot) => {
      const offering = snapshot.offerings.find((o) => o.id === offeringId);
      if (offering === undefined) throw notFound("offering", offeringId);
      const me = caller.principal.principalId;
      const enrollments = snapshot.enrollments.filter((e) => e.principalId === me && e.offeringId === offeringId);
      const enrolled = enrollments.some((e) => e.role === "student" && e.status === "active");
      const now = this.#now().toISOString();

      const existing = state.workspaces.find(
        (w): w is CourseWorkspace => w.kind === "course" && w.ownerPrincipalId === me && w.offeringId === offeringId,
      );
      if (existing !== undefined) {
        await access.requireRead(existing, snapshot);
        const hasLiveGrants = state.grants.some((g) => g.workspaceId === existing.id && g.state === "live");
        if (!enrolled || hasLiveGrants || !(await access.allows("update", courseTarget(existing, snapshot)))) {
          return { result: this.#view(caller, existing, snapshot, state) };
        }
        const next = { ...state, grants: [...state.grants, ...liveGrants(existing, now)] };
        return { next, result: this.#view(caller, existing, snapshot, next) };
      }

      if (!enrolled) {
        if (enrollments.length === 0) throw notFound("offering", offeringId);
        throw new SchoolOsError("forbidden", "Only a student enrolled in this class has a workspace for it.");
      }
      const workspace: CourseWorkspace = {
        kind: "course",
        id: newWorkspaceId(),
        districtId: offering.districtId,
        ownerPrincipalId: me,
        createdAt: now,
        schoolId: offering.schoolId,
        offeringId: offering.id,
        termId: offering.termId,
      };
      if (!(await access.allows("create", courseTarget(workspace, snapshot)))) {
        throw new SchoolOsError("forbidden", "This class is not accepting new work.");
      }
      const next = {
        ...state,
        workspaces: [...state.workspaces, workspace],
        grants: [...state.grants, ...liveGrants(workspace, now)],
      };
      return { next, result: this.#view(caller, workspace, snapshot, next) };
    });
  }

  // Reads

  /** One workspace, if the caller may read it. */
  async getWorkspace(caller: Caller, workspaceId: WorkspaceId): Promise<WorkspaceView> {
    const { state, snapshot } = await this.#load();
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    if (workspace === undefined) throw notFound("workspace", workspaceId);
    await this.#access(caller).requireRead(workspace, snapshot);
    return this.#view(caller, workspace, snapshot, state);
  }

  /** The caller's own workspaces, personal and course. Provisions nothing. */
  async listMyWorkspaces(caller: Caller): Promise<WorkspaceView[]> {
    const { state, snapshot } = await this.#load();
    const access = this.#access(caller);
    const mine = state.workspaces.filter((w) => w.ownerPrincipalId === caller.principal.principalId);
    return (await access.readable(mine, snapshot)).map((w) => this.#view(caller, w, snapshot, state));
  }

  /**
   * The course workspaces of one offering that the caller may read: a teacher sees their students'
   * course workspace records (never their contents, and never a personal workspace); a student sees
   * only their own.
   */
  async listOfferingWorkspaces(caller: Caller, offeringId: OfferingId): Promise<WorkspaceView[]> {
    const { state, snapshot } = await this.#load();
    const offering = snapshot.offerings.find((o) => o.id === offeringId);
    if (offering === undefined) throw notFound("offering", offeringId);
    const access = this.#access(caller);
    const term = snapshot.terms.find((t) => t.id === offering.termId);
    const collection: Target = {
      resource: { kind: "course-workspace", scope: offeringScope(offering), classification: "course" },
      ...(term === undefined ? {} : { termState: term.state }),
    };
    if (!(await access.allows("list", collection))) throw notFound("offering", offeringId);
    const inOffering = state.workspaces.filter((w) => w.kind === "course" && w.offeringId === offeringId);
    return (await access.readable(inOffering, snapshot)).map((w) => this.#view(caller, w, snapshot, state));
  }

  // Roster changes and term close

  /**
   * Revokes the live course grants of every student no longer actively enrolled in the grant's
   * offering, and cancels their course AI funding. Their workspaces are kept and stay readable by
   * them. Run after a roster sync; requires authority over the district's enrollments.
   */
  async reconcileCourseGrants(caller: Caller): Promise<{ revoked: number }> {
    const access = this.#access(caller);
    return this.#mutate(async (state, snapshot) => {
      const roster: Target = {
        resource: { kind: "enrollment", scope: { level: "district", districtId: snapshot.district.id }, classification: "course" },
      };
      if (!(await access.allows("update", roster))) throw new SchoolOsError("forbidden", "You may not manage this district's enrollments.");
      const enrolled = (g: CourseGrant) =>
        snapshot.enrollments.some((e) =>
          e.principalId === g.principalId && e.offeringId === g.offeringId && e.role === "student" && e.status === "active",
        );
      const dropped = state.grants.filter((g) => g.state === "live" && !enrolled(g));
      if (dropped.length === 0) return { result: { revoked: 0 } };
      const now = this.#now().toISOString();
      const next = revokeGrants(state, dropped, "roster-dropped", now);
      return { next, result: { revoked: dropped.length } };
    });
  }

  /**
   * What {@link closeTerm} would change, in counts only. Requires the authority to close the term
   * (district administration). Works in any term state, so an administrator can review a term
   * before completing it.
   */
  async previewTermRollover(caller: Caller, termId: TermId): Promise<TermRolloverPreview> {
    const { state, snapshot } = await this.#load();
    const plan = await this.#authorizeTermClose(caller, snapshot, termId);
    return previewOf(plan, state, snapshot);
  }

  /**
   * Closes a completed term's workspaces: each course workspace in it becomes `retained` (and stays
   * readable by its owner), every live course grant in it is revoked, and one
   * `course-ai-funding.cancelled` event is emitted per offering. Idempotent; refused with `conflict`
   * unless the directory already has the term `completed`. Requires district administration.
   */
  async closeTerm(caller: Caller, termId: TermId): Promise<TermCloseResult> {
    return this.#mutate(async (state, snapshot) => {
      const plan = await this.#authorizeTermClose(caller, snapshot, termId);
      const preview = previewOf(plan, state, snapshot);
      if (preview.alreadyClosed) return { result: { retained: 0, grantsRevoked: 0, fundingCancellations: 0 } };
      if (!preview.canClose) throw new SchoolOsError("conflict", "Only a completed term can be closed.");

      const now = this.#now().toISOString();
      const live = state.grants.filter((g) => g.state === "live" && g.termId === termId);
      const revoked = revokeGrants(state, live, "term-closed", now, plan.offerings);
      const next: WorkspaceState = {
        ...revoked,
        closures: [...revoked.closures, { termId, closedAt: now, closedBy: caller.principal.principalId }],
      };
      return {
        next,
        result: { retained: preview.workspaces.toRetain, grantsRevoked: live.length, fundingCancellations: plan.offerings.length },
      };
    });
  }

  // Promotion and legal hold

  /**
   * Links an artifact from the caller's closed course workspace into their personal workspace,
   * provisioning that on first use. Idempotent per artifact. Policy decides both halves: exporting
   * the course artifact, and creating a personal-private one. The link is all this records; W02
   * copies content, and must confirm the artifact is in the course workspace.
   */
  async promoteArtifact(caller: Caller, fromWorkspaceId: WorkspaceId, rawArtifactId: ArtifactId): Promise<PromotionLink> {
    const artifactId = ArtifactId.parse(rawArtifactId);
    const access = this.#access(caller);
    return this.#mutate(async (state, snapshot) => {
      const source = state.workspaces.find((w) => w.id === fromWorkspaceId);
      if (source === undefined) throw notFound("workspace", fromWorkspaceId);
      await access.requireRead(source, snapshot);
      // Staff may read a student's course workspace record, but only its owner promotes from it.
      if (source.kind !== "course" || source.ownerPrincipalId !== caller.principal.principalId) {
        throw notFound("workspace", fromWorkspaceId);
      }
      const lifecycle = this.#lifecycle(source, snapshot, state);
      if (lifecycle !== "retained" && lifecycle !== "eligible-for-deletion") {
        throw new SchoolOsError("conflict", "Work can be kept in your personal workspace once the class has closed.");
      }
      const exported = courseTarget(source, snapshot);
      exported.resource = { ...exported.resource, kind: "artifact", id: artifactId };
      if (!(await access.allows("export", exported))) throw new SchoolOsError("forbidden", "This work cannot be kept.");

      const { workspace: personal, next: withPersonal } = await access.personalWorkspace(state, snapshot);
      const promoted = personalTarget(personal);
      promoted.resource = { ...promoted.resource, kind: "artifact" };
      if (!(await access.allows("create", promoted))) throw new SchoolOsError("forbidden", "This work cannot be kept.");

      const current = withPersonal ?? state;
      const existing = current.promotions.find((p) => p.fromWorkspaceId === source.id && p.artifactId === artifactId);
      if (existing !== undefined) return { ...(withPersonal === undefined ? {} : { next: withPersonal }), result: existing };
      const link: PromotionLink = {
        principalId: caller.principal.principalId,
        fromWorkspaceId: source.id,
        toWorkspaceId: personal.id,
        artifactId,
        promotedAt: this.#now().toISOString(),
      };
      return { next: { ...current, promotions: [...current.promotions, link] }, result: link };
    });
  }

  /**
   * Places or lifts a legal hold on a workspace. A held workspace is never eligible for deletion.
   * Requires district administration, which is checked before the workspace is looked up so the
   * call reveals nothing to anyone else. Placing a hold does not let the administrator read the
   * workspace.
   */
  async setLegalHold(caller: Caller, workspaceId: WorkspaceId, held: boolean): Promise<void> {
    const access = this.#access(caller);
    await this.#mutate(async (state, snapshot) => {
      const district: Target = {
        resource: {
          kind: "district",
          id: snapshot.district.id,
          scope: { level: "district", districtId: snapshot.district.id },
          classification: "district-internal",
        },
      };
      if (!(await access.allows("update", district))) throw new SchoolOsError("forbidden", "You may not place legal holds.");
      const workspace = state.workspaces.find((w) => w.id === workspaceId);
      if (workspace === undefined) throw notFound("workspace", workspaceId);
      if ((workspace.legalHold !== undefined) === held) return { result: undefined };
      const { legalHold: _previous, ...rest } = workspace;
      const updated: Workspace = held
        ? { ...rest, legalHold: { placedAt: this.#now().toISOString(), placedBy: caller.principal.principalId } }
        : rest;
      return {
        next: { ...state, workspaces: state.workspaces.map((w) => (w.id === workspaceId ? updated : w)) },
        result: undefined,
      };
    });
  }

  // Internals

  async #authorizeTermClose(caller: Caller, snapshot: DistrictDirectorySnapshot, termId: TermId): Promise<TermPlan> {
    const term = snapshot.terms.find((t) => t.id === termId);
    if (term === undefined) throw notFound("term", termId);
    const target: Target = {
      resource: { kind: "term", id: term.id, scope: { level: "district", districtId: term.districtId }, classification: "district-internal" },
      termState: term.state,
    };
    if (!(await this.#access(caller).allows("update", target))) throw new SchoolOsError("forbidden", "You may not close this term.");
    return { termId, termState: term.state, offerings: snapshot.offerings.filter((o) => o.termId === termId) };
  }

  #access(caller: Caller): Access {
    return new Access(caller, this.#policy, crypto.randomUUID(), () => this.#now().toISOString());
  }

  #lifecycle(workspace: Workspace, snapshot: DistrictDirectorySnapshot, state: WorkspaceState) {
    if (workspace.kind === "personal") return workspaceLifecycle(workspace, { retention: this.#retention, now: this.#now() });
    const closure = state.closures.find((c) => c.termId === workspace.termId);
    return workspaceLifecycle(workspace, {
      termState: termStateOf(snapshot, workspace.termId),
      ...(closure === undefined ? {} : { closure }),
      retention: this.#retention,
      now: this.#now(),
    });
  }

  #view(caller: Caller, workspace: Workspace, snapshot: DistrictDirectorySnapshot, state: WorkspaceState): WorkspaceView {
    const lifecycle = this.#lifecycle(workspace, snapshot, state);
    if (workspace.ownerPrincipalId === caller.principal.principalId) return { ...workspace, lifecycle };
    const { storageHandle: _contents, ...record } = workspace;
    return { ...record, lifecycle };
  }

  async #load(): Promise<{ state: WorkspaceState; snapshot: DistrictDirectorySnapshot }> {
    const [{ state }, { snapshot }] = await Promise.all([this.#workspaces.load(), this.#directory.load()]);
    return { state, snapshot };
  }

  /** Runs `change` against fresh state and commits what it returns, retrying when a concurrent write wins. */
  async #mutate<T>(change: (state: WorkspaceState, snapshot: DistrictDirectorySnapshot) => Promise<Mutation<T>>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const [{ state, version }, { snapshot }] = await Promise.all([this.#workspaces.load(), this.#directory.load()]);
      const { next, result } = await change(state, snapshot);
      if (next === undefined) return result;
      try {
        await this.#workspaces.commit(next, version);
        return result;
      } catch (error) {
        if (!(error instanceof SchoolOsError && error.code === "conflict") || attempt >= COMMIT_ATTEMPTS) throw error;
      }
    }
  }
}

/** The offerings of a term being closed. */
interface TermPlan {
  termId: TermId;
  termState: TermState;
  offerings: CourseOffering[];
}

/** One caller's policy decisions within one call, audited under one correlation ID. */
class Access {
  readonly #caller: Caller;
  readonly #policy: PolicyDecider;
  readonly #correlationId: string;
  readonly #now: () => string;

  constructor(caller: Caller, policy: PolicyDecider, correlationId: string, now: () => string) {
    this.#caller = caller;
    this.#policy = policy;
    this.#correlationId = correlationId;
    this.#now = now;
  }

  async allows(action: Action, target: Target): Promise<boolean> {
    const request: AuthorizationRequest = {
      subject: this.#caller.principal,
      action,
      resource: target.resource,
      context: { channel: this.#caller.channel, ...(target.termState === undefined ? {} : { termState: target.termState }) },
    };
    const { decision } = await this.#policy.decide(request, { correlationId: this.#correlationId });
    return decision.effect === "allow";
  }

  /** Requires a read, answering `not-found` exactly as for a workspace that does not exist. */
  async requireRead(workspace: Workspace, snapshot: DistrictDirectorySnapshot): Promise<void> {
    if (!(await this.allows("read", workspaceTarget(workspace, snapshot)))) throw notFound("workspace", workspace.id);
  }

  async readable(workspaces: Workspace[], snapshot: DistrictDirectorySnapshot): Promise<Workspace[]> {
    const allowed: Workspace[] = [];
    for (const workspace of workspaces) {
      if (await this.allows("read", workspaceTarget(workspace, snapshot))) allowed.push(workspace);
    }
    return allowed;
  }

  /** The caller's personal workspace, and the state that adds it if this is the first access. */
  async personalWorkspace(
    state: WorkspaceState,
    snapshot: DistrictDirectorySnapshot,
  ): Promise<{ workspace: PersonalWorkspace; next?: WorkspaceState }> {
    const { principalId, districtId } = this.#caller.principal;
    const existing = state.workspaces.find(
      (w): w is PersonalWorkspace => w.kind === "personal" && w.ownerPrincipalId === principalId,
    );
    if (existing !== undefined) {
      await this.requireRead(existing, snapshot);
      return { workspace: existing };
    }
    const principal = snapshot.principals.find((p) => p.id === principalId && p.districtId === districtId);
    if (principal === undefined || principal.kind === "service") {
      throw new SchoolOsError("forbidden", "Only a student or staff member of this district has a personal workspace.");
    }
    const workspace: PersonalWorkspace = {
      kind: "personal",
      id: newWorkspaceId(),
      districtId: principal.districtId,
      ownerPrincipalId: principal.id,
      createdAt: this.#now(),
    };
    if (!(await this.allows("create", personalTarget(workspace)))) {
      throw new SchoolOsError("forbidden", "You may not create a personal workspace.");
    }
    return { workspace, next: { ...state, workspaces: [...state.workspaces, workspace] } };
  }
}

function newWorkspaceId(): WorkspaceId {
  return `${ID_PREFIXES.workspace}_${crypto.randomUUID()}` as WorkspaceId;
}

function termStateOf(snapshot: DistrictDirectorySnapshot, termId: TermId): TermState {
  const term = snapshot.terms.find((t) => t.id === termId);
  if (term === undefined) throw new Error(`term ${termId} is missing from the directory`);
  return term.state;
}

/** A personal workspace as policy sees it: personal-private, owned, and in no term. */
function personalTarget(workspace: PersonalWorkspace): Target {
  return {
    resource: {
      kind: "personal-workspace",
      id: workspace.id,
      scope: { level: "district", districtId: workspace.districtId },
      classification: "personal-private",
      ownerPrincipalId: workspace.ownerPrincipalId,
    },
  };
}

/** A course workspace as policy sees it: course content owned by the student, in the offering's term. */
function courseTarget(workspace: CourseWorkspace, snapshot: DistrictDirectorySnapshot): Target {
  return {
    resource: {
      kind: "course-workspace",
      id: workspace.id,
      scope: { level: "offering", districtId: workspace.districtId, schoolId: workspace.schoolId, offeringId: workspace.offeringId },
      classification: "course",
      ownerPrincipalId: workspace.ownerPrincipalId,
    },
    termState: termStateOf(snapshot, workspace.termId),
  };
}

function workspaceTarget(workspace: Workspace, snapshot: DistrictDirectorySnapshot): Target {
  return workspace.kind === "personal" ? personalTarget(workspace) : courseTarget(workspace, snapshot);
}

function liveGrants(workspace: CourseWorkspace, grantedAt: string): CourseGrant[] {
  return (["course-tools", "course-ai-funding"] as const).map((kind) => ({
    state: "live",
    workspaceId: workspace.id,
    principalId: workspace.ownerPrincipalId,
    offeringId: workspace.offeringId,
    termId: workspace.termId,
    kind,
    grantedAt,
  }));
}

/**
 * Revokes `grants` and emits one `course-ai-funding.cancelled` event per affected offering, plus
 * one for each of `alsoCancel` (a closing term's offerings) even if no grant in it was live.
 */
function revokeGrants(
  state: WorkspaceState,
  grants: CourseGrant[],
  reason: GrantRevocationReason,
  revokedAt: string,
  alsoCancel: CourseOffering[] = [],
): WorkspaceState {
  const revoking = new Set(grants);
  const funded = new Map<OfferingId, WorkspaceEvent>();
  for (const offering of alsoCancel) {
    funded.set(offering.id, { type: "course-ai-funding.cancelled", offeringId: offering.id, termId: offering.termId, principalIds: [], reason, occurredAt: revokedAt });
  }
  for (const grant of grants) {
    if (grant.kind !== "course-ai-funding") continue;
    const event = funded.get(grant.offeringId)
      ?? { type: "course-ai-funding.cancelled", offeringId: grant.offeringId, termId: grant.termId, principalIds: [], reason, occurredAt: revokedAt };
    event.principalIds.push(grant.principalId);
    funded.set(grant.offeringId, event);
  }
  return {
    ...state,
    grants: state.grants.map((g): CourseGrant =>
      g.state === "live" && revoking.has(g) ? { ...g, state: "revoked", revokedAt, reason } : g,
    ),
    events: [...state.events, ...funded.values()],
  };
}

function previewOf(plan: TermPlan, state: WorkspaceState, snapshot: DistrictDirectorySnapshot): TermRolloverPreview {
  const alreadyClosed = state.closures.some((c) => c.termId === plan.termId);
  const offeringIds = new Set(plan.offerings.map((o) => o.id));
  const pending = alreadyClosed ? [] : state.workspaces.filter((w) => w.kind === "course" && w.termId === plan.termId);
  const active = snapshot.enrollments.filter((e) => e.status === "active" && offeringIds.has(e.offeringId));
  const distinct = (roles: readonly string[]) => new Set(active.filter((e) => roles.includes(e.role)).map((e) => e.principalId)).size;
  return {
    termId: plan.termId,
    termState: plan.termState,
    alreadyClosed,
    canClose: !alreadyClosed && plan.termState === "completed",
    offerings: plan.offerings.length,
    workspaces: { toRetain: pending.length, onLegalHold: pending.filter((w) => w.legalHold !== undefined).length },
    grants: { toRevoke: alreadyClosed ? 0 : state.grants.filter((g) => g.state === "live" && g.termId === plan.termId).length },
    principals: { students: distinct(["student"]), staff: distinct(["teacher", "co-teacher"]) },
  };
}
