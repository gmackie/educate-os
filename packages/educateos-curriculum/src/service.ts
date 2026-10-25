import { type AlignmentSource, randomIdBody, type StudioRelease } from "@educateos/content-studio";
import {
  ActivityDefinitionId,
  type Action,
  ActivityId,
  type AuthorizationRequest,
  type Authorizer,
  type Classification,
  type DistrictDirectorySnapshot,
  type DistrictId,
  type RequestChannel,
  type Scope,
  EducateOsError,
  scopeContains,
  type TermState,
  type VerifiedPrincipal,
} from "@educateos/contracts";
import { type CompetencyRef, EvidenceContract } from "@educateos/registry";
import { z } from "zod";
import { AI_HELP_LEVELS, type AiHelpLevel, type AiHelpPolicySource, resolveAiHelp } from "./ai-help.ts";
import {
  buildClassCodex,
  buildHelperContext,
  type ClassCodex,
  type CodexPublisher,
  type HelperContext,
  type StudentCodex,
  studentCodexOf,
  studentContent,
} from "./codex.ts";
import { type ActivityScope, OfferingScope } from "./ids.ts";
import {
  type ActivityContent,
  ActivityDefinition,
  ActivityInstallation,
  checkActivityContent,
  releaseKey,
} from "./model.ts";
import type { ReleaseLookup } from "./releases.ts";
import type { CurriculumStorage } from "./storage.ts";
import { generateActivity, TemplateInput } from "./templates.ts";

/** A new activity: the offering it is authored for and a template's inputs. */
export const CreateActivityInput = z.strictObject({ scope: OfferingScope, activity: TemplateInput });
/** A new activity. */
export type CreateActivityInput = z.input<typeof CreateActivityInput>;

/** An edit: the template's inputs in full, replacing the previous content. */
export const ReviseActivityInput = z.strictObject({ activity: TemplateInput });
/** An activity edit. */
export type ReviseActivityInput = z.input<typeof ReviseActivityInput>;

/** An installation request. Without a version, the latest published version is installed. */
export const InstallActivityInput = z.strictObject({
  definitionId: ActivityDefinitionId,
  version: z.int().positive().optional(),
  offering: OfferingScope,
});
/** An installation request. */
export type InstallActivityInput = z.input<typeof InstallActivityInput>;

/** An installed activity as one reader may see it. Students get the student-visible content only. */
export interface InstalledActivityView {
  view: "teacher" | "student";
  installation: ActivityInstallation;
  content: ActivityContent;
  evidenceContract: EvidenceContract;
}

/** Everything a curriculum service needs. Each district runs its own, over its own storage. */
export interface CurriculumServiceOptions {
  districtId: DistrictId;
  /** The district directory, for offerings and their terms. */
  directory: DistrictDirectorySnapshot;
  /**
   * Decides every call: the district's `PolicyEngine` (`@educateos/policy`), whose default rule
   * table holds the C05 activity rules. Definitions are `teacher-only` activities; an installed
   * activity is read as `teacher-only` by staff and as `course` by students.
   */
  authorizer: Authorizer;
  /** The surface calls arrive through, recorded in authorization requests. */
  channel?: RequestChannel;
  releases: ReleaseLookup;
  /** Resolves alignments to the district's approved framework releases, as the Content Studio does. */
  alignments: AlignmentSource;
  aiHelpPolicy: AiHelpPolicySource;
  publisher: CodexPublisher;
  storage: CurriculumStorage;
  /** The current time as an ISO 8601 timestamp. */
  now?: () => string;
}

function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  throw new EducateOsError("validation-failed", `${issue.path.join(".") || "input"}: ${issue.message}`);
}

const NOT_FOUND = () => new EducateOsError("not-found", "no such activity");

/** A competency's short name for a teacher: the last part of its URI, which catalog URIs make its code. */
const goalCode = (competencyUri: string): string => competencyUri.split(/[:/]/).findLast((part) => part !== "") ?? competencyUri;

const strictest = (levels: readonly (AiHelpLevel | undefined)[]): AiHelpLevel =>
  AI_HELP_LEVELS[Math.max(...levels.map((level) => (level === undefined ? 0 : AI_HELP_LEVELS.indexOf(level))))]!;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The curriculum service (roadmap §3.2 steps 4-5, PR C05): teachers compose activities from
 * templates, publish immutable versions, and install a version into a class, which publishes the
 * class Codex. Every activity, whatever its subject or template, goes through the same
 * validation and installation code: it validates against the same rules at every save, publication and installation:
 * its resources are Content Studio releases approved for the class, its alignments resolve in the
 * district catalog, and its AI-help level only narrows the district and offering policy.
 */
export class CurriculumService {
  readonly #options: CurriculumServiceOptions;
  readonly #now: () => string;

  constructor(options: CurriculumServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Creates version 1 of a definition, as a draft, from a template's inputs.
   *
   * @throws EducateOsError `forbidden` unless the subject may create in the offering,
   *   `validation-failed` for invalid content, an unreleased resource or an unresolvable alignment,
   *   and `policy-violation` if its AI-help level would loosen the policy.
   */
  async createDraft(subject: VerifiedPrincipal, input: unknown): Promise<ActivityDefinition> {
    const { scope, activity } = parseInput(CreateActivityInput, input);
    await this.#require(subject, "create", scope, "teacher-only");
    const content = generateActivity(activity);
    const id = ActivityDefinitionId.parse(`adf_${randomIdBody()}`);
    return this.#save(subject, { id, version: 1, scope, content });
  }

  /**
   * Replaces the content of a draft, or, if the latest version is published, creates the next
   * version as a draft. A published version is never changed, so installations of it are not.
   *
   * @throws EducateOsError as {@link createDraft}, and `not-found` if the subject cannot see it.
   */
  async revise(subject: VerifiedPrincipal, definitionId: unknown, input: unknown): Promise<ActivityDefinition> {
    const { activity } = parseInput(ReviseActivityInput, input);
    const latest = (await this.#versions(subject, definitionId, "update")).at(-1)!;
    const version = latest.status === "draft" ? latest.version : latest.version + 1;
    return this.#save(subject, { id: latest.id, version, scope: latest.scope, content: generateActivity(activity) });
  }

  /**
   * Publishes the latest draft, after validating it again. The version is immutable from then on.
   *
   * @throws EducateOsError `conflict` if the latest version is already published, and as {@link createDraft}.
   */
  async publish(subject: VerifiedPrincipal, definitionId: unknown): Promise<ActivityDefinition> {
    const latest = (await this.#versions(subject, definitionId, "publish")).at(-1)!;
    if (latest.status === "published") throw new EducateOsError("conflict", "this version is already published; edit it to create a new version");
    await this.#validate(latest.content, latest.scope);
    const published: ActivityDefinition = { ...latest, status: "published", published: { by: subject.principalId, at: this.#now() } };
    await this.#options.storage.putVersion(published);
    return published;
  }

  /** One version of a definition, or the latest. Staff only: definitions are teacher-only. */
  async getDefinition(subject: VerifiedPrincipal, definitionId: unknown, version?: number): Promise<ActivityDefinition> {
    const versions = await this.#versions(subject, definitionId, "read");
    const found = version === undefined ? versions.at(-1) : versions[version - 1];
    if (found === undefined) throw NOT_FOUND();
    return found;
  }

  /**
   * Installs a published version into an offering and its term, and publishes the student Codex.
   * The installation pins the version. The content is validated again against the target class:
   * its releases must be approved for it, and its AI-help level must fit the policy in force now.
   *
   * @throws EducateOsError `not-found` if the subject cannot see the definition, `conflict` if no
   *   such version is published, `forbidden` unless the subject may assign in the offering in a
   *   planned or active term, `validation-failed` and `policy-violation` as {@link createDraft},
   *   and `validation-failed` if the due date falls outside the term.
   */
  async install(subject: VerifiedPrincipal, input: unknown): Promise<ActivityInstallation> {
    const { definitionId, version, offering } = parseInput(InstallActivityInput, input);
    const versions = await this.#versions(subject, definitionId, "read");
    const definition = version === undefined ? versions.findLast((v) => v.status === "published") : versions[version - 1];
    if (definition === undefined || definition.status !== "published") throw new EducateOsError("conflict", "only a published version can be installed");
    const { directory } = this.#options;
    const term = directory.terms.find((t) => t.id === directory.offerings.find((o) => o.id === offering.offeringId)?.termId);
    if (term === undefined) throw new EducateOsError("not-found", "no such offering");
    await this.#require(subject, "assign", offering, "teacher-only", term.state);
    const { releases } = await this.#validate(definition.content, offering);

    const installedAt = this.#now();
    const dueAt = resolveDueAt(definition.content, installedAt, term.endsOn);
    const activityId = ActivityId.parse(`act_${randomIdBody()}`);
    const codex = studentCodexOf(buildClassCodex(activityId, definition.content, releases), {
      districtId: offering.districtId,
      offeringId: offering.offeringId,
      definitionId: definition.id,
      definitionVersion: definition.version,
    });
    const publication = await this.#options.publisher.publish(codex);
    const installation = ActivityInstallation.parse({
      id: activityId,
      scope: { ...offering, level: "activity", activityId },
      termId: term.id,
      definitionId: definition.id,
      definitionVersion: definition.version,
      aiHelp: definition.content.aiHelp,
      ...(dueAt === undefined ? {} : { dueAt }),
      installedBy: subject.principalId,
      installedAt,
      codex: publication,
    } satisfies ActivityInstallation);
    await this.#options.storage.addInstallation(installation);
    return installation;
  }

  /**
   * An installed activity. Its staff see it in full; an actively enrolled student sees the
   * student-visible content only, without teacher-only notes or answer keys.
   *
   * @throws EducateOsError `not-found` if the subject may not read it, including a student who is
   *   not actively enrolled in its offering.
   */
  async getActivity(subject: VerifiedPrincipal, activityId: unknown): Promise<InstalledActivityView> {
    const { installation, definition } = await this.#installed(activityId);
    const base = { installation, evidenceContract: definition.evidenceContract };
    if (await this.#allowed(subject, "read", installation.scope, "teacher-only")) return { view: "teacher", ...base, content: definition.content };
    if (await this.#allowed(subject, "read", installation.scope, "course")) return { view: "student", ...base, content: studentContent(definition.content) };
    throw NOT_FOUND();
  }

  /** An installed activity's full class Codex, teacher-only entries included. Staff only. */
  async getClassCodex(subject: VerifiedPrincipal, activityId: unknown): Promise<ClassCodex> {
    const { installation, definition } = await this.#installed(activityId);
    if (!(await this.#allowed(subject, "read", installation.scope, "teacher-only"))) throw NOT_FOUND();
    return buildClassCodex(installation.id, definition.content, await this.#releases(definition.content));
  }

  /** An installed activity's student-visible Codex, as published. */
  async getStudentCodex(subject: VerifiedPrincipal, activityId: unknown): Promise<StudentCodex> {
    const { installation, definition } = await this.#installed(activityId);
    if (!(await this.#allowed(subject, "read", installation.scope, "course"))) throw NOT_FOUND();
    return this.#studentCodex(installation, definition);
  }

  /**
   * The context for the class AI helper on an installed activity, at the strictest of the
   * installed level and the policy in force now, so a later district tightening applies at once.
   *
   * @throws EducateOsError `not-found` if the subject may not read the activity, and
   *   `policy-violation` if AI help is off for it.
   */
  async helperContext(subject: VerifiedPrincipal, activityId: unknown): Promise<HelperContext> {
    const { installation, definition } = await this.#installed(activityId);
    if (!(await this.#allowed(subject, "read", installation.scope, "course"))) throw NOT_FOUND();
    const { districtId, schoolId, offeringId } = installation.scope;
    const layers = await this.#options.aiHelpPolicy.layersFor({ level: "offering", districtId, schoolId, offeringId });
    const level = strictest([layers.district, layers.school, layers.offering, installation.aiHelp]);
    if (level === "none") throw new EducateOsError("policy-violation", "AI help is off for this activity");
    const codex = await this.#studentCodex(installation, definition);
    return buildHelperContext({ level, content: studentContent(definition.content), codex }, randomIdBody());
  }

  /** Validates and stores one definition version as a draft. */
  async #save(
    subject: VerifiedPrincipal,
    draft: Pick<ActivityDefinition, "id" | "version" | "scope" | "content">,
  ): Promise<ActivityDefinition> {
    const { competencies } = await this.#validate(draft.content, draft.scope);
    const savedAt = this.#now();
    const { content } = draft;
    const evidenceContract = EvidenceContract.safeParse({
      id: draft.id.replace(/^adf_/, "evc_"),
      version: draft.version,
      title: content.title,
      competencies,
      responseType: content.evidence.responseType,
      criteria: content.evidence.criteria,
      restrictions: {
        aiAssistance: content.aiHelp === "none" ? "not-allowed" : "allowed-with-disclosure",
        collaboration: content.evidence.collaboration,
      },
      provenance: {
        source: "district-authored",
        sourceUri: `urn:educateos:activity:${draft.id}:${draft.version}`,
        retrievedAt: savedAt,
        sourceRevision: `v${draft.version}`,
      },
    });
    if (!evidenceContract.success) throw new EducateOsError("validation-failed", "the activity's evidence cannot form an evidence contract");
    const definition = ActivityDefinition.parse({
      ...draft,
      status: "draft",
      evidenceContract: evidenceContract.data,
      savedBy: subject.principalId,
      savedAt,
    } satisfies ActivityDefinition);
    await this.#options.storage.putVersion(definition);
    return definition;
  }

  /**
   * The rules every activity meets in `offering`: its structure, released resources approved for
   * the offering, resolvable alignments, and an AI-help level that only narrows the policy.
   */
  async #validate(content: ActivityContent, offering: OfferingScope): Promise<{ releases: Map<string, StudioRelease>; competencies: CompetencyRef[] }> {
    const issue = checkActivityContent(content)[0];
    if (issue !== undefined) throw new EducateOsError("validation-failed", `${issue.path}: ${issue.message}`);
    const releases = await this.#releases(content);
    for (const [key, release] of releases) {
      if (!scopeContains(release.scope, offering)) throw new EducateOsError("validation-failed", `${key} is not approved for this class`);
    }
    const competencies = new Map<string, CompetencyRef>();
    for (const { frameworkKey, competencyUri } of content.evidence.alignments) {
      const competency = await this.#options.alignments.resolve(frameworkKey, competencyUri);
      // Named by its code where the teacher sees one, never by its URI: the message reaches the teacher.
      if (competency === undefined) throw new EducateOsError("validation-failed", `The learning goal ${goalCode(competencyUri)} is not in a learning standards release your district has approved.`);
      competencies.set(competency.competencyUri, competency);
    }
    const resolution = resolveAiHelp(await this.#options.aiHelpPolicy.layersFor(offering), content.aiHelp);
    if (!resolution.ok) {
      const detail = resolution.violations.map((v) => `${v.level} asks for ${v.requested} above ${v.floor}`).join("; ");
      throw new EducateOsError("policy-violation", `AI help may only be narrowed: ${detail}`);
    }
    return { releases, competencies: [...competencies.values()] };
  }

  /** Every release the content references. Refuses any that is not released. */
  async #releases(content: ActivityContent): Promise<Map<string, StudioRelease>> {
    const releases = new Map<string, StudioRelease>();
    for (const ref of content.resources) {
      const release = await this.#options.releases.getRelease(ref);
      if (release === undefined || release.scope.districtId !== this.#options.districtId) {
        throw new EducateOsError("validation-failed", `${releaseKey(ref)} is not a released resource`);
      }
      releases.set(releaseKey(ref), release);
    }
    return releases;
  }

  async #studentCodex(installation: ActivityInstallation, definition: ActivityDefinition): Promise<StudentCodex> {
    return studentCodexOf(buildClassCodex(installation.id, definition.content, await this.#releases(definition.content)), {
      districtId: installation.scope.districtId,
      offeringId: installation.scope.offeringId,
      definitionId: definition.id,
      definitionVersion: definition.version,
    });
  }

  /** A definition's versions, if the subject may see it and act on it. */
  async #versions(subject: VerifiedPrincipal, definitionId: unknown, action: Action): Promise<ActivityDefinition[]> {
    const id = ActivityDefinitionId.safeParse(definitionId);
    if (!id.success) throw NOT_FOUND();
    const versions = await this.#options.storage.listVersions(id.data);
    const scope = versions.at(-1)?.scope;
    if (scope === undefined || scope.districtId !== this.#options.districtId) throw NOT_FOUND();
    if (!(await this.#allowed(subject, "read", scope, "teacher-only", id.data))) throw NOT_FOUND();
    if (action !== "read") await this.#require(subject, action, scope, "teacher-only");
    return versions;
  }

  /** An installation and the exact definition version it pinned. */
  async #installed(activityId: unknown): Promise<{ installation: ActivityInstallation; definition: ActivityDefinition }> {
    const id = ActivityId.safeParse(activityId);
    if (!id.success) throw NOT_FOUND();
    const installation = await this.#options.storage.getInstallation(id.data);
    if (installation === undefined || installation.scope.districtId !== this.#options.districtId) throw NOT_FOUND();
    const definition = (await this.#options.storage.listVersions(installation.definitionId))[installation.definitionVersion - 1];
    if (definition === undefined) throw NOT_FOUND();
    return { installation, definition };
  }

  async #allowed(subject: VerifiedPrincipal, action: Action, scope: Scope | ActivityScope, classification: Classification, id?: string, termState?: TermState): Promise<boolean> {
    const decision = await this.#options.authorizer.authorize({
      subject,
      action,
      resource: { kind: "activity", ...(id === undefined ? {} : { id }), scope, classification },
      context: { channel: this.#options.channel ?? "http", ...(termState === undefined ? {} : { termState }) },
    } satisfies AuthorizationRequest);
    return decision.effect === "allow";
  }

  async #require(subject: VerifiedPrincipal, action: Action, scope: Scope, classification: Classification, termState?: TermState): Promise<void> {
    if (!(await this.#allowed(subject, action, scope, classification, undefined, termState))) {
      throw new EducateOsError("forbidden", `not permitted to ${action} here`);
    }
  }
}

/**
 * The due instant for an installation, which must fall after installation and on or before the
 * term's last day (compared as UTC calendar dates).
 */
function resolveDueAt(content: ActivityContent, installedAt: string, termEndsOn: string): string | undefined {
  const { due } = content;
  if (due.kind === "none") return undefined;
  const dueMs = due.kind === "fixed" ? Date.parse(due.dueAt) : Date.parse(installedAt) + due.days * DAY_MS;
  if (dueMs <= Date.parse(installedAt) || new Date(dueMs).toISOString().slice(0, 10) > termEndsOn) {
    throw new EducateOsError("validation-failed", "the due date must fall between installation and the end of the term");
  }
  return due.kind === "fixed" ? due.dueAt : new Date(dueMs).toISOString();
}
