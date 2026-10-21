import {
  AuthorityMap,
  SchoolOsError,
  type Action,
  type Authorizer,
  type Caller,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type OfferingId,
  type PolicySettings,
  type ResourceRef,
  type VerifiedIdentity,
} from "@schoolos/contracts";
import { createDirectoryPrincipalResolver, type PrincipalResolver, type ResolvedPrincipal } from "@schoolos/identity";
import { AcademicDirectory } from "@schoolos/academics";
import { directoryPolicyInformation, PolicyEngine, subjectFactsFrom, type PolicyDecider, type PolicyRule } from "@schoolos/policy";
import { RetentionPolicy, WorkspaceDirectory } from "@schoolos/workspaces";
import { LearningArtifacts } from "@schoolos/learning-artifacts";
import { AssessmentService } from "@schoolos/assessment";
import { catalogAlignmentSource, ContentStudio, type AlignmentSource, type ContentReviewer, type ImportFetch } from "@schoolos/content-studio";
import { contentStudioReleases, CurriculumService, type AiHelpPolicySource, type OfferingScope } from "@schoolos/curriculum";
import { CatalogMirror, catalogSeedRelease, type VerifyRelease } from "@schoolos/catalog";
import { AiLedger, ledgerGovernor, type AiRequestGovernor, type CloudflareAccountFacts, type FundingPool, type GovernedModel, type UsdNano } from "@schoolos/ai-governance";
import { createDraftRevision, planConfigurationChange, SHIPPED_REGISTRY, type CapabilityRegistry } from "@schoolos/config";
import { oneroster } from "@schoolos/integrations";
import { ArtifactsGitBackend, InMemoryCredentialLedger, ProjectArtifacts, type ArtifactsPlan } from "@schoolos/artifacts-git";
import { AssessmentCi, AssessmentRuns, builtinRegistry, signRubricRelease, type EvaluatorRegistry } from "@schoolos/assessment-ci";
import { changeAllocations, effectivePools } from "./funding.ts";
import { applyRosterImport, contentBody, installAndAssign, keepArtifact, runCiAndSuggest, termClosedEvents } from "./adapters.ts";
import { errorResponse, jsonResponse, matchRoute, parsePart, readJsonBody } from "./http.ts";
import { configPolicySource, DEFAULT_POLICY_FLOOR, DISTRICT_APP_RULES } from "./policy.ts";
import { type ParsedRouteInput, type RouteName, type RouteResponse, type Surface } from "./routes.ts";
import type { DistrictAppStores } from "./stores.ts";
import { guardDirectoryOver, type GuardDirectory } from "./guard-directory.ts";

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
  /** Which system owns each directory record type. Defaults to the OneRoster roster for every type. */
  authority?: AuthorityMap;
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
   * What the SchoolOS AI call guard may learn about a Workshop user (SCHO-132): their principal,
   * roles, workspace and grade bands, read afresh from the district's stores. It is not on the
   * `/api` surface; only a deployment that binds the guard to it can call it.
   */
  readonly guardDirectory: GuardDirectory;
  /** The district's framework catalog mirror. Callers authorize first; it records but does not decide. */
  readonly catalog: CatalogMirror;
  /** The stores, for operators and tests. */
  readonly stores: DistrictAppStores;
}

const ALL_ROSTER: AuthorityMap = {
  school: "external:oneroster",
  term: "external:oneroster",
  course: "external:oneroster",
  offering: "external:oneroster",
  enrollment: "external:oneroster",
  principal: "external:oneroster",
};

/** Which principal kinds a surface answers. */
const SURFACE_KINDS: Record<Surface, readonly ResolvedPrincipal["kind"][]> = {
  me: ["student", "staff"],
  student: ["student"],
  teacher: ["staff"],
  admin: ["staff"],
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
 * Composes one district's SchoolOS domain services into one application behind a typed `/api`
 * surface (see `ROUTES`). Every request:
 *
 * 1. gets a correlation ID, returned in `x-correlation-id` and in any error body, which every
 *    policy decision made for the request is audited under;
 * 2. is matched to a route, and its credential verified and resolved to a principal of this
 *    district through `@schoolos/identity` (nothing in the request names who the caller is);
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
  const authority = AuthorityMap.parse(options.authority ?? ALL_ROSTER);
  const retention = RetentionPolicy.parse(options.retention ?? { courseWorkspaceRetentionDays: 365 });
  const registry = options.registry ?? SHIPPED_REGISTRY;
  const policySource = configPolicySource(stores.config, options.defaultPolicy ?? DEFAULT_POLICY_FLOOR);
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(stores.directory, policySource),
    audit: stores.audit,
    rules: options.rules ?? DISTRICT_APP_RULES,
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

    constructor(correlationId: string, principal: ResolvedPrincipal, snapshot: DistrictDirectorySnapshot) {
      this.correlationId = correlationId;
      this.principal = principal;
      this.snapshot = snapshot;
      this.caller = { principal: { principalId: principal.principalId, districtId: principal.districtId }, channel: "http" };
      this.decider = { decide: (request) => engine.decide(request, { correlationId }) };
      this.authorizer = { authorize: async (request) => (await this.decider.decide(request)).decision };
    }

    get subject() {
      return this.caller.principal;
    }

    academics(): AcademicDirectory {
      return new AcademicDirectory({ store: stores.directory, authority, authorizer: this.authorizer });
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
      if (projectsGit === undefined) throw new SchoolOsError("unavailable", "Projects are not enabled in this district.");
      return new ProjectArtifacts({
        artifacts: this.artifacts(),
        git: projectsGit,
        workspaces: stores.workspaces,
        directory: stores.directory,
        policy: this.decider,
        now,
      });
    }

    /** The offering's full scope, from the directory. */
    offeringScope(offeringId: OfferingId): OfferingScope {
      const offering = this.snapshot.offerings.find((o) => o.id === offeringId);
      if (offering === undefined) throw new SchoolOsError("not-found", `offering ${offeringId} was not found.`);
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
      if (decision.effect !== "allow") throw new SchoolOsError("forbidden", message);
    }

    /** Requires the engine to allow `action` on a district-level resource, answering `forbidden` otherwise. */
    async requireDistrict(action: Action, kind: ResourceRef["kind"]): Promise<void> {
      await this.require(action, { kind, scope: { level: "district", districtId }, classification: "district-internal" }, "Only a district administrator can do this.");
    }

    rosterConfig(): oneroster.OneRosterImportConfig {
      return options.roster ?? { issuer: this.snapshot.district.trustedIssuers[0]!, subject: { field: "username" } };
    }
  }

  type Handlers = { [N in RouteName]: (ctx: RequestContext, input: ParsedRouteInput<N>) => Promise<RouteResponse<N>> };

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
          if (error instanceof SchoolOsError && error.code === "not-found") return undefined;
          throw error;
        });
        if (activity !== undefined) assigned.push({ assignment, activity });
      }
      return assigned;
    },
    "student.getActivity": (ctx, { params }) => ctx.curriculum().getActivity(ctx.subject, params.activityId),
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
    "teacher.roster": async (ctx, { params }) => {
      const roster = await ctx.academics().roster(ctx.caller, params.offeringId);
      return roster.map((enrollment) => ({
        enrollment,
        displayName: ctx.snapshot.principals.find((p) => p.id === enrollment.principalId)?.displayName ?? "",
      }));
    },
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
        throw new SchoolOsError("conflict", "The configuration changed since this plan was made; plan it again.");
      }
      const draft = await createDraftRevision({
        document: body.document,
        registry,
        actorPrincipalId: ctx.principal.principalId,
        ...(head === undefined ? {} : { previous: head }),
      });
      if (!draft.ok) throw new SchoolOsError("validation-failed", "The configuration does not compile; plan it to see why.");
      if (draft.revision.id === head?.id) return head;
      const plan = planConfigurationChange({ ...(head === undefined ? {} : { current: head }), next: draft.revision, directory: ctx.snapshot, registry });
      if (plan.problems.length > 0 || plan.policyViolations.length > 0) {
        throw new SchoolOsError("conflict", "The plan has problems that block applying it; plan it to see them.");
      }
      if (plan.approvals.length > 0 && !body.acknowledgeApprovals) {
        throw new SchoolOsError("conflict", "The plan requires approvals; review them and apply again acknowledging them.");
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
  };

  async function handle(request: Request, correlationId: string): Promise<Response> {
    const url = new URL(request.url);
    const matched = matchRoute(request.method, url.pathname);
    if (matched === undefined) throw new SchoolOsError("not-found", "No such route.");

    const identity = await options.verifyRequest(request);
    if (identity === undefined) throw new SchoolOsError("unauthenticated", "Sign in with this district's identity provider.");
    const { snapshot } = await stores.directory.load();
    const principal = await resolverFor(snapshot).resolve(identity);
    if (!SURFACE_KINDS[matched.spec.surface].includes(principal.kind)) {
      throw new SchoolOsError("forbidden", "This part of SchoolOS is not available to your account.");
    }

    const { spec } = matched;
    const input = {
      params: spec.params === undefined ? undefined : parsePart("path", spec.params, matched.params),
      query: spec.query === undefined ? undefined : parsePart("query", spec.query, Object.fromEntries(url.searchParams)),
      body: spec.body === undefined ? undefined : parsePart("body", spec.body, await readJsonBody(request)),
    };
    const ctx = new RequestContext(correlationId, principal, snapshot);
    const handler = handlers[matched.name] as (ctx: RequestContext, input: unknown) => Promise<unknown>;
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
    async fetch(request) {
      const correlationId = crypto.randomUUID();
      try {
        return await handle(request, correlationId);
      } catch (error) {
        return errorResponse(error, correlationId, new URL(request.url).pathname);
      }
    },
  };
}
