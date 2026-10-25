import {
  EducateOsError,
  type Action,
  type Authorizer,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type OfferingId,
  type PolicySettings,
  type Principal,
  type PrincipalId,
  type ResourceRef,
  type VerifiedIdentity,
} from "@educateos/contracts";
import { createDirectoryPrincipalResolver, type PrincipalResolver, type ResolvedPrincipal } from "@educateos/identity";
import { AcademicDirectory, isDistrictAdmin } from "@educateos/academics";
import { directoryPolicyInformation, PolicyEngine, subjectFactsFrom, type PolicyDecider, type PolicyRule } from "@educateos/policy";
import { RetentionPolicy, transitionPrincipal, WorkspaceDirectory } from "@educateos/workspaces";
import { LearningArtifacts } from "@educateos/learning-artifacts";
import { AssessmentService, GradebookService, type AssignmentId } from "@educateos/assessment";
import { catalogAlignmentSource, ContentStudio, type AlignmentSource, type ContentReviewer, type ImportFetch } from "@educateos/content-studio";
import { contentStudioReleases, CourseContentService, CurriculumService, type AiHelpPolicySource, type OfferingScope } from "@educateos/curriculum";
import { CatalogMirror, catalogSeedRelease, type VerifyRelease } from "@educateos/catalog";
import { AiLedger, ledgerGovernor, type AiRequestGovernor, type CloudflareAccountFacts, type FundingPool, type GovernedModel, type UsdNano } from "@educateos/ai-governance";
import { createDraftRevision, planConfigurationChange, SHIPPED_REGISTRY, type CapabilityRegistry } from "@educateos/config";
import { oneroster } from "@educateos/integrations";
import { ArtifactsGitBackend, InMemoryCredentialLedger, ProjectArtifacts, type ArtifactsPlan } from "@educateos/artifacts-git";
import { AssessmentCi, AssessmentRuns, builtinRegistry, signRubricRelease, type EvaluatorRegistry } from "@educateos/assessment-ci";
import { changeAllocations, effectivePools } from "./funding.ts";
import { applyRosterImport, contentBody, installAndAssign, keepArtifact, publishStarterMaterial, runCiAndSuggest, termClosedEvents } from "./adapters.ts";
import { CORRELATION_HEADER, errorResponse, jsonResponse, matchRoute, parsePart, readJsonBody } from "./http.ts";
import { configPolicySource, DEFAULT_POLICY_FLOOR, DISTRICT_APP_RULES } from "./policy.ts";
import { type AssignmentViewBody, type ParsedRouteInput, type RouteName, type RouteResponse, type Surface } from "./routes.ts";
import type { DistrictAppStores } from "./stores.ts";
import { guardDirectoryOver, type GuardDirectory } from "./guard-directory.ts";
import { authorityFor, ONEROSTER_AUTHORITY, type AuthoritySetting } from "./authority.ts";
import { exportCourseCartridge, importCourseCartridge, previewCourseCartridge } from "./course-authoring.ts";
// Guardians (ADR-0012, SCHO-188)
import { guardianRelationships, GuardianRelationships } from "@educateos/policy";
import { GuardianInvitations, IdentityLinkAdminService } from "@educateos/identity-links";
import { guardianHandlers, type GuardianRouteName } from "./guardians.ts";
// Communication (SCHO-189)
import { calendarFeedPath } from "./routes.ts";
import { CommunicationService, digestWeekOf, FamilyDigest, isEmpty, renderDigest, type MailSender } from "./communication/index.ts";
// Discussions (SCHO-190)
import { DiscussionService, studentPostView, type DiscussionScreening } from "@educateos/discussions";
// Quizzes (SCHO-191)
import { QuizService } from "@educateos/quizzes";
import { quizGrading } from "./quizzes.ts";

/**
 * Verifies a request's credential (a bearer token, a Cloudflare Access assertion) and returns the
 * identity it proves, or undefined if it proves none. It must check signature, issuer, audience and
 * expiry; the application trusts nothing else about the request.
 */
export type RequestVerifier = (request: Request) => Promise<VerifiedIdentity | undefined>;

/** What a district application is built from. */
export interface DistrictAppOptions {
  /** Where the district's state is kept. See `inMemoryDistrictStores`. */
  stores: DistrictAppStores;
  /** Verifies each request's credential. */
  verifyRequest: RequestVerifier;
  /**
   * Builds the principal resolver for the directory as it stands. Defaults to
   * `createDirectoryPrincipalResolver`; it is rebuilt per request, so a roster import takes effect
   * on the next one.
   */
  resolverFor?: (directory: DistrictDirectorySnapshot) => PrincipalResolver;
  /** The fetch the Content Studio imports URLs with. Its SSRF guard runs before every call. */
  importFetch: ImportFetch;
  /**
   * Which system owns each directory record type: a profile (`oneroster`, or `local` for a district
   * with no roster that authors its own classes) or a full map. Defaults to the OneRoster roster
   * for every type.
   */
  authority?: AuthoritySetting;
  /** How the roster relates to the IdP. Defaults to the district's first trusted issuer, keyed by `username`. */
  roster?: oneroster.OneRosterImportConfig;
  /** How long course workspaces are kept after their term closes. Defaults to a year. */
  retention?: RetentionPolicy;
  /** Hosts students may save links to as external artifacts. Defaults to none. */
  approvedExternalHosts?: readonly string[];
  /**
   * The district's AI funding pools. Defaults to none, so no AI request is funded. Administrators
   * change their monthly allocations through `admin.updateFundingPools`; the latest allocation
   * revision overrides the allocation configured here.
   */
  fundingPools?: readonly FundingPool[];
  /**
   * The district's overall monthly cap on its course and personal pools' allocations together, so
   * the allowances it hands out never promise more than it funds. Defaults to none.
   */
  aiMonthlyDistrictCapUsdNano?: UsdNano;
  /**
   * The Cloudflare account the district's AI usage is billed to, for the net estimate in
   * `admin.aiCostSummary`. Without it only the gross model cost is reported.
   */
  cloudflareAccount?: CloudflareAccountFacts;
  /** The district gateway's model catalog. */
  modelCatalog?: readonly GovernedModel[];
  /** The AI-help levels above each offering. Defaults to `full` help allowed district-wide. */
  aiHelp?: AiHelpPolicySource;
  /** Verifies framework releases before the catalog mirror installs them. Defaults to the catalog's own seed releases only. */
  verifyCatalogRelease?: VerifyRelease;
  /** Resolves resource and activity alignments. Defaults to the district's approved catalog releases. */
  alignments?: AlignmentSource;
  /** The Content Studio's optional AI reviewer. */
  contentReviewer?: ContentReviewer;
  /** The pinned evaluator releases Assessment CI runs. Defaults to the built-in evaluators. */
  evaluators?: EvaluatorRegistry;
  /** Enables multi-file projects (W03), on Cloudflare Artifacts when `plan` is given, else as bundles. */
  projects?: { plan: ArtifactsPlan | undefined };
  /** The capability registry configuration is compiled against. Defaults to the shipped packs. */
  registry?: CapabilityRegistry;
  /** The policy floor before the first configuration revision is applied. */
  defaultPolicy?: PolicySettings;
  /** The policy rule table. Defaults to `DISTRICT_APP_RULES`. */
  rules?: readonly PolicyRule[];
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
  /**
   * Where a guardian redeems an invitation: the family app's invitation page. The token is added
   * as the URL's fragment, so it never reaches a server's logs. Defaults to `/family/invitation`
   * on the request's origin. Email delivery is still to come (L5); until then the administrator
   * hands the link over.
   */
  guardianInvitationPage?: string;

  // Communication (SCHO-189)
  /** Where notification and digest email goes, through a provider in the district's own account. Without it nothing is emailed. */
  mail?: MailSender;
  /** The district's EducateOS address, linked from emails. */
  appUrl?: string;

  // Discussions (SCHO-190).
  /**
   * Hall Monitor screening for students' discussion posts: the district's Hall Monitor client and
   * the policy profile posts are evaluated under. Without it, student posts are published
   * unscreened, and teachers moderate them after (or approve each first, under pre-moderation).
   */
  discussionScreening?: DiscussionScreening;
}

/** The district's communication jobs, which the district Worker runs on its Cron Triggers (SCHO-189). */
export interface CommunicationJobs {
  /** Brings every student's notifications up to date and emails those owed an email. */
  runNotificationJob(): Promise<{ added: number; emailed: number; skipped: number; failed: number }>;
  /** Sends this week's family digest to every guardian not yet sent it. */
  runWeeklyDigest(): Promise<{ week: string; sent: number; skipped: number; failed: number; alreadyDone: number }>;
}

/** One district's running application. */
export interface DistrictApp {
  /** The district. */
  readonly districtId: DistrictId;
  /** Handles one HTTP request. Paths outside `/api/` answer `not-found`. */
  fetch(request: Request): Promise<Response>;
  /** The one policy engine every service decides through. */
  readonly engine: PolicyEngine;
  /** The AI spend ledger. */
  readonly ledger: AiLedger;
  /** The governor a kernel AI Gateway seam calls around every model request (G01). */
  readonly aiGovernor: AiRequestGovernor;
  /**
   * What the EducateOS AI call guard may learn about a Workshop user (SCHO-132): their principal,
   * roles, workspace and grade bands, read afresh from the district's stores. It is not on the
   * `/api` surface; only a deployment that binds the guard to it can call it.
   */
  readonly guardDirectory: GuardDirectory;
  /** The district's framework catalog mirror. Callers authorize first; it records but does not decide. */
  readonly catalog: CatalogMirror;
  /** The stores, for operators and tests. */
  readonly stores: DistrictAppStores;
  /** The communication jobs (SCHO-189). Not on the `/api` surface. */
  readonly communication: CommunicationJobs;
}

/** The default `DistrictAppOptions.authority`: the OneRoster roster owns every directory record type. */
export const DEFAULT_AUTHORITY = ONEROSTER_AUTHORITY;

/** Which principal kinds a surface answers. */
const SURFACE_KINDS: Record<Exclude<Surface, "onboarding">, readonly ResolvedPrincipal["kind"][]> = {
  me: ["student", "staff", "guardian"],
  student: ["student"],
  teacher: ["staff"],
  admin: ["staff"],
  guardian: ["guardian"],
};

/** Accepts a framework release only if it is byte-for-byte the catalog's own seed release. */
const seedReleasesOnly: VerifyRelease = async (release) => {
  try {
    const seed = await catalogSeedRelease(release.frameworkKey);
    return seed.version === release.version && seed.contentDigest === release.contentDigest;
  } catch {
    return false;
  }
};

/**
 * Composes one district's EducateOS domain services into one application behind a typed `/api`
 * surface (see `ROUTES`). Every request:
 *
 * 1. gets a correlation ID, returned in `x-correlation-id` and in any error body, which every
 *    policy decision made for the request is audited under;
 * 2. is matched to a route, and its credential verified and resolved to a principal of this
 *    district through `@educateos/identity` (nothing in the request names who the caller is);
 * 3. has its path, query and body validated against the route's Zod schemas;
 * 4. calls the domain services, built for this request around the one shared `PolicyEngine`, which
 *    authorize it. A route returns only what they returned.
 *
 * Services that record but do not decide (the AI ledger, the catalog mirror, the configuration
 * compiler, the roster importer) are authorized here, through the same engine, before they are
 * called. Each district is its own application over its own stores: nothing is shared between two.
 */
export async function createDistrictApp(options: DistrictAppOptions): Promise<DistrictApp> {
  const { stores } = options;
  const districtId = (await stores.directory.load()).snapshot.district.id;
  const now = options.now ?? (() => new Date());
  const authority = authorityFor(options.authority);
  const retention = RetentionPolicy.parse(options.retention ?? { courseWorkspaceRetentionDays: 365 });
  const registry = options.registry ?? SHIPPED_REGISTRY;
  const policySource = configPolicySource(stores.config, options.defaultPolicy ?? DEFAULT_POLICY_FLOOR);
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(stores.directory, policySource, {
      relationships: [guardianRelationships(stores.guardianRelationships, stores.directory, now)],
      now,
    }),
    audit: stores.audit,
    rules: options.rules ?? DISTRICT_APP_RULES,
    now,
  });
  const catalog = new CatalogMirror({ storage: stores.catalog, verifyRelease: options.verifyCatalogRelease ?? seedReleasesOnly });
  const alignments = options.alignments ?? catalogAlignmentSource(catalog);
  const fundingPools = async () => effectivePools(options.fundingPools ?? [], (await stores.fundingAllocations.list()).at(-1));
  const fundingBody = async () => {
    const [report, revision] = await Promise.all([
      ledger.fundingReport(options.aiMonthlyDistrictCapUsdNano === undefined ? {} : { districtCapUsdNano: options.aiMonthlyDistrictCapUsdNano }),
      stores.fundingAllocations.list().then((revisions) => revisions.at(-1)),
    ]);
    return { report, ...(revision === undefined ? {} : { revision }) };
  };
  const ledger = new AiLedger({
    districtId,
    store: stores.ledger,
    now,
    source: {
      directory: async () => (await stores.directory.load()).snapshot,
      fundingPools,
      termClosures: () => termClosedEvents(stores.workspaces, districtId),
      modelCatalog: async () => [...(options.modelCatalog ?? [])],
      effectivePolicy: (scope) => policySource.effectivePolicy(scope),
    },
  });
  const evaluators = options.evaluators ?? builtinRegistry();
  const assessmentRuns = new AssessmentRuns({ runs: stores.assessmentRuns, rubrics: stores.rubrics, registry: evaluators, now });
  const projectsGit = options.projects === undefined
    ? undefined
    : new ArtifactsGitBackend({ plan: options.projects.plan, ledger: new InMemoryCredentialLedger() });
  const resolverFor = options.resolverFor ?? createDirectoryPrincipalResolver;

  /** Everything one request uses, built around a decider that audits under its correlation ID. */
  class RequestContext {
    readonly correlationId: string;
    readonly principal: ResolvedPrincipal;
    readonly snapshot: DistrictDirectorySnapshot;
    readonly caller: Caller;
    readonly decider: PolicyDecider;
    readonly authorizer: Authorizer;
    readonly origin: string;

    constructor(correlationId: string, principal: ResolvedPrincipal, snapshot: DistrictDirectorySnapshot, origin: string) {
      this.correlationId = correlationId;
      this.principal = principal;
      this.snapshot = snapshot;
      this.origin = origin;
      this.caller = { principal: { principalId: principal.principalId, districtId: principal.districtId }, channel: "http" };
      this.decider = { decide: (request) => engine.decide(request, { correlationId }) };
      this.authorizer = { authorize: async (request) => (await this.decider.decide(request)).decision };
    }

    get subject() {
      return this.caller.principal;
    }

    academics(): AcademicDirectory {
      return new AcademicDirectory({ store: stores.directory, authority, authorizer: this.authorizer, now });
    }

    workspaces(): WorkspaceDirectory {
      return new WorkspaceDirectory({ workspaces: stores.workspaces, directory: stores.directory, policy: this.decider, retention, now });
    }

    artifacts(): LearningArtifacts {
      return new LearningArtifacts({
        records: stores.artifactRecords,
        content: stores.artifactContent,
        workspaces: stores.workspaces,
        directory: stores.directory,
        policy: this.decider,
        approvedExternalHosts: options.approvedExternalHosts ?? [],
        now,
      });
    }

    assessment(): AssessmentService {
      return new AssessmentService({
        records: stores.assessment,
        artifacts: this.artifacts(),
        content: stores.artifactContent,
        directory: stores.directory,
        policy: this.decider,
        now,
      });
    }

    ci(): AssessmentCi {
      return new AssessmentCi({ assessment: this.assessment(), runs: assessmentRuns });
    }

    studio(): ContentStudio {
      return new ContentStudio({
        districtId,
        storage: stores.contentStudio,
        authorizer: this.authorizer,
        channel: "http",
        fetch: options.importFetch,
        // Uploads are not offered by this application yet, so no malware scanner is configured.
        scanner: undefined,
        alignments,
        ...(options.contentReviewer === undefined ? {} : { reviewer: options.contentReviewer }),
        now: () => now().toISOString(),
      });
    }

    curriculum(): CurriculumService {
      return new CurriculumService({
        districtId,
        directory: this.snapshot,
        authorizer: this.authorizer,
        channel: "http",
        releases: contentStudioReleases(stores.contentStudio),
        alignments,
        aiHelpPolicy: options.aiHelp ?? { layersFor: async () => ({ district: "full" }) },
        publisher: stores.codex,
        storage: stores.curriculum,
        now: () => now().toISOString(),
      });
    }

    projects(): ProjectArtifacts {
      if (projectsGit === undefined) throw new EducateOsError("unavailable", "Projects are not enabled in this district.");
      return new ProjectArtifacts({
        artifacts: this.artifacts(),
        git: projectsGit,
        workspaces: stores.workspaces,
        directory: stores.directory,
        policy: this.decider,
        now,
      });
    }

    // Guardians (ADR-0012, SCHO-188)
    guardianRelationships(): GuardianRelationships {
      return new GuardianRelationships({ store: stores.guardianRelationships, directory: stores.directory, policy: this.decider, now });
    }

    guardianInvitations(): GuardianInvitations {
      return guardianInvitationsFor(this.decider);
    }

    identityLinks(): IdentityLinkAdminService {
      return new IdentityLinkAdminService({ store: stores.identityLinks, directory: stores.directory, policy: this.decider, now });
    }

    /** The offering's full scope, from the directory. */
    offeringScope(offeringId: OfferingId): OfferingScope {
      const offering = this.snapshot.offerings.find((o) => o.id === offeringId);
      if (offering === undefined) throw new EducateOsError("not-found", `offering ${offeringId} was not found.`);
      return { level: "offering", districtId: offering.districtId, schoolId: offering.schoolId, offeringId: offering.id };
    }

    /** Requires the engine to allow `action` on a resource, answering `forbidden` otherwise. */
    async require(action: Action, resource: ResourceRef, message: string): Promise<void> {
      const term = resource.scope.level === "district" || resource.scope.level === "school"
        ? undefined
        : this.snapshot.terms.find((t) => t.id === this.snapshot.offerings.find((o) => o.id === (resource.scope as OfferingScope).offeringId)?.termId);
      const { decision } = await this.decider.decide({
        subject: this.subject,
        action,
        resource,
        context: { channel: "http", ...(term === undefined ? {} : { termState: term.state }) },
      });
      if (decision.effect !== "allow") throw new EducateOsError("forbidden", message);
    }

    /** Requires the engine to allow `action` on a district-level resource, answering `forbidden` otherwise. */
    async requireDistrict(action: Action, kind: ResourceRef["kind"]): Promise<void> {
      await this.require(action, { kind, scope: { level: "district", districtId }, classification: "district-internal" }, "Only a district administrator can do this.");
    }

    courseContent(): CourseContentService {
      return new CourseContentService({
        districtId,
        directory: this.snapshot,
        authorizer: this.authorizer,
        channel: "http",
        storage: stores.courseContent,
        installations: stores.curriculum,
        now: () => now().toISOString(),
      });
    }

    /** An offering's roster with each enrolled principal's display name. */
    async rosterWithNames(offeringId: OfferingId) {
      const roster = await this.academics().roster(this.caller, offeringId);
      return roster.map((enrollment) => ({
        enrollment,
        displayName: this.snapshot.principals.find((p) => p.id === enrollment.principalId)?.displayName ?? "",
      }));
    }

    rosterConfig(): oneroster.OneRosterImportConfig {
      return options.roster ?? { issuer: this.snapshot.district.trustedIssuers[0]!, subject: { field: "username" } };
    }

    // Gradebook (SCHO-187)
    gradebook(): GradebookService {
      return new GradebookService({ records: stores.assessment, gradebooks: stores.gradebooks, directory: stores.directory, policy: this.decider, now });
    }

    // Discussions (SCHO-190).
    discussions(): DiscussionService {
      return new DiscussionService({
        districtId,
        directory: this.snapshot,
        authorizer: this.authorizer,
        channel: "http",
        storage: stores.discussions,
        courseContent: stores.courseContent,
        assignmentsIn: async (offeringId) => (await stores.assessment.load()).state.assignments.filter((a) => a.offeringId === offeringId).map((a) => a.id),
        ...(options.discussionScreening === undefined ? {} : { screening: options.discussionScreening }),
        now: () => now().toISOString(),
      });
    }

    // Quizzes (SCHO-191)
    quizzes(): QuizService {
      return new QuizService({
        districtId,
        directory: this.snapshot,
        authorizer: this.authorizer,
        channel: "http",
        storage: stores.quizzes,
        courseContent: stores.courseContent,
        grading: quizGrading({
          records: stores.assessment,
          assessment: this.assessment(),
          artifacts: this.artifacts(),
          workspaces: this.workspaces(),
          correlationId: this.correlationId,
        }),
        now: () => now().toISOString(),
      });
    }

    /** The display names of principals, by ID, for those the directory knows. */
    namesOf(ids: Iterable<string>) {
      const wanted = new Set(ids);
      return this.snapshot.principals.filter((p) => wanted.has(p.id)).map((p) => ({ principalId: p.id, displayName: p.displayName }));
    }

    /** The display names of the principals who wrote `posts`, and of those who reported them (which only staff views carry). */
    discussionAuthors(posts: readonly ({ authorId: string; flags?: readonly ({ kind: string; by?: string })[] } | object)[]) {
      const ids = new Set(posts.flatMap((post) => ("authorId" in post
        ? [post.authorId, ...(post.flags ?? []).flatMap((flag) => (flag.kind === "report" && flag.by !== undefined ? [flag.by] : []))]
        : [])));
      return this.snapshot.principals.filter((p) => ids.has(p.id)).map((p) => ({ principalId: p.id, displayName: p.displayName }));
    }
  }

  const guardianInvitationsFor = (decider: PolicyDecider) => new GuardianInvitations({
    store: stores.guardianInvitations,
    relationships: new GuardianRelationships({ store: stores.guardianRelationships, directory: stores.directory, policy: decider, now }),
    relationshipStore: stores.guardianRelationships,
    identityLinks: stores.identityLinks,
    directory: stores.directory,
    now,
  });

  // Communication (SCHO-189): the service over a decider, and its assessment reads through the same one.
  const communicationFor = (decider: PolicyDecider, assessment: AssessmentService = systemAssessment(decider)) =>
    new CommunicationService({
      districtId,
      stores: stores.communication,
      directory: stores.directory,
      decider,
      assessment,
      ...(options.mail === undefined ? {} : { mail: options.mail }),
      ...(options.appUrl === undefined ? {} : { appUrl: options.appUrl }),
      now,
    });
  function systemAssessment(decider: PolicyDecider): AssessmentService {
    const artifacts = new LearningArtifacts({
      records: stores.artifactRecords,
      content: stores.artifactContent,
      workspaces: stores.workspaces,
      directory: stores.directory,
      policy: decider,
      approvedExternalHosts: options.approvedExternalHosts ?? [],
      now,
    });
    return new AssessmentService({ records: stores.assessment, artifacts, content: stores.artifactContent, directory: stores.directory, policy: decider, now });
  }
  // The weekly family digest goes out over the district's own guardian relationships (ADR-0012,
  // SCHO-188): the store the guardian routes and the policy engine read.
  const familyDigest = (communication: CommunicationService) =>
    new FamilyDigest({
      communication,
      stores: stores.communication,
      directory: stores.directory,
      guardians: stores.guardianRelationships,
      ...(options.mail === undefined ? {} : { mail: options.mail }),
      ...(options.appUrl === undefined ? {} : { appUrl: options.appUrl }),
      now,
    });
  const jobDecider: PolicyDecider = { decide: (request, decideOptions) => engine.decide(request, decideOptions) };
  /** The calendar feed: the one route a token alone authorizes, so it is served before sign-in. */
  async function serveCalendarFeed(request: Request, correlationId: string): Promise<Response | undefined> {
    const match = /^\/api\/calendar\/([^/]+)\.ics$/.exec(new URL(request.url).pathname);
    if (match === null || request.method !== "GET") return undefined;
    const decider: PolicyDecider = { decide: (decision) => engine.decide(decision, { correlationId }) };
    // A token is base64url, so it needs no decoding; anything else is simply not a token.
    const ics = await communicationFor(decider).feedIcs(match[1]!);
    if (ics === undefined) throw new EducateOsError("not-found", "No such calendar.");
    return new Response(ics, {
      status: 200,
      headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", [CORRELATION_HEADER]: correlationId },
    });
  }

  type Handlers = { [N in Exclude<RouteName, GuardianRouteName | "onboarding.redeemGuardianInvitation">]: (ctx: RequestContext, input: ParsedRouteInput<N>) => Promise<RouteResponse<N>> };

  const handlers: Handlers = {
    "me.get": async (ctx) => {
      const me = ctx.snapshot.principals.find((p) => p.id === ctx.principal.principalId)!;
      const facts = subjectFactsFrom(ctx.snapshot, me.id);
      const seen = new Set<string>();
      const roles = (facts?.roles ?? []).map(({ role, scope }) => ({ role, scope })).filter((r) => {
        const key = JSON.stringify(r);
        return seen.has(key) ? false : (seen.add(key), true);
      });
      return {
        principalId: me.id,
        districtId: me.districtId,
        kind: me.kind,
        displayName: me.displayName,
        roles,
        enrollments: ctx.snapshot.enrollments
          .filter((e) => e.principalId === me.id && e.status === "active")
          .map(({ offeringId, role }) => ({ offeringId, role })),
      };
    },

    // Student
    "student.listWorkspaces": (ctx) => ctx.workspaces().listMyWorkspaces(ctx.caller),
    "student.openPersonalWorkspace": (ctx) => ctx.workspaces().ensurePersonalWorkspace(ctx.caller),
    "student.openCourseWorkspace": (ctx, { params }) => ctx.workspaces().ensureCourseWorkspace(ctx.caller, params.offeringId),
    "student.listActivities": async (ctx, { params }) => {
      const curriculum = ctx.curriculum();
      const assigned = [];
      for (const assignment of await ctx.assessment().listAssignments(ctx.caller, params.offeringId)) {
        const activity = await curriculum.getActivity(ctx.subject, assignment.activityId).catch((error: unknown) => {
          if (error instanceof EducateOsError && error.code === "not-found") return undefined;
          throw error;
        });
        if (activity !== undefined) assigned.push({ assignment, activity });
      }
      return assigned;
    },
    "student.getActivity": (ctx, { params }) => ctx.curriculum().getActivity(ctx.subject, params.activityId),
    "student.getAssignment": (ctx, { params }) => assignmentView(ctx.assessment(), ctx.caller, params.assignmentId),
    "student.readStarterMaterial": async (ctx, { params }) => {
      const { material: { content: _stored, ...material }, content } = await ctx.assessment().readStarterMaterial(ctx.caller, params.assignmentId, params.materialId);
      return { material, content: contentBody(content) };
    },
    "student.listArtifacts": (ctx, { params }) => ctx.artifacts().listArtifacts(ctx.caller, params.workspaceId),
    "student.createArtifact": (ctx, { body }) => ctx.artifacts().createArtifact(ctx.caller, body),
    "student.saveRevision": (ctx, { params, body }) => ctx.artifacts().saveRevision(ctx.caller, params.artifactId, body),
    "student.getArtifact": async (ctx, { params, query }) => {
      const artifacts = ctx.artifacts();
      const { artifact } = await artifacts.getArtifact(ctx.caller, params.artifactId);
      const { revision, content } = await artifacts.readRevision(ctx.caller, params.artifactId, query.revisionId);
      return { artifact, revision, content: contentBody(content) };
    },
    "student.artifactHistory": (ctx, { params }) => ctx.artifacts().history(ctx.caller, params.artifactId),
    "student.keepArtifact": (ctx, { params }) =>
      keepArtifact(ctx.artifacts(), ctx.workspaces(), ctx.caller, params.workspaceId, params.artifactId),
    "student.createProject": (ctx, { body }) => ctx.projects().createProject(ctx.caller, body),
    "student.saveProject": (ctx, { params, body }) => ctx.projects().checkpoint(ctx.caller, params.artifactId, body),
    "student.projectHistory": (ctx, { params }) => ctx.projects().history(ctx.caller, params.artifactId),
    "student.submit": (ctx, { params, body }) => ctx.assessment().submit(ctx.caller, params.assignmentId, body.revisions),
    "student.listSubmissions": (ctx, { params }) => ctx.assessment().listSubmissions(ctx.caller, params.assignmentId),
    "student.getFeedback": (ctx, { params }) => ctx.assessment().getFeedback(ctx.caller, params.submissionId),
    "student.withdrawSubmission": (ctx, { params }) => ctx.assessment().withdraw(ctx.caller, params.submissionId),
    "student.officialGrades": (ctx, { params }) =>
      ctx.assessment().officialGrades(ctx.caller, params.assignmentId, ctx.principal.principalId),

    // Teacher
    "teacher.listOfferings": async (ctx) => {
      const teaching = new Map<string, "teacher" | "co-teacher">();
      for (const { role, scope } of subjectFactsFrom(ctx.snapshot, ctx.principal.principalId)?.roles ?? []) {
        if (scope.level !== "offering" || (role !== "teacher" && role !== "co-teacher")) continue;
        if (teaching.get(scope.offeringId) !== "teacher") teaching.set(scope.offeringId, role);
      }
      const offerings = await ctx.academics().listOfferings(ctx.caller);
      return offerings.flatMap((offering) => {
        const role = teaching.get(offering.id);
        const course = ctx.snapshot.courses.find((c) => c.id === offering.courseId);
        return role === undefined || course === undefined ? [] : [{ offering, course, role }];
      });
    },
    "teacher.roster": (ctx, { params }) => ctx.rosterWithNames(params.offeringId),
    "teacher.listWorkspaces": (ctx, { params }) => ctx.workspaces().listOfferingWorkspaces(ctx.caller, params.offeringId),
    "teacher.listWorkspaceArtifacts": (ctx, { params }) => ctx.artifacts().listArtifacts(ctx.caller, params.workspaceId),
    "teacher.importResource": (ctx, { params, body }) =>
      ctx.studio().submitUrl(ctx.subject, { url: body.url, targetScope: ctx.offeringScope(params.offeringId) }),
    "teacher.reviewQueue": (ctx, { params }) => ctx.studio().listQueue(ctx.subject, ctx.offeringScope(params.offeringId)),
    "teacher.listReleases": (ctx, { params }) => ctx.studio().listReleases(ctx.subject, ctx.offeringScope(params.offeringId)),
    "teacher.resourceReport": (ctx, { params }) => ctx.studio().getReport(ctx.subject, params.itemId),
    "teacher.approveResource": (ctx, { params, body }) => ctx.studio().approve(ctx.subject, params.itemId, body),
    "teacher.createActivity": (ctx, { params, body }) =>
      ctx.curriculum().createDraft(ctx.subject, { scope: ctx.offeringScope(params.offeringId), activity: body.activity }),
    "teacher.publishActivity": (ctx, { params }) => ctx.curriculum().publish(ctx.subject, params.definitionId),
    "teacher.installActivity": (ctx, { params, body }) =>
      installAndAssign({
        curriculum: ctx.curriculum(),
        assessment: ctx.assessment(),
        caller: ctx.caller,
        snapshot: ctx.snapshot,
        definitionId: params.definitionId,
        version: body.version,
        offering: ctx.offeringScope(body.offeringId),
        settings: body.assignment,
      }),
    "teacher.listAssignments": (ctx, { params }) => ctx.assessment().listAssignments(ctx.caller, params.offeringId),
    "teacher.getAssignment": (ctx, { params }) => assignmentView(ctx.assessment(), ctx.caller, params.assignmentId),
    "teacher.updateAssignment": (ctx, { params, body: { dueAt, ...settings } }) =>
      ctx.assessment().updateAssignment(ctx.caller, params.assignmentId, { ...settings, ...(dueAt === undefined ? {} : { dueAt: new Date(dueAt).toISOString() }) }),
    "teacher.publishStarterMaterial": (ctx, { params, body }) =>
      publishStarterMaterial({
        artifacts: ctx.artifacts(),
        workspaces: ctx.workspaces(),
        assessment: ctx.assessment(),
        caller: ctx.caller,
        assignmentId: params.assignmentId,
        ...body,
      }),
    "teacher.getActivity": (ctx, { params }) => ctx.curriculum().getActivity(ctx.subject, params.activityId),
    "teacher.listSubmissions": (ctx, { params }) => ctx.assessment().listSubmissions(ctx.caller, params.assignmentId),
    "teacher.submittedContent": async (ctx, { params }) => {
      const { item, content } = await ctx.assessment().readSubmittedContent(ctx.caller, params.submissionId, params.artifactId);
      return { item, content: contentBody(content) };
    },
    "teacher.getFeedback": (ctx, { params }) => ctx.assessment().getFeedback(ctx.caller, params.submissionId),
    "teacher.addComment": (ctx, { params, body }) => ctx.assessment().addComment(ctx.caller, params.submissionId, body),
    "teacher.scoreCriterion": (ctx, { params, body }) => ctx.assessment().scoreCriterion(ctx.caller, params.submissionId, body),
    "teacher.releaseFeedback": (ctx, { params, body }) => ctx.assessment().advanceFeedback(ctx.caller, params.submissionId, body.state),
    "teacher.signRubric": async (ctx, { params, body }) => {
      // A rubric's checks can hold answer keys, so the release is teacher-only course material.
      await ctx.require("create", { kind: "rubric", scope: ctx.offeringScope(params.offeringId), classification: "teacher-only" }, "Only the class's teachers can sign its rubrics.");
      const release = await signRubricRelease(body.rubric, ctx.caller, evaluators, now());
      await stores.rubrics.put(release);
      return release;
    },
    "teacher.runCi": (ctx, { params, body }) => runCiAndSuggest(ctx.ci(), ctx.caller, params.submissionId, body.idempotencyKey),
    "teacher.recordGrade": (ctx, { params, body }) =>
      ctx.assessment().recordOfficialGrade(ctx.caller, { submissionId: params.submissionId, score: body.score }),
    "teacher.pendingGrades": (ctx, { params }) => ctx.assessment().pendingGradeProposals(ctx.caller, params.assignmentId),
    "teacher.approveGrade": (ctx, { params }) => ctx.assessment().approveGradeProposal(ctx.caller, params.proposalId),
    "teacher.declineGradeProposal": (ctx, { params, body }) => ctx.assessment().declineGradeProposal(ctx.caller, params.proposalId, body.reason),

    // Admin
    "admin.health": async (ctx) => {
      await ctx.requireDistrict("read", "district");
      const { snapshot } = ctx;
      const workspaces = (await stores.workspaces.load()).state;
      const artifacts = (await stores.artifactRecords.load()).state;
      const assessment = (await stores.assessment.load()).state;
      const items = await stores.contentStudio.listItems();
      const revisions = await stores.config.list();
      const head = revisions.at(-1);
      return {
        districtId,
        directory: {
          schools: snapshot.schools.length,
          terms: snapshot.terms.length,
          offerings: snapshot.offerings.length,
          students: snapshot.principals.filter((p) => p.kind === "student").length,
          staff: snapshot.principals.filter((p) => p.kind === "staff").length,
          activeEnrollments: snapshot.enrollments.filter((e) => e.status === "active").length,
        },
        work: {
          workspaces: workspaces.workspaces.length,
          artifacts: artifacts.artifacts.filter((a) => a.deletedAt === undefined).length,
          submissions: assessment.submissions.length,
          installedActivities: assessment.assignments.length,
        },
        content: {
          awaitingReview: items.filter((item) => item.state === "reviewed").length,
          releases: (await stores.contentStudio.listReleases()).length,
        },
        config: { ...(head === undefined ? {} : { headRevisionId: head.id }), revisions: revisions.length },
        aiRequests: (await ledger.usageEvents()).length,
      };
    },
    "admin.listOfferings": async (ctx) => {
      await ctx.requireDistrict("list", "offering");
      const offerings = await ctx.academics().listOfferings(ctx.caller);
      return offerings.flatMap((offering) => {
        const course = ctx.snapshot.courses.find((c) => c.id === offering.courseId);
        if (course === undefined) return [];
        const active = ctx.snapshot.enrollments.filter((e) => e.offeringId === offering.id && e.status === "active");
        const teachers = active
          .filter((e) => e.role !== "student")
          .map((e) => ctx.snapshot.principals.find((p) => p.id === e.principalId)?.displayName ?? "");
        return [{ offering, course, teachers, students: active.filter((e) => e.role === "student").length }];
      });
    },
    "admin.previewRoster": async (ctx, { body }) => {
      await ctx.requireDistrict("update", "enrollment");
      const { snapshot } = await stores.directory.load();
      return oneroster.previewOneRosterImport({
        current: { snapshot, sources: await stores.rosterSources.load() },
        files: body.files,
        config: ctx.rosterConfig(),
        now: now(),
      });
    },
    "admin.applyRoster": async (ctx, { body }) => {
      await ctx.requireDistrict("update", "enrollment");
      return applyRosterImport({
        directory: stores.directory,
        sources: stores.rosterSources,
        authority,
        workspaces: ctx.workspaces(),
        caller: ctx.caller,
        files: body.files,
        config: ctx.rosterConfig(),
        now: now(),
      });
    },
    "admin.getConfig": async (ctx) => {
      await ctx.requireDistrict("read", "capability-config");
      const revisions = await stores.config.list();
      const head = revisions.at(-1);
      return {
        ...(head === undefined ? {} : { head }),
        revisions: revisions.length,
        districtPolicy: await policySource.effectivePolicy({ level: "district", districtId }),
      };
    },
    "admin.planConfig": async (ctx, { body }) => {
      await ctx.requireDistrict("read", "capability-config");
      const head = (await stores.config.list()).at(-1);
      const draft = await createDraftRevision({
        document: body.document,
        registry,
        actorPrincipalId: ctx.principal.principalId,
        ...(head === undefined ? {} : { previous: head }),
      });
      if (!draft.ok) return { ok: false, problems: draft.problems };
      const plan = planConfigurationChange({ ...(head === undefined ? {} : { current: head }), next: draft.revision, directory: ctx.snapshot, registry });
      return { ok: true, revision: draft.revision, plan };
    },
    "admin.applyConfig": async (ctx, { body }) => {
      await ctx.requireDistrict("configure", "capability-config");
      const head = (await stores.config.list()).at(-1);
      if (body.expectedHeadRevisionId !== undefined && body.expectedHeadRevisionId !== head?.id) {
        throw new EducateOsError("conflict", "The configuration changed since this plan was made; plan it again.");
      }
      const draft = await createDraftRevision({
        document: body.document,
        registry,
        actorPrincipalId: ctx.principal.principalId,
        ...(head === undefined ? {} : { previous: head }),
      });
      if (!draft.ok) throw new EducateOsError("validation-failed", "The configuration does not compile; plan it to see why.");
      if (draft.revision.id === head?.id) return head;
      const plan = planConfigurationChange({ ...(head === undefined ? {} : { current: head }), next: draft.revision, directory: ctx.snapshot, registry });
      if (plan.problems.length > 0 || plan.policyViolations.length > 0) {
        throw new EducateOsError("conflict", "The plan has problems that block applying it; plan it to see them.");
      }
      if (plan.approvals.length > 0 && !body.acknowledgeApprovals) {
        throw new EducateOsError("conflict", "The plan requires approvals; review them and apply again acknowledging them.");
      }
      const applied = { ...draft.revision, status: "applied" as const };
      await stores.config.append(applied, head?.id);
      return applied;
    },
    "admin.aiUsage": async (ctx) => {
      await ctx.requireDistrict("read", "ai-budget");
      return ledger.report();
    },
    "admin.aiFunding": async (ctx) => {
      await ctx.requireDistrict("read", "ai-budget");
      return fundingBody();
    },
    "admin.aiCostSummary": async (ctx) => {
      await ctx.requireDistrict("read", "ai-budget");
      return ledger.costSummary(options.cloudflareAccount);
    },
    "admin.aiProjection": async (ctx) => {
      await ctx.requireDistrict("read", "ai-budget");
      return ledger.projection();
    },
    "admin.updateFundingPools": async (ctx, { body }) => {
      await ctx.requireDistrict("configure", "ai-budget");
      const { changed, warnings } = await changeAllocations({
        store: stores.fundingAllocations,
        configured: options.fundingPools ?? [],
        requests: body.allocations,
        expectedRevisionId: body.expectedRevisionId,
        actorPrincipalId: ctx.principal.principalId,
        districtCapUsdNano: options.aiMonthlyDistrictCapUsdNano,
        before: (await fundingBody()).report,
        now: now(),
      });
      return { ...(await fundingBody()), changed, warnings };
    },
    "admin.termRollover": (ctx, { params }) => ctx.workspaces().previewTermRollover(ctx.caller, params.termId),
    "admin.closeTerm": (ctx, { params }) => ctx.workspaces().closeTerm(ctx.caller, params.termId),

    // Course authoring (SCHO-186). Kept in one block, apart from the handlers above.
    "student.listModules": (ctx, { params }) => ctx.courseContent().outline(ctx.subject, params.offeringId),
    "teacher.listModules": (ctx, { params }) => ctx.courseContent().outline(ctx.subject, params.offeringId),
    "teacher.createModule": (ctx, { params, body }) => ctx.courseContent().createModule(ctx.subject, params.offeringId, body),
    "teacher.updateModule": (ctx, { params, body }) => ctx.courseContent().updateModule(ctx.subject, params.offeringId, params.moduleId, body),
    "teacher.deleteModule": async (ctx, { params }) => {
      await ctx.courseContent().deleteModule(ctx.subject, params.offeringId, params.moduleId);
      return { deleted: true as const };
    },
    "teacher.reorderModules": (ctx, { params, body }) => ctx.courseContent().reorderModules(ctx.subject, params.offeringId, body),
    "teacher.addPage": (ctx, { params, body }) => ctx.courseContent().addPage(ctx.subject, params.offeringId, params.moduleId, body),
    "teacher.updatePage": (ctx, { params, body }) => ctx.courseContent().updatePage(ctx.subject, params.offeringId, params.pageId, body),
    "teacher.placeActivity": (ctx, { params, body }) => ctx.courseContent().placeActivity(ctx.subject, params.offeringId, params.moduleId, body),
    "teacher.removeModuleItem": async (ctx, { params }) => {
      await ctx.courseContent().removeItem(ctx.subject, params.offeringId, params.moduleId, params.itemId);
      return { removed: true as const };
    },
    "teacher.reorderModuleItems": (ctx, { params, body }) => ctx.courseContent().reorderItems(ctx.subject, params.offeringId, params.moduleId, body),
    "teacher.previewCartridge": (ctx, { params, body }) => previewCourseCartridge(ctx.courseContent(), ctx.subject, params.offeringId, body.base64),
    "teacher.importCartridge": (ctx, { params, body }) => importCourseCartridge(ctx.courseContent(), ctx.subject, { offeringId: params.offeringId, ...body }, ctx.discussions(), ctx.quizzes()),
    "teacher.exportCartridge": async (ctx, { params }) => {
      const { view, outline } = await ctx.courseContent().outline(ctx.subject, params.offeringId);
      if (view !== "teacher") throw new EducateOsError("forbidden", "Only the class's teachers can export its content.");
      const offering = ctx.snapshot.offerings.find((o) => o.id === params.offeringId)!;
      const course = ctx.snapshot.courses.find((c) => c.id === offering.courseId);
      const { topics } = await ctx.discussions().listTopics(ctx.subject, params.offeringId);
      const quizzes = await ctx.quizzes().listQuizzes(ctx.subject, params.offeringId);
      return exportCourseCartridge(outline, course?.title ?? "Course", offering.sectionName, topics.map((t) => t.topic), quizzes.view === "staff" ? quizzes.quizzes.map((q) => q.quiz) : []);
    },
    "admin.authoring": async (ctx) => {
      await ctx.requireDistrict("list", "principal");
      const academics = ctx.academics();
      const [schools, terms, courses, offerings] = await Promise.all([
        academics.listSchools(ctx.caller),
        academics.listTerms(ctx.caller),
        academics.listCourses(ctx.caller),
        academics.listOfferings(ctx.caller),
      ]);
      const principals = ctx.snapshot.principals
        .filter((p) => p.kind === "student" || p.kind === "staff")
        .map((p) => authoringPrincipal(ctx.snapshot, p, now()));
      return { authority, trustedIssuers: ctx.snapshot.district.trustedIssuers, schools, terms, courses, offerings, principals };
    },
    "admin.createSchool": (ctx, { body }) => ctx.academics().createSchool(ctx.caller, body),
    "admin.createTerm": (ctx, { body }) => ctx.academics().createTerm(ctx.caller, body),
    "admin.updateTerm": (ctx, { params, body }) => ctx.academics().updateTerm(ctx.caller, params.termId, body),
    "admin.transitionTerm": (ctx, { params, body }) => ctx.academics().transitionTerm(ctx.caller, params.termId, body.to),
    "admin.createCourse": (ctx, { body }) => ctx.academics().createCourse(ctx.caller, body),
    "admin.updateCourse": (ctx, { params, body }) => ctx.academics().updateCourse(ctx.caller, params.courseId, body),
    "admin.archiveCourse": (ctx, { params, body }) => ctx.academics().setCourseArchived(ctx.caller, params.courseId, body.archived),
    "admin.createOffering": (ctx, { body }) => ctx.academics().createOffering(ctx.caller, body),
    "admin.updateOffering": (ctx, { params, body }) => ctx.academics().updateOffering(ctx.caller, params.offeringId, body),
    "admin.archiveOffering": (ctx, { params, body }) => ctx.academics().setOfferingArchived(ctx.caller, params.offeringId, body.archived),
    "admin.offeringRoster": (ctx, { params }) => ctx.rosterWithNames(params.offeringId),
    "admin.enroll": (ctx, { params, body }) => ctx.academics().createEnrollment(ctx.caller, { ...body, offeringId: params.offeringId }),
    "admin.unenroll": async (ctx, { params }) => {
      const enrollment = await ctx.academics().deactivateEnrollment(ctx.caller, params.enrollmentId);
      // A dropped student keeps their course workspace and work, but not live access to it.
      const { revoked } = await ctx.workspaces().reconcileCourseGrants(ctx.caller);
      return { enrollment, grantsRevoked: revoked };
    },
    "admin.createPrincipal": async (ctx, { body }) => {
      const principal = await ctx.academics().createPrincipal(ctx.caller, body);
      return authoringPrincipal(ctx.snapshot, principal, now());
    },
    // Managing people (SCHO-212). Each answers from the directory as it is after the change.
    "admin.updatePrincipal": async (ctx, { params, body }) => {
      const principal = await ctx.academics().updatePrincipal(ctx.caller, params.principalId, body);
      return authoringPrincipal((await stores.directory.load()).snapshot, principal, now());
    },
    "admin.setPrincipalStatus": async (ctx, { params, body }) => {
      const services = { academics: ctx.academics(), workspaces: ctx.workspaces() };
      // Leaving ends their class access; returning restores the course grants their kept enrollments carry.
      let principal: Principal, grantsRevoked: number;
      if (body.status === "active") {
        principal = await services.academics.reactivatePrincipal(ctx.caller, params.principalId);
        grantsRevoked = (await services.workspaces.reconcileCourseGrants(ctx.caller)).revoked;
      } else {
        ({ principal, grantsRevoked } = await transitionPrincipal(services, ctx.caller, params.principalId, body.status));
      }
      return { principal: authoringPrincipal((await stores.directory.load()).snapshot, principal, now()), grantsRevoked };
    },
    "admin.grantDistrictAdmin": async (ctx, { params }) => {
      await ctx.academics().grantDistrictAdmin(ctx.caller, params.principalId);
      return authoringPrincipalById((await stores.directory.load()).snapshot, params.principalId, now());
    },
    "admin.revokeDistrictAdmin": async (ctx, { params }) => {
      await ctx.academics().revokeDistrictAdmin(ctx.caller, params.principalId);
      return authoringPrincipalById((await stores.directory.load()).snapshot, params.principalId, now());
    },

    // Gradebook (SCHO-187). Kept in one block, apart from the handlers above.
    "teacher.gradebook": (ctx, { params }) => ctx.gradebook().grid(ctx.caller, params.offeringId),
    "teacher.updateGradebookSettings": (ctx, { params, body }) => ctx.gradebook().updateSettings(ctx.caller, params.offeringId, body),
    "teacher.setGradeMarker": (ctx, { params, body }) => ctx.gradebook().setMarker(ctx.caller, params.offeringId, body),
    "teacher.exportGradebookCsv": (ctx, { params }) => ctx.gradebook().exportCsv(ctx.caller, params.offeringId),
    "student.gradeSummary": (ctx, { params }) => ctx.gradebook().studentSummary(ctx.caller, params.offeringId),

    // Communication (SCHO-189). Kept in one block, apart from the handlers above.
    "student.announcements": async (ctx) => (await communicationFor(ctx.decider, ctx.assessment()).studentAnnouncements(ctx.caller)),
    "student.courseAnnouncements": async (ctx, { params }) =>
      (await communicationFor(ctx.decider, ctx.assessment()).listAnnouncements(ctx.caller, params.offeringId)).announcements,
    "teacher.listAnnouncements": async (ctx, { params }) =>
      (await communicationFor(ctx.decider, ctx.assessment()).listAnnouncements(ctx.caller, params.offeringId)).announcements,
    "teacher.createAnnouncement": (ctx, { params, body }) => communicationFor(ctx.decider, ctx.assessment()).createAnnouncement(ctx.caller, params.offeringId, body),
    "teacher.updateAnnouncement": (ctx, { params, body }) => communicationFor(ctx.decider, ctx.assessment()).updateAnnouncement(ctx.caller, params.announcementId, body),
    "teacher.deleteAnnouncement": (ctx, { params }) => communicationFor(ctx.decider, ctx.assessment()).deleteAnnouncement(ctx.caller, params.announcementId),
    "teacher.weeklyNote": async (ctx, { params, query }) => {
      const week = query.week ?? digestWeekOf(now());
      return { week, note: await communicationFor(ctx.decider, ctx.assessment()).weeklyNote(ctx.caller, params.offeringId, week) };
    },
    "teacher.setWeeklyNote": async (ctx, { params, body }) => {
      const week = body.week ?? digestWeekOf(now());
      return { week, note: await communicationFor(ctx.decider, ctx.assessment()).setWeeklyNote(ctx.caller, params.offeringId, week, body.text) };
    },
    "me.calendar": async (ctx, { query }) => {
      const at = now().getTime();
      const from = new Date(query.from ?? at - 7 * 86_400_000);
      const to = new Date(query.to ?? at + 56 * 86_400_000);
      const events = await communicationFor(ctx.decider, ctx.assessment()).calendar(ctx.caller, from, to);
      return { from: from.toISOString(), to: to.toISOString(), events };
    },
    "me.calendarFeed": (ctx) => communicationFor(ctx.decider).feedStatus(ctx.caller),
    "me.rotateCalendarFeed": async (ctx) => {
      const { token, createdAt } = await communicationFor(ctx.decider).rotateFeed(ctx.caller);
      return { token, path: calendarFeedPath(token), createdAt };
    },
    "me.revokeCalendarFeed": (ctx) => communicationFor(ctx.decider).revokeFeed(ctx.caller),
    "me.notifications": (ctx) => communicationFor(ctx.decider, ctx.assessment()).listNotifications(ctx.caller),
    "me.markNotificationsRead": (ctx, { body }) => communicationFor(ctx.decider).markRead(ctx.caller, body),
    "me.preferences": (ctx) => communicationFor(ctx.decider).preferences(ctx.caller),
    "me.updatePreferences": (ctx, { body }) => communicationFor(ctx.decider).setPreferences(ctx.caller, body.email),
    "admin.previewDigest": async (ctx, { params }) => {
      // The preview shows what a guardian would be told about a child, so it is the decision of the
      // one who decides guardian relationships: a district administrator.
      await ctx.require("read", { kind: "guardian-relationship", scope: { level: "district", districtId }, classification: "restricted" }, "Only a district administrator can preview a family digest.");
      const digest = await familyDigest(communicationFor(ctx.decider, ctx.assessment())).build(params.guardianPrincipalId);
      if (digest === undefined) throw new EducateOsError("not-found", `guardian ${params.guardianPrincipalId} was not found.`);
      return { digest, ...renderDigest(digest, options.appUrl), empty: isEmpty(digest) };
    },

    // Discussions (SCHO-190). Kept in one block, apart from the handlers above.
    "student.listDiscussions": (ctx, { params }) => ctx.discussions().listTopics(ctx.subject, params.offeringId),
    "student.discussionThread": async (ctx, { params }) => {
      const thread = await ctx.discussions().thread(ctx.subject, params.offeringId, params.topicId);
      // The student surface answers students only, who always get the student view.
      if (thread.view !== "student") throw new EducateOsError("not-found", "no such discussion");
      return { topic: thread.topic, posts: thread.posts, authors: ctx.discussionAuthors(thread.posts) };
    },
    "student.createPost": async (ctx, { params, body }) =>
      studentPostView(await ctx.discussions().createPost(ctx.subject, params.offeringId, params.topicId, body), ctx.subject.principalId),
    "student.editPost": async (ctx, { params, body }) =>
      studentPostView(await ctx.discussions().editPost(ctx.subject, params.offeringId, params.postId, body), ctx.subject.principalId),
    "student.deletePost": async (ctx, { params }) => {
      await ctx.discussions().deletePost(ctx.subject, params.offeringId, params.postId);
      return { deleted: true as const };
    },
    "student.reportPost": async (ctx, { params, body }) => {
      await ctx.discussions().report(ctx.subject, params.offeringId, params.postId, body);
      return { reported: true as const };
    },
    "teacher.listDiscussions": (ctx, { params }) => ctx.discussions().listTopics(ctx.subject, params.offeringId),
    "teacher.discussionThread": async (ctx, { params }) => {
      const thread = await ctx.discussions().thread(ctx.subject, params.offeringId, params.topicId);
      if (thread.view !== "staff") throw new EducateOsError("not-found", "no such discussion");
      return { topic: thread.topic, posts: thread.posts, authors: ctx.discussionAuthors(thread.posts) };
    },
    "teacher.createTopic": (ctx, { params, body }) => ctx.discussions().createTopic(ctx.subject, params.offeringId, body),
    "teacher.updateTopic": (ctx, { params, body }) => ctx.discussions().updateTopic(ctx.subject, params.offeringId, params.topicId, body),
    "teacher.deleteTopic": async (ctx, { params }) => {
      await ctx.discussions().deleteTopic(ctx.subject, params.offeringId, params.topicId);
      return { deleted: true as const };
    },
    "teacher.createPost": (ctx, { params, body }) => ctx.discussions().createPost(ctx.subject, params.offeringId, params.topicId, body),
    "teacher.editPost": (ctx, { params, body }) => ctx.discussions().editPost(ctx.subject, params.offeringId, params.postId, body),
    "teacher.deletePost": async (ctx, { params }) => {
      await ctx.discussions().deletePost(ctx.subject, params.offeringId, params.postId);
      return { deleted: true as const };
    },
    "teacher.moderatePost": (ctx, { params, body }) => ctx.discussions().moderate(ctx.subject, params.offeringId, params.postId, body),
    "teacher.moderationQueue": async (ctx, { params }) => {
      const queue = await ctx.discussions().moderationQueue(ctx.subject, params.offeringId);
      return { ...queue, authors: ctx.discussionAuthors([...queue.pending, ...queue.flagged]) };
    },
    "teacher.discussionSettings": (ctx, { params, body }) => ctx.discussions().updateSettings(ctx.subject, params.offeringId, body),
    "teacher.discussionParticipation": async (ctx, { params }) => {
      // Reading the assignment is the teacher's check that it is theirs, and names its offering.
      const { assignment } = await ctx.assessment().getAssignment(ctx.caller, params.assignmentId);
      return ctx.discussions().participation(ctx.subject, assignment.offeringId, assignment.id, params.principalId);
    },

    // Quizzes (SCHO-191). Kept in one block, apart from the handlers above.
    "student.listQuizzes": async (ctx, { params }) => {
      const listing = await ctx.quizzes().listQuizzes(ctx.subject, params.offeringId);
      // The student surface answers students only, who always get the student view.
      if (listing.view !== "student") throw new EducateOsError("not-found", "no such quiz");
      return listing.quizzes;
    },
    "student.getQuiz": (ctx, { params }) => ctx.quizzes().studentQuiz(ctx.subject, params.offeringId, params.quizId),
    "student.startQuizAttempt": (ctx, { params }) => ctx.quizzes().startAttempt(ctx.subject, params.offeringId, params.quizId),
    "student.quizAttempt": (ctx, { params }) => ctx.quizzes().attempt(ctx.subject, params.offeringId, params.attemptId),
    "student.saveQuizAnswers": (ctx, { params, body }) => ctx.quizzes().saveAnswers(ctx.subject, params.offeringId, params.attemptId, body),
    "student.submitQuizAttempt": (ctx, { params, body }) => ctx.quizzes().submitAttempt(ctx.subject, params.offeringId, params.attemptId, body),
    "student.quizAttemptResult": (ctx, { params }) => ctx.quizzes().attemptResult(ctx.subject, params.offeringId, params.attemptId),
    "teacher.listQuizzes": async (ctx, { params }) => {
      const listing = await ctx.quizzes().listQuizzes(ctx.subject, params.offeringId);
      if (listing.view !== "staff") throw new EducateOsError("not-found", "no such quiz");
      return { canManage: listing.canManage, quizzes: listing.quizzes };
    },
    "teacher.getQuiz": (ctx, { params }) => ctx.quizzes().getQuiz(ctx.subject, params.offeringId, params.quizId),
    "teacher.createQuiz": (ctx, { params, body }) => ctx.quizzes().createQuiz(ctx.subject, params.offeringId, body),
    "teacher.updateQuiz": (ctx, { params, body }) => ctx.quizzes().updateQuiz(ctx.subject, params.offeringId, params.quizId, body),
    "teacher.publishQuiz": (ctx, { params, body }) => ctx.quizzes().setPublished(ctx.subject, params.offeringId, params.quizId, body),
    "teacher.deleteQuiz": async (ctx, { params }) => {
      await ctx.quizzes().deleteQuiz(ctx.subject, params.offeringId, params.quizId);
      return { deleted: true as const };
    },
    "teacher.quizResults": async (ctx, { params }) => {
      const results = await ctx.quizzes().results(ctx.subject, params.offeringId, params.quizId);
      return { ...results, names: ctx.namesOf(results.students.map((row) => row.studentId)) };
    },
    "teacher.releaseQuizScores": (ctx, { params }) => ctx.quizzes().release(ctx.subject, params.offeringId, params.quizId),
    "teacher.quizAttempt": async (ctx, { params }) => {
      const view = await ctx.quizzes().staffAttempt(ctx.subject, params.offeringId, params.attemptId);
      return { ...view, studentName: ctx.namesOf([view.attempt.studentId])[0]?.displayName ?? "" };
    },
    "teacher.gradeQuizItem": async (ctx, { params, body }) => {
      const view = await ctx.quizzes().gradeItem(ctx.subject, params.offeringId, params.attemptId, params.itemId, body);
      return { ...view, studentName: ctx.namesOf([view.attempt.studentId])[0]?.displayName ?? "" };
    },
  };

  // Guardians (ADR-0012, SCHO-188)
  const guardianRoutes = guardianHandlers<RequestContext>({ stores, invitationPage: options.guardianInvitationPage, now });

  async function handle(request: Request, correlationId: string): Promise<Response> {
    const url = new URL(request.url);
    const matched = matchRoute(request.method, url.pathname);
    if (matched === undefined) throw new EducateOsError("not-found", "No such route.");

    const identity = await options.verifyRequest(request);
    if (identity === undefined) throw new EducateOsError("unauthenticated", "Sign in with this district's identity provider.");
    const { spec } = matched;
    const parseInput = async () => ({
      params: spec.params === undefined ? undefined : parsePart("path", spec.params, matched.params),
      query: spec.query === undefined ? undefined : parsePart("query", spec.query, Object.fromEntries(url.searchParams)),
      body: spec.body === undefined ? undefined : parsePart("body", spec.body, await readJsonBody(request)),
    });
    // Onboarding answers a verified sign-in that is nobody's principal yet. Its one route only
    // starts a request an administrator decides, so it needs no principal and grants nothing.
    if (spec.surface === "onboarding") {
      const { body } = await parseInput() as { body: { token: string } };
      return jsonResponse(await guardianInvitationsFor(engine).redeem(identity, body.token), spec.status ?? 200, correlationId);
    }

    const { snapshot } = await stores.directory.load();
    const principal = await resolverFor(snapshot).resolve(identity);
    if (!SURFACE_KINDS[spec.surface].includes(principal.kind)) {
      throw new EducateOsError("forbidden", "This part of EducateOS is not available to your account.");
    }

    const input = await parseInput();
    const ctx = new RequestContext(correlationId, principal, snapshot, url.origin);
    const handler = (handlers[matched.name as keyof Handlers] ?? guardianRoutes[matched.name as GuardianRouteName]) as (ctx: RequestContext, input: unknown) => Promise<unknown>;
    return jsonResponse(await handler(ctx, input), spec.status ?? 200, correlationId);
  }

  return {
    districtId,
    engine,
    ledger,
    aiGovernor: ledgerGovernor(ledger),
    guardDirectory: guardDirectoryOver(async () => {
      const [directory, workspaces, workshopUserLinks] = await Promise.all([stores.directory.load(), stores.workspaces.load(), stores.workshopUserLinks.list()]);
      return { directory: directory.snapshot, workspaces: workspaces.state.workspaces, workshopUserLinks };
    }),
    catalog,
    stores,
    communication: {
      runNotificationJob: () => communicationFor(jobDecider).runNotificationJob(),
      runWeeklyDigest: () => familyDigest(communicationFor(jobDecider)).runWeeklyJob(),
    },
    async fetch(request) {
      const correlationId = crypto.randomUUID();
      try {
        const feed = await serveCalendarFeed(request, correlationId);
        if (feed !== undefined) return feed;
        return await handle(request, correlationId);
      } catch (error) {
        return errorResponse(error, correlationId, new URL(request.url).pathname);
      }
    },
  };
}

/** An assignment and its starter material, without where the material's content is stored. */
/** A principal as the authoring screens list them (`AuthoringPrincipalBody`): never their sign-in identities. */
function authoringPrincipal(snapshot: DistrictDirectorySnapshot, principal: Principal, at: Date) {
  const { id, kind, status, displayName, email } = principal;
  return { id, kind, status, displayName, ...(email === undefined ? {} : { email }), districtAdmin: isDistrictAdmin(snapshot, id, at) };
}

/** {@link authoringPrincipal} for a principal known to be in `snapshot`. */
function authoringPrincipalById(snapshot: DistrictDirectorySnapshot, principalId: PrincipalId, at: Date) {
  const principal = snapshot.principals.find((p) => p.id === principalId);
  if (principal === undefined) throw new EducateOsError("not-found", `principal ${principalId} was not found.`);
  return authoringPrincipal(snapshot, principal, at);
}

async function assignmentView(assessment: AssessmentService, caller: Caller, assignmentId: AssignmentId): Promise<AssignmentViewBody> {
  const { assignment, starterMaterials } = await assessment.getAssignment(caller, assignmentId);
  return { assignment, starterMaterials: starterMaterials.map(({ content: _stored, ...material }) => material) };
}
