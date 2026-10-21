import { z } from "zod";
import {
  DistrictId,
  GradeAuthority,
  OfferingId,
  PrincipalId,
  SchoolOsError,
  type DistrictDirectorySnapshot,
  type Principal,
} from "@schoolos/contracts";
import { LtiContextServices } from "./service-client.ts";
import type { Clock } from "./stores.ts";

const LmsAuthority = GradeAuthority.options[1];

/** An offering whose grades SchoolOS keeps. */
export const LocalGradeRoute = z.strictObject({ offeringId: OfferingId, authority: z.literal("local") });
/** A local grade route. */
export type LocalGradeRoute = z.infer<typeof LocalGradeRoute>;

/** An offering whose gradebook is an LTI platform's, reached through AGS in one context. */
export const LtiGradeRoute = z.strictObject({
  offeringId: OfferingId,
  authority: LmsAuthority,
  via: z.literal("lti-ags"),
  /** The context's services, as recorded from a launch. */
  services: LtiContextServices,
});
/** An LTI grade route. */
export type LtiGradeRoute = z.infer<typeof LtiGradeRoute>;

/** An offering whose gradebook is a Google Classroom course's. */
export const ClassroomGradeRoute = z.strictObject({
  offeringId: OfferingId,
  authority: LmsAuthority,
  via: z.literal("google-classroom"),
  courseId: z.string().min(1).max(255),
});
/** A Google Classroom grade route. */
export type ClassroomGradeRoute = z.infer<typeof ClassroomGradeRoute>;

/**
 * Where an offering's official grades live, and how SchoolOS reaches them. Administrators set this
 * per offering; there is no default, so an offering with no route sends nothing anywhere.
 */
export const GradeRoute = z.union([LocalGradeRoute, LtiGradeRoute, ClassroomGradeRoute]);
/** A grade route. */
export type GradeRoute = z.infer<typeof GradeRoute>;

/** A route to an LMS gradebook. */
export type LmsGradeRoute = LtiGradeRoute | ClassroomGradeRoute;

/** Where the passback gate reads grade routes. */
export interface GradeRouteStore {
  /** The route for `offeringId`, or `undefined` if none is configured. */
  routeFor(offeringId: OfferingId): Promise<GradeRoute | undefined>;
}

/** An in-memory {@link GradeRouteStore}. */
export class InMemoryGradeRouteStore implements GradeRouteStore {
  readonly #routes = new Map<string, GradeRoute>();

  /** Validates every route. Throws if one is malformed or two name the same offering. */
  constructor(routes: readonly GradeRoute[]) {
    for (const input of routes) {
      const route = GradeRoute.parse(input);
      if (this.#routes.has(route.offeringId)) throw new SchoolOsError("conflict", "An offering has two grade routes.");
      this.#routes.set(route.offeringId, route);
    }
  }

  async routeFor(offeringId: OfferingId): Promise<GradeRoute | undefined> {
    return this.#routes.get(offeringId);
  }
}

const Column = z.string().min(1).max(2048);
const Score = z.number().finite().nonnegative();
const Maximum = z.number().finite().positive();
const GradeVersion = z.number().int().positive();

/**
 * A teacher's approval of one grade: the record that makes a grade official (threat T10). It binds
 * the approver, the offering they teach, the student, the gradebook column, the exact score and
 * the grade version, and when it was given. An AI-suggested score has no such record until a
 * teacher reviews it, and an edited score needs a new approval with a new version.
 *
 * Approvals are written only by a teacher's own authenticated action in SchoolOS (the core
 * classroom service keeps them, roadmap §6.3). The passback gate reads them from a
 * {@link GradeApprovalStore}; a caller cannot hand one in.
 */
export const TeacherGradeApproval = z.strictObject({
  offeringId: OfferingId,
  studentId: PrincipalId,
  /** The gradebook column: an AGS line item URL or a Classroom coursework ID. */
  column: Column,
  gradeVersion: GradeVersion,
  scoreGiven: Score,
  scoreMaximum: Maximum,
  approverId: PrincipalId,
  approvedAt: z.iso.datetime(),
});
/** A teacher grade approval. */
export type TeacherGradeApproval = z.infer<typeof TeacherGradeApproval>;

/** Identifies the approval of one version of one grade. */
export interface GradeApprovalKey {
  readonly offeringId: OfferingId;
  readonly studentId: PrincipalId;
  readonly column: string;
  readonly gradeVersion: number;
}

/** Where the passback gate reads teacher approvals. */
export interface GradeApprovalStore {
  /** The approval of exactly this grade version, or `undefined`. */
  find(key: GradeApprovalKey): Promise<TeacherGradeApproval | undefined>;
}

const approvalKey = (key: GradeApprovalKey): string =>
  JSON.stringify([key.offeringId, key.studentId, key.column, key.gradeVersion]);

/** An in-memory {@link GradeApprovalStore}. */
export class InMemoryGradeApprovalStore implements GradeApprovalStore {
  readonly #approvals = new Map<string, TeacherGradeApproval>();

  constructor(approvals: readonly TeacherGradeApproval[] = []) {
    for (const approval of approvals) this.record(approval);
  }

  /** Records an approval. Throws `conflict` if that grade version is already approved. */
  record(input: TeacherGradeApproval): void {
    const approval = TeacherGradeApproval.parse(input);
    const key = approvalKey(approval);
    if (this.#approvals.has(key)) throw new SchoolOsError("conflict", "That grade version is already approved.");
    this.#approvals.set(key, approval);
  }

  async find(key: GradeApprovalKey): Promise<TeacherGradeApproval | undefined> {
    return this.#approvals.get(approvalKey(key));
  }
}

/** A request to publish one grade version to the offering's LMS gradebook. */
export const GradePassbackRequest = z.strictObject({
  offeringId: OfferingId,
  studentId: PrincipalId,
  column: Column,
  gradeVersion: GradeVersion,
  scoreGiven: Score,
  scoreMaximum: Maximum,
  /** Shown to the student in the LMS. */
  comment: z.string().max(10_000).optional(),
});
/** A grade passback request. */
export type GradePassbackRequest = z.infer<typeof GradePassbackRequest>;

/** What a sink delivers: the approved grade, with the approval time as its timestamp. */
export interface GradeDelivery {
  readonly column: string;
  readonly scoreGiven: number;
  readonly scoreMaximum: number;
  /** The approval's time (ISO 8601), sent as the score's timestamp. */
  readonly approvedAt: string;
  readonly comment: string | undefined;
}

/**
 * Delivers approved grades to one kind of LMS gradebook. Only {@link GradePassback} calls a sink,
 * after every check has passed, so a sink is not itself an authorization boundary for approvals;
 * it does check that the column and the student belong to the route's course.
 */
export interface GradeSink {
  /** The route kind this sink serves. The gate hands it only routes of this kind. */
  readonly via: LmsGradeRoute["via"];
  /** Refuses a column outside the route's course, or a student with no account there. */
  check(route: LmsGradeRoute, column: string, student: Principal): Promise<void>;
  /** Publishes the grade. Throws a `SchoolOsError` if the LMS does not accept it. */
  deliver(route: LmsGradeRoute, delivery: GradeDelivery, student: Principal): Promise<void>;
}

/** Narrows a route for a sink, refusing one of another kind. */
export function routeOfKind<K extends LmsGradeRoute["via"]>(route: LmsGradeRoute, via: K): Extract<LmsGradeRoute, { via: K }> {
  if (route.via !== via) throw new SchoolOsError("conflict", "The grade route is for another kind of gradebook.");
  return route as Extract<LmsGradeRoute, { via: K }>;
}

/** The outcome of a passback ledger claim. */
export type PassbackClaim =
  /** This call holds the claim and must deliver, then complete or release it. */
  | "claimed"
  /** This version was already delivered; deliver nothing. */
  | "already-posted"
  /** Another call is delivering this version now. */
  | "in-progress"
  /** A newer version is recorded, so this one must never be delivered. */
  | "stale";

/**
 * Records which grade version has been delivered to each (column, student), so a retry never posts
 * twice and an older version never follows a newer one.
 *
 * Implementations must make `claim` atomic per key, as a Durable Object or a single transaction
 * does. A claim is a lease: if its holder dies between claiming and completing, the version can be
 * claimed again once the lease ends. That re-send carries the same timestamp, so a platform that
 * received the first send treats it as the same score.
 */
export interface PassbackLedger {
  /**
   * Claims delivery of `version` for `key` until `leaseUntil`. A version is stale if a higher
   * version is recorded, or if it is higher but was approved no later than the recorded one (a
   * platform would discard it as older).
   */
  claim(key: string, version: number, approvedAtMs: number, now: number, leaseUntil: number): Promise<PassbackClaim>;
  /** Marks `version` delivered, if it is still the recorded version. */
  complete(key: string, version: number): Promise<void>;
  /** Ends the claim on `version` without delivering, so a retry can claim it again. */
  release(key: string, version: number): Promise<void>;
}

interface LedgerEntry {
  version: number;
  approvedAtMs: number;
  state: "pending" | "posted";
  leaseUntil: number;
}

/** An in-memory {@link PassbackLedger}, for tests and single-isolate development. */
export class InMemoryPassbackLedger implements PassbackLedger {
  readonly #entries = new Map<string, LedgerEntry>();

  async claim(key: string, version: number, approvedAtMs: number, now: number, leaseUntil: number): Promise<PassbackClaim> {
    const entry = this.#entries.get(key);
    if (entry !== undefined) {
      if (version < entry.version) return "stale";
      if (version === entry.version) {
        if (entry.state === "posted") return "already-posted";
        if (entry.leaseUntil > now) return "in-progress";
      } else if (approvedAtMs <= entry.approvedAtMs) {
        return "stale";
      }
    }
    this.#entries.set(key, { version, approvedAtMs, state: "pending", leaseUntil });
    return "claimed";
  }

  async complete(key: string, version: number): Promise<void> {
    const entry = this.#entries.get(key);
    if (entry !== undefined && entry.version === version) entry.state = "posted";
  }

  async release(key: string, version: number): Promise<void> {
    const entry = this.#entries.get(key);
    if (entry !== undefined && entry.version === version && entry.state === "pending") entry.leaseUntil = 0;
  }
}

/** How long a passback claim is held before another call may retry it. */
export const PASSBACK_LEASE_MS = 2 * 60_000;
/** How far in the future an approval time may be, to allow for clock skew. */
const APPROVAL_CLOCK_SKEW_MS = 60_000;

/** What {@link GradePassback} is built from. */
export interface GradePassbackOptions {
  /** The district this gate serves. */
  readonly districtId: DistrictId;
  /** The district's directory, read on every passback so a dropped teacher loses approval power. */
  readonly directory: () => Promise<DistrictDirectorySnapshot>;
  readonly routes: GradeRouteStore;
  readonly approvals: GradeApprovalStore;
  readonly ledger: PassbackLedger;
  /** One sink per route kind the deployment supports. */
  readonly sinks: readonly GradeSink[];
  readonly now?: Clock;
}

/** The outcome of an accepted passback. */
export interface PassbackResult {
  /** `posted` if this call delivered the grade, `already-posted` if an earlier call had. */
  readonly status: "posted" | "already-posted";
  readonly route: LmsGradeRoute["via"];
}

/**
 * The only path by which SchoolOS writes a grade to an LMS (roadmap I02; threat T10; "no surprise
 * gradebook writes", §15). A grade is published only if all of these hold:
 *
 * 1. The offering's grade route names an LMS. An offering with no route, or a `local` one, is
 *    refused with `conflict`: SchoolOS keeps that gradebook and sends nothing.
 * 2. A teacher approval exists for exactly this offering, student, column, version and score.
 *    Without one, as for an AI-suggested score nobody reviewed, it is a `policy-violation`.
 * 3. The approver is a staff member actively teaching (or co-teaching) the offering now, and the
 *    student is actively enrolled in it, according to the district directory.
 * 4. The column and the student's platform account belong to the route's course.
 * 5. The passback ledger has not seen this version or a newer one for this column and student.
 *    A retried version returns `already-posted` without sending; an older version is `conflict`.
 */
export class GradePassback {
  readonly #options: GradePassbackOptions;
  readonly #now: Clock;

  constructor(options: GradePassbackOptions) {
    const kinds = options.sinks.map((sink) => sink.via);
    if (new Set(kinds).size !== kinds.length) throw new SchoolOsError("conflict", "Two grade sinks serve one route kind.");
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Publishes one approved grade version. See the class documentation for every refusal. */
  async publish(input: unknown): Promise<PassbackResult> {
    const parsed = GradePassbackRequest.safeParse(input);
    if (!parsed.success) throw new SchoolOsError("validation-failed", "The grade passback request is malformed.");
    const request = parsed.data;

    const route = await this.#options.routes.routeFor(request.offeringId);
    if (route === undefined) {
      throw new SchoolOsError("conflict", "No source of record is configured for this offering's grades; nothing was sent.");
    }
    if (route.authority === "local") {
      throw new SchoolOsError("conflict", "SchoolOS keeps this offering's grades; nothing is sent to an LMS.");
    }
    const sink = this.#options.sinks.find((candidate) => candidate.via === route.via);
    if (sink === undefined) throw new SchoolOsError("unavailable", "This deployment cannot reach the offering's gradebook.");

    const approval = await this.#options.approvals.find(request);
    if (approval === undefined) {
      throw new SchoolOsError("policy-violation", "This grade has not been approved by the offering's teacher.");
    }
    if (approval.scoreGiven !== request.scoreGiven || approval.scoreMaximum !== request.scoreMaximum) {
      throw new SchoolOsError("policy-violation", "This score differs from the one the teacher approved.");
    }
    const approvedAtMs = Date.parse(approval.approvedAt);
    const now = this.#now();
    if (approvedAtMs > now + APPROVAL_CLOCK_SKEW_MS) throw new SchoolOsError("validation-failed", "The approval is dated in the future.");

    const student = await this.#checkPeople(request.offeringId, approval.approverId, request.studentId);
    await sink.check(route, request.column, student);

    const key = ledgerKey(route, request.column, request.studentId);
    const claim = await this.#options.ledger.claim(key, request.gradeVersion, approvedAtMs, now, now + PASSBACK_LEASE_MS);
    if (claim === "already-posted") return { status: "already-posted", route: route.via };
    if (claim === "stale") throw new SchoolOsError("conflict", "A newer version of this grade has already been approved.");
    if (claim === "in-progress") throw new SchoolOsError("conflict", "This grade is being sent now.");

    const delivery: GradeDelivery = {
      column: request.column,
      scoreGiven: approval.scoreGiven,
      scoreMaximum: approval.scoreMaximum,
      approvedAt: approval.approvedAt,
      comment: request.comment,
    };
    try {
      await sink.deliver(route, delivery, student);
    } catch (err) {
      await this.#options.ledger.release(key, request.gradeVersion);
      throw err;
    }
    await this.#options.ledger.complete(key, request.gradeVersion);
    return { status: "posted", route: route.via };
  }

  /** Checks the approver teaches the offering and the student is enrolled in it; returns the student. */
  async #checkPeople(offeringId: OfferingId, approverId: PrincipalId, studentId: PrincipalId): Promise<Principal> {
    const directory = await this.#options.directory();
    if (directory.district.id !== this.#options.districtId) {
      throw new SchoolOsError("unavailable", "The district directory is not available.");
    }
    if (!directory.offerings.some((offering) => offering.id === offeringId)) {
      throw new SchoolOsError("not-found", "No such offering.");
    }
    const active = (principalId: PrincipalId, roles: readonly string[]) =>
      directory.enrollments.some(
        (enrollment) =>
          enrollment.offeringId === offeringId &&
          enrollment.principalId === principalId &&
          enrollment.status === "active" &&
          roles.includes(enrollment.role),
      );
    const approver = directory.principals.find((principal) => principal.id === approverId);
    if (approver?.kind !== "staff" || !active(approverId, ["teacher", "co-teacher"])) {
      throw new SchoolOsError("policy-violation", "The approval was not given by a teacher of this offering.");
    }
    const student = directory.principals.find((principal) => principal.id === studentId);
    if (student?.kind !== "student" || !active(studentId, ["student"])) {
      throw new SchoolOsError("not-found", "The student is not enrolled in this offering.");
    }
    return student;
  }
}

/** The ledger key: one gradebook column for one student, in one LMS course. */
function ledgerKey(route: LmsGradeRoute, column: string, studentId: PrincipalId): string {
  const course =
    route.via === "lti-ags"
      ? [route.services.registration.issuer, route.services.registration.clientId, route.services.contextId]
      : [route.courseId];
  return JSON.stringify([route.via, ...course, column, studentId]);
}
