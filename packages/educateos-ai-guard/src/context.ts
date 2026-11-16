// Who a model call is for, in EducateOS terms. The Workshop names only its own user; this port maps
// that to a district principal and everything moderation and funding need to know about them.

import type { AiCallDescriptor } from "@gadgets/workshop-shared/ai-call-guard";
import type { AiPrincipal, AiWorkspaceContext } from "@educateos/ai-governance";
import type { GradeBand } from "@gmacko/hall-monitor-contracts";
import { GuardSubject, guardDirectoryOver, type AdmittedSubjectRequest, type GuardDirectory, type GuardSubjectRequest } from "@educateos/district-app/guard-directory";
import type { AudienceProfileKey, GuardConfig, GuardProfile, PrincipalBinding } from "./config.ts";

/** Everything the guard needs to know about who a call is for. Labels only, never learner data. */
export interface GuardContext {
  /** The district principal the call is billed to. */
  principal: AiPrincipal;
  /** The workspace the call is billed to. */
  workspace: AiWorkspaceContext;
  /** Who reads the model's output. A student audience always fails closed. */
  audience: "student" | "educator";
  /** The principal's verified grade band, when known. */
  gradeBand?: GradeBand;
  /** How the principal's input is moderated. */
  profile: GuardProfile;
}

/**
 * Resolves the {@link GuardContext} of a model call, or `null` when the call's initiator is no
 * principal this deployment serves (it is then refused). Implementations must derive everything
 * from trusted state keyed by the Workshop-authenticated initiator, never from message content.
 */
export interface GuardContextResolver {
  /** The context of `call`, or `null`. */
  resolve(call: Pick<AiCallDescriptor, "initiator" | "gadgetId">): Promise<GuardContext | null>;

  /**
   * The context of a call already admitted for `principal` and billed to `workspace`, as its
   * reservation records them, or `null` when the principal is no longer one this deployment serves.
   */
  resolveAdmitted(principal: AiPrincipal, workspace: AiWorkspaceContext): Promise<GuardContext | null>;
}

/** The lowest grade a published band (`K`, `7`, `9-12`, `K-8`) covers; kindergarten is 0. */
function lowestGrade(band: string): number {
  const first = band.split("-")[0]!;
  return first === "K" ? 0 : Number(first);
}

/**
 * How a district subject is moderated: the audience class whose profile applies, and the Hall
 * Monitor grade band to send. A student is moderated for the youngest grade their call is for; a
 * student with no known band is moderated as the youngest of all (`student-k5`), and no band is
 * sent, since none is verified.
 */
export function audienceOf(subject: GuardSubject): { key: AudienceProfileKey; gradeBand?: GradeBand } {
  if (subject.kind === "staff") return { key: "educator" };
  if (subject.gradeBands.length === 0) return { key: "student-k5" };
  const lowest = Math.min(...subject.gradeBands.map(lowestGrade));
  if (lowest <= 2) return { key: "student-k5", gradeBand: "K-2" };
  if (lowest <= 5) return { key: "student-k5", gradeBand: "3-5" };
  if (lowest <= 8) return { key: "student-6-8", gradeBand: "6-8" };
  return { key: "student-9-12", gradeBand: "9-12" };
}

/** The grade bands students are moderated in, youngest first. */
export const STUDENT_GRADE_BANDS = ["K-2", "3-5", "6-8", "9-12"] as const satisfies readonly GradeBand[];
/** A student grade band. */
export type StudentGradeBand = (typeof STUDENT_GRADE_BANDS)[number];

const isStudentGradeBand = (band: unknown): band is StudentGradeBand => STUDENT_GRADE_BANDS.includes(band as StudentGradeBand);

/** The audience class a student grade band is moderated under, as {@link audienceOf} assigns it. */
export function studentProfileKey(band: StudentGradeBand): AudienceProfileKey {
  return band === "9-12" ? "student-9-12" : band === "6-8" ? "student-6-8" : "student-k5";
}

/**
 * The grade band a gadget's own model call is moderated at (SCHO-307, SCHO-325): the younger of
 * the band the gadget's model binding declares (`AiCallDescriptor.audience`) and the band of the
 * reader the guard knows of, the call's initiator. The Workshop cannot tell who is typing into a
 * gadget, so the call is always moderated as a student's.
 *
 * - No declaration, or one that names no student band (`adult`, a typo), counts as `K-2`, the
 *   youngest, which is how every gadget call was moderated before bands could be declared.
 * - A student is never moderated at a band older than their own; a student with no known band
 *   counts as `K-2`, as {@link audienceOf} does.
 * - Staff have no band of their own, so a member of staff's gadget is moderated at the band it
 *   declares, never as an educator.
 *
 * So a declaration can make a student's gadget calls stricter than their own band, never looser.
 */
export function gadgetGradeBand(declared: string | undefined, reader: Pick<GuardContext, "audience" | "gradeBand">): StudentGradeBand {
  const band = isStudentGradeBand(declared) ? declared : "K-2";
  if (reader.audience === "educator") return band;
  const own = isStudentGradeBand(reader.gradeBand) ? reader.gradeBand : "K-2";
  return STUDENT_GRADE_BANDS.indexOf(own) < STUDENT_GRADE_BANDS.indexOf(band) ? own : band;
}

/**
 * A {@link GuardDirectory} as the guard reaches it, possibly over a service binding: its answers
 * are untrusted until validated.
 */
export interface GuardDirectoryPort {
  /** What the district says about `request`'s Workshop user, or `null`. */
  guardSubject(request: GuardSubjectRequest): Promise<unknown>;
  /** What the district says now about an admitted call's principal, or `null`. */
  admittedSubject(request: AdmittedSubjectRequest): Promise<unknown>;
  /** The profile-free directory the ledger resolves funding against. */
  ledgerDirectory(): Promise<unknown>;
}

/**
 * A {@link GuardContextResolver} over the district's records (SCHO-132). The Workshop user the
 * kernel authenticated is looked up in the district's {@link GuardDirectory}: their principal
 * through an administrator-confirmed link (`@educateos/identity`), their kind and grade bands from
 * the directory, the call's workspace from the gadget's workspace record. Nothing the call's
 * content or the browser says is consulted. A gadget initiator's calls are its owner's; an `agent`
 * initiator names a model, not a person, and resolves to nothing.
 *
 * The directory's answer is validated again here, since it may arrive over a service binding, and
 * an answer for a principal of any other district is refused. An admitted call's output is
 * screened under the principal's current audience, looked up by the principal its reservation
 * names.
 */
export class DistrictGuardContextResolver implements GuardContextResolver {
  readonly #directory: GuardDirectoryPort;
  readonly #config: GuardConfig;

  constructor(directory: GuardDirectoryPort, config: GuardConfig) {
    this.#directory = directory;
    this.#config = config;
  }

  async resolve(call: Pick<AiCallDescriptor, "initiator" | "gadgetId">): Promise<GuardContext | null> {
    if (call.initiator.type === "agent") return null;
    const request: GuardSubjectRequest = { workshopUser: call.initiator.id, ...(call.gadgetId === undefined ? {} : { gadgetId: call.gadgetId }) };
    return this.#context(await this.#directory.guardSubject(request));
  }

  async resolveAdmitted(principal: AiPrincipal, workspace: AiWorkspaceContext): Promise<GuardContext | null> {
    if (principal.districtId !== this.#config.districtId) return null;
    return this.#context(await this.#directory.admittedSubject({ principal, workspace }));
  }

  #context(answer: unknown): GuardContext | null {
    if (answer === null) return null;
    const parsed = GuardSubject.safeParse(answer);
    if (!parsed.success) throw new Error("the district directory answered with a malformed subject");
    const subject = parsed.data;
    if (subject.principal.districtId !== this.#config.districtId) return null;
    const audience = audienceOf(subject);
    const profile = this.#config.profiles[audience.key];
    if (profile === undefined) return null;
    return {
      principal: subject.principal,
      workspace: subject.workspace,
      audience: audience.key === "educator" ? "educator" : "student",
      ...(audience.gradeBand === undefined ? {} : { gradeBand: audience.gradeBand }),
      profile,
    };
  }
}

/**
 * The district's {@link GuardDirectory} as the deployment configures it: the directory snapshot
 * the ledger also decides against, with the configured workspaces and Workshop user links. Used
 * when no `EDUCATEOS_DISTRICT` binding reaches a running district app.
 */
export function configuredGuardDirectory(config: GuardConfig): GuardDirectory {
  const { directory } = config;
  return guardDirectoryOver(async () => {
    if (directory === undefined) throw new Error("AI_GUARD_CONFIG has no directory and no EDUCATEOS_DISTRICT is bound");
    return { directory, workspaces: config.workspaces, workshopUserLinks: config.workshopUserLinks };
  });
}

/**
 * A {@link GuardContextResolver} over the deployment's configured principal bindings, for tests and
 * local development (`contextSource: "static"`). A `user` or `gadget` initiator is looked up by its
 * Workshop user ID (a gadget's calls are its owner's); an `agent` initiator names a model, not a
 * person, and resolves to nothing.
 */
export class StaticGuardContextResolver implements GuardContextResolver {
  readonly #config: GuardConfig;

  constructor(config: GuardConfig) {
    this.#config = config;
  }

  async resolve(call: Pick<AiCallDescriptor, "initiator" | "gadgetId">): Promise<GuardContext | null> {
    if (call.initiator.type === "agent") return null;
    const binding = this.#config.principals.find((candidate) => candidate.workshopUserId === call.initiator.id);
    const gadgetWorkspace = call.gadgetId === undefined ? undefined : binding?.gadgetWorkspaces?.[call.gadgetId];
    return this.#context(binding, gadgetWorkspace ?? binding?.workspace);
  }

  async resolveAdmitted(principal: AiPrincipal, workspace: AiWorkspaceContext): Promise<GuardContext | null> {
    if (principal.districtId !== this.#config.districtId) return null;
    return this.#context(this.#config.principals.find((candidate) => candidate.principalId === principal.principalId), workspace);
  }

  #context(binding: PrincipalBinding | undefined, workspace: AiWorkspaceContext | undefined): GuardContext | null {
    const profile = binding === undefined ? undefined : this.#config.profiles[binding.profile];
    if (binding === undefined || profile === undefined || workspace === undefined) return null;
    return {
      principal: { principalId: binding.principalId, districtId: this.#config.districtId },
      workspace,
      audience: binding.audience,
      ...(binding.gradeBand === undefined ? {} : { gradeBand: binding.gradeBand }),
      profile,
    };
  }
}
