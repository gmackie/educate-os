// The agent-facing sessions. Each holds no authority of its own: who the user is comes from the
// connected account, what they reach is checked on every call (`clever-access.ts`), every read is
// authorized as an observation before its data is returned, and every change is submitted for
// approval and only made once approved (`clever-actions.ts`), meanwhile shown to reads as made.

import { RpcTarget, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { JournalEntry } from "@gadgets/gatekeeper-kit/actions";
import { escapeObservationValue, type ObservationGate, type ObservationScope } from "@gadgets/gatekeeper-kit/observers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { CleverAccess, CleverDistrictContext, SectionRole } from "./clever-access";
import type { CleverAction, CleverActions } from "./clever-actions";
import type { CleverSectionRecord } from "./clever-api";
import { CLEVER_ID } from "./clever-env";
import { invalid, notFound } from "./clever-errors";
import type { CleverDistrictLedger, RegisteredAssignment } from "./clever-ledger";
import { nameOf, rolesOf, schoolIdsOf, toRosterMember } from "./clever-model";
import { TEACHER_TOOLS, runTool, type ToolHandlers } from "./clever-tools";
import type {
  CleverAssignment, CleverAssignmentDraft, CleverDistrictSession, CleverMySubmission, CleverProfile,
  CleverProfileSession, CleverRoster, CleverRosterMember, CleverSection, CleverSectionSession,
  CleverStudentAssignment, CleverStudentSectionSession, CleverStudentSession, CleverSubmission,
  CleverTeacherSession, CleverToolCallResult, CleverToolInfo,
} from "./types";

/** The ID a creation awaiting approval is listed under: `pending:create:{n}`. */
export const PENDING_CREATE_PREFIX = "pending:create:";

const MAX_TITLE = 3000;
const MAX_TEXT = 30_000;

/** What a binding's sessions run against; the gatekeeper Durable Object supplies it. */
export type BindingHost = {
  /** The roster a section must list the user on. */
  role: SectionRole;
  access: CleverAccess;
  ledger(districtId: string): DurableObjectStub<CleverDistrictLedger>;
  /** The changes awaiting a decision, oldest first. */
  pending(): readonly JournalEntry<CleverAction>[];
  /** Queues a change for approval. */
  submit<K extends keyof CleverActions>(queue: RpcStub<ApprovalQueue>, kind: K, payload: CleverActions[K]): Promise<number>;
  /** What a read of one section's data discloses, for the binding's observer strategy. */
  sectionScope(sectionId: string): ObservationScope;
  /** What a listing of sections discloses. */
  listScope(sectionIds: readonly string[]): ObservationScope;
  /** Records a read or change in the district audit log; present only on the district-wide connection. */
  audit?(userId: string, districtId: string, action: string, target: string): Promise<void>;
};

/** One section's operations, shared by every binding that reaches a section. */
export class SectionCore {
  readonly #host: BindingHost;
  readonly #sectionId: string;
  readonly #gate: ObservationGate;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(host: BindingHost, sectionId: string, gate: ObservationGate, queue: RpcStub<ApprovalQueue>) {
    this.#host = host;
    this.#sectionId = sectionId;
    this.#gate = gate;
    this.#queue = queue;
  }

  async getSection(): Promise<CleverSection> {
    const { context, section } = await this.#reach();
    const result = await context.directory.toSection(section);
    await this.#observe(context, "read:section", this.#target(), {
      title: "Read Clever section",
      description: `Read the details of Clever section **${escapeObservationValue(section.name)}**.`,
    });
    return result;
  }

  async getRoster(): Promise<CleverRoster> {
    const { context, section } = await this.#reach();
    const [teachers, students] = await Promise.all([
      context.api.sectionUsers(section.id, "teacher"),
      context.api.sectionUsers(section.id, "student"),
    ]);
    const roster: CleverRoster = {
      teachers: teachers.filter(user => section.teachers.includes(user.id)).map(toRosterMember),
      students: students.filter(user => section.students.includes(user.id)).map(toRosterMember),
    };
    await this.#observe(context, "read:roster", this.#target(), {
      title: "Read Clever roster",
      description:
        `Read the roster of Clever section **${escapeObservationValue(section.name)}**: ` +
        `${roster.teachers.length} teacher(s) and ${roster.students.length} student(s), by name and grade.`,
    });
    return roster;
  }

  async listAssignments(): Promise<CleverAssignment[]> {
    const { context, section } = await this.#reach();
    const registered = await this.#host.ledger(context.identity.districtId).listAssignments(section.id);
    const assignments = [...registered.map(toAssignment), ...this.#pendingCreations()];
    await this.#observe(context, "read:assignments", this.#target(), {
      title: "List Clever assignments",
      description:
        `List the ${assignments.length} assignment(s) created through this connection in Clever section ` +
        `**${escapeObservationValue(section.name)}**.`,
    });
    return assignments;
  }

  async getAssignment(assignmentId: string): Promise<CleverAssignment> {
    const pending = this.#pendingCreation(assignmentId);
    const { context, section } = await this.#reach();
    let assignment: CleverAssignment;
    if (pending) {
      assignment = pending;
    } else {
      const registered = await this.#registered(context, section, assignmentId);
      const live = await context.api.assignment(section.id, assignmentId);
      if (live === undefined) throw notFound("assignment");
      assignment = {
        id: live.id,
        title: live.title,
        ...(live.description === undefined ? {} : { description: live.description }),
        pointsPossible: live.pointsPossible ?? registered.pointsPossible,
        ...(live.dueDate === undefined ? {} : { dueDate: new Date(live.dueDate) }),
      };
    }
    await this.#observe(context, "read:assignment", this.#target(assignmentId), {
      title: "Read Clever assignment",
      description: `Read assignment ${assignmentId} of Clever section **${escapeObservationValue(section.name)}**.`,
    });
    return assignment;
  }

  async createAssignment(draft: CleverAssignmentDraft): Promise<void> {
    const payload = validateDraft(draft);
    const { context, section } = await this.#reach();
    await this.#host.submit(this.#queue, "createAssignment", { sectionId: section.id, sectionName: section.name, draft: payload });
    await this.#host.audit?.(context.identity.userId, context.identity.districtId, "request:create-assignment", this.#target());
  }

  async listSubmissions(assignmentId: string, options: { studentId?: string } = {}): Promise<CleverSubmission[]> {
    const studentId = options.studentId;
    if (studentId !== undefined && !CLEVER_ID.test(studentId)) throw notFound("student");
    const pending = this.#pendingCreation(assignmentId);
    const { context, section } = await this.#reach();
    let submissions: CleverSubmission[];
    if (pending) {
      // An assignment awaiting creation has no submissions yet.
      submissions = [];
    } else {
      await this.#registered(context, section, assignmentId);
      if (studentId !== undefined && !section.students.includes(studentId)) throw notFound("student");
      const records = studentId === undefined
        ? await context.api.submissions(section.id, assignmentId)
        : [await context.api.submission(section.id, assignmentId, studentId)].filter(record => record !== undefined);
      const grades = new Map<string, { points: number; comment?: string }>();
      for (const { action } of this.#host.pending()) {
        if (action.kind === "setGrade" && action.payload.sectionId === section.id && action.payload.assignmentId === assignmentId) {
          grades.set(action.payload.studentId, {
            points: action.payload.points,
            ...(action.payload.comment === undefined ? {} : { comment: action.payload.comment }),
          });
        }
      }
      submissions = records
        // Only the section's current students: a submission of someone since removed is not shown.
        .filter(record => section.students.includes(record.userId))
        .map(record => {
          const grade = grades.get(record.userId);
          const base: CleverSubmission = {
            studentId: record.userId,
            state: record.state,
            ...(record.gradePoints === undefined ? {} : { points: record.gradePoints }),
            ...(record.gradeComment === undefined ? {} : { comment: record.gradeComment }),
          };
          if (grade === undefined) return base;
          const { comment: _comment, ...rest } = base;
          return { ...rest, points: grade.points, ...(grade.comment === undefined ? {} : { comment: grade.comment }), pending: true };
        });
    }
    await this.#observe(context, "read:submissions", this.#target(assignmentId, studentId), {
      title: "List Clever submissions",
      description:
        `List ${submissions.length} submission(s), with their grades, for assignment ${assignmentId} of Clever ` +
        `section **${escapeObservationValue(section.name)}**.`,
    });
    return submissions;
  }

  async setGrade(assignmentId: string, studentId: string, points: number, comment?: string): Promise<void> {
    if (typeof points !== "number" || !Number.isFinite(points)) throw invalid("points must be a number.");
    if (comment !== undefined && (typeof comment !== "string" || comment.length > MAX_TEXT)) {
      throw invalid(`comment must be text of at most ${MAX_TEXT} characters.`);
    }
    if (this.#pendingCreation(assignmentId)) {
      throw invalid("This assignment is not created yet. Once its creation is approved, grade it.");
    }
    if (!CLEVER_ID.test(studentId)) throw notFound("student");
    const { context, section } = await this.#reach();
    const registered = await this.#registered(context, section, assignmentId);
    if (!section.students.includes(studentId)) throw notFound("student");
    const live = await context.api.assignment(section.id, assignmentId);
    if (live === undefined) throw notFound("assignment");
    const pointsPossible = live.pointsPossible ?? registered.pointsPossible;
    if (points < 0 || points > pointsPossible) {
      throw invalid(`points must be between 0 and the assignment's pointsPossible, ${pointsPossible}.`);
    }
    const student = await context.api.user(studentId);
    await this.#host.submit(this.#queue, "setGrade", {
      sectionId: section.id,
      sectionName: section.name,
      assignmentId,
      assignmentTitle: live.title,
      pointsPossible,
      studentId,
      studentName: nameOf(student),
      points,
      ...(comment === undefined ? {} : { comment }),
    });
    await this.#host.audit?.(context.identity.userId, context.identity.districtId, "request:set-grade", this.#target(assignmentId, studentId));
  }

  async #reach(): Promise<{ context: CleverDistrictContext; section: CleverSectionRecord }> {
    return this.#host.access.section(this.#host.role, this.#sectionId);
  }

  async #registered(context: CleverDistrictContext, section: CleverSectionRecord, assignmentId: string): Promise<RegisteredAssignment> {
    if (!CLEVER_ID.test(assignmentId)) throw notFound("assignment");
    const registered = await this.#host.ledger(context.identity.districtId).getAssignment(section.id, assignmentId);
    if (registered === null) throw notFound("assignment");
    return registered;
  }

  #pendingCreations(): CleverAssignment[] {
    return this.#host.pending().flatMap(({ id, action }) => {
      if (action.kind !== "createAssignment" || action.payload.sectionId !== this.#sectionId) return [];
      const { title, description, pointsPossible, dueDate } = action.payload.draft;
      return [{
        id: `${PENDING_CREATE_PREFIX}${id}`, title, pointsPossible,
        ...(description === undefined ? {} : { description }),
        ...(dueDate === undefined ? {} : { dueDate: new Date(dueDate) }),
        pending: true as const,
      }];
    });
  }

  /** The creation awaiting approval an ID names, or undefined for an ID of an assignment that exists. */
  #pendingCreation(assignmentId: string): CleverAssignment | undefined {
    if (!assignmentId.startsWith(PENDING_CREATE_PREFIX)) return undefined;
    const found = this.#pendingCreations().find(({ id }) => id === assignmentId);
    if (!found) throw notFound("assignment");
    return found;
  }

  #target(assignmentId?: string, studentId?: string): string {
    return [`section:${this.#sectionId}`, assignmentId && `assignment:${assignmentId}`, studentId && `student:${studentId}`]
      .filter(Boolean).join("/");
  }

  async #observe(context: CleverDistrictContext, action: string, target: string, description: { title: string; description: string }) {
    await this.#gate.authorize(description, this.#host.sectionScope(this.#sectionId));
    await this.#host.audit?.(context.identity.userId, context.identity.districtId, action, target);
  }
}

function toAssignment(registered: RegisteredAssignment): CleverAssignment {
  return {
    id: registered.assignmentId,
    title: registered.title,
    ...(registered.description === undefined ? {} : { description: registered.description }),
    pointsPossible: registered.pointsPossible,
    ...(registered.dueDate === undefined ? {} : { dueDate: new Date(registered.dueDate) }),
  };
}

/** Checks a draft and returns the payload stored for approval. */
export function validateDraft(draft: CleverAssignmentDraft) {
  if (typeof draft !== "object" || draft === null) throw invalid("The assignment is missing.");
  const title = typeof draft.title === "string" ? draft.title.trim() : "";
  if (title === "" || title.length > MAX_TITLE) throw invalid(`title is required, at most ${MAX_TITLE} characters.`);
  if (draft.description !== undefined && (typeof draft.description !== "string" || draft.description.length > MAX_TEXT)) {
    throw invalid(`description must be text of at most ${MAX_TEXT} characters.`);
  }
  const points = draft.pointsPossible;
  if (typeof points !== "number" || !Number.isFinite(points) || points <= 0) throw invalid("pointsPossible must be a positive number.");
  let dueDate: string | undefined;
  if (draft.dueDate !== undefined) {
    const due = draft.dueDate instanceof Date ? draft.dueDate : new Date(Number.NaN);
    if (Number.isNaN(due.valueOf())) throw invalid("dueDate must be a valid date.");
    dueDate = due.toISOString();
  }
  return {
    title,
    ...(draft.description === undefined ? {} : { description: draft.description }),
    pointsPossible: points,
    ...(dueDate === undefined ? {} : { dueDate }),
  };
}

/** One section, as its own capability. Owns the stubs it was given and releases them when disposed. */
@validateRpc()
export class CleverSectionSessionImpl extends RpcTarget implements CleverSectionSession {
  readonly #core: SectionCore;
  readonly #gate: ObservationGate;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(host: BindingHost, sectionId: string, gate: ObservationGate, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gate = gate;
    this.#queue = queue;
    this.#core = new SectionCore(host, sectionId, gate, queue);
  }

  [Symbol.dispose](): void {
    this.#gate[Symbol.dispose]();
    this.#queue[Symbol.dispose]();
  }

  getSection(): Promise<CleverSection> { return this.#core.getSection(); }
  getRoster(): Promise<CleverRoster> { return this.#core.getRoster(); }
  listAssignments(): Promise<CleverAssignment[]> { return this.#core.listAssignments(); }
  getAssignment(assignmentId: string): Promise<CleverAssignment> { return this.#core.getAssignment(assignmentId); }
  createAssignment(draft: CleverAssignmentDraft): Promise<void> { return this.#core.createAssignment(draft); }
  listSubmissions(assignmentId: string, options?: { studentId?: string }): Promise<CleverSubmission[]> {
    return this.#core.listSubmissions(assignmentId, options);
  }
  setGrade(assignmentId: string, studentId: string, points: number, comment?: string): Promise<void> {
    return this.#core.setGrade(assignmentId, studentId, points, comment);
  }
}

/** Every section the signed-in teacher teaches. */
@validateRpc()
export class CleverTeacherSessionImpl extends RpcTarget implements CleverTeacherSession {
  readonly #host: BindingHost;
  readonly #gate: ObservationGate;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(host: BindingHost, gate: ObservationGate, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#host = host;
    this.#gate = gate;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    this.#gate[Symbol.dispose]();
    this.#queue[Symbol.dispose]();
  }

  async listSections(): Promise<CleverSection[]> {
    const context = await this.#host.access.context();
    const { userId, districtId } = context.identity;
    const taught = (await context.api.userSections(userId))
      .filter(section => section.district === districtId && section.teachers.includes(userId));
    const sections = await context.directory.currentSections(taught);
    await this.#gate.authorize({
      title: "List Clever sections",
      description: `List the ${sections.length} Clever section(s) the signed-in teacher teaches this term and later.`,
    }, this.#host.listScope(sections.map(section => section.id)));
    return sections;
  }

  async section(sectionId: string): Promise<CleverSectionSession> {
    await this.#host.access.section(this.#host.role, sectionId);
    return new CleverSectionSessionImpl(this.#host, sectionId, this.#gate.lease(), this.#queue.dup());
  }

  async listTools(): Promise<CleverToolInfo[]> {
    return TEACHER_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<CleverToolCallResult> {
    const core = (sectionId: string) => new SectionCore(this.#host, sectionId, this.#gate, this.#queue);
    const handlers: ToolHandlers = {
      listSections: () => this.listSections(),
      section: async sectionId => {
        // Refused here, as section() refuses it, before any of the section's operations runs.
        await this.#host.access.section(this.#host.role, sectionId);
        return core(sectionId);
      },
    };
    return runTool(handlers, name, args ?? {});
  }
}

/** The signed-in user's own profile. */
@validateRpc()
export class CleverProfileSessionImpl extends RpcTarget implements CleverProfileSession {
  readonly #access: CleverAccess;
  readonly #gate: ObservationGate;

  constructor(access: CleverAccess, gate: ObservationGate) {
    super();
    this.#access = access;
    this.#gate = gate;
  }

  [Symbol.dispose](): void {
    this.#gate[Symbol.dispose]();
  }

  async getProfile(): Promise<CleverProfile> {
    const { context, user } = await this.#access.self();
    const [district, schools] = await Promise.all([
      context.api.district(context.identity.districtId),
      Promise.all(schoolIdsOf(user).map(id => context.directory.school(id).catch(() => undefined))),
    ]);
    const profile: CleverProfile = {
      id: user.id,
      name: nameOf(user),
      roles: rolesOf(user),
      districtName: district.name,
      schools: schools.filter(school => school !== undefined && school.district === context.identity.districtId)
        .map(school => ({ id: school!.id, name: school!.name })),
    };
    await this.#gate.authorize({
      title: "Read Clever profile",
      description: "Read the signed-in user's Clever name, roles, district and schools.",
    }, { kind: "baseline" });
    return profile;
  }
}

/** One section the signed-in student is enrolled in, showing only their own work. */
export class StudentSectionCore {
  readonly #host: BindingHost;
  readonly #sectionId: string;
  readonly #gate: ObservationGate;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(host: BindingHost, sectionId: string, gate: ObservationGate, queue: RpcStub<ApprovalQueue>) {
    this.#host = host;
    this.#sectionId = sectionId;
    this.#gate = gate;
    this.#queue = queue;
  }

  async getSection(): Promise<CleverSection> {
    const { context, section } = await this.#reach();
    const result = await context.directory.toSection(section);
    await this.#gate.authorize({
      title: "Read Clever class",
      description: `Read the details of Clever section **${escapeObservationValue(section.name)}**, which the signed-in student is enrolled in.`,
    }, { kind: "baseline" });
    return result;
  }

  async getTeachers(): Promise<CleverRosterMember[]> {
    const { context, section } = await this.#reach();
    const teachers = (await context.api.sectionUsers(section.id, "teacher"))
      .filter(user => section.teachers.includes(user.id))
      .map(user => ({ id: user.id, name: nameOf(user) }));
    await this.#gate.authorize({
      title: "Read Clever class teachers",
      description: `Read the ${teachers.length} teacher(s) of Clever section **${escapeObservationValue(section.name)}**.`,
    }, { kind: "baseline" });
    return teachers;
  }

  async listAssignments(): Promise<CleverStudentAssignment[]> {
    const { context, section } = await this.#reach();
    const assignments = (await this.#host.ledger(context.identity.districtId).listAssignments(section.id))
      .map(({ assignmentId, title, description, pointsPossible, dueDate }) => ({
        id: assignmentId, title, pointsPossible,
        ...(description === undefined ? {} : { description }),
        ...(dueDate === undefined ? {} : { dueDate: new Date(dueDate) }),
      }));
    await this.#gate.authorize({
      title: "List Clever class assignments",
      description: `List the ${assignments.length} assignment(s) posted through EducateOS to Clever section **${escapeObservationValue(section.name)}**.`,
    }, { kind: "baseline" });
    return assignments;
  }

  async getMySubmission(assignmentId: string): Promise<CleverMySubmission> {
    const submission = await this.#mySubmission(assignmentId);
    await this.#gate.authorize({
      title: "Read own Clever submission",
      description: `Read the signed-in student's own submission for assignment ${assignmentId}.`,
    }, { kind: "baseline" });
    return submission;
  }

  async turnIn(assignmentId: string): Promise<void> {
    const { registered, section, submission } = await this.#mySubmissionFull(assignmentId);
    if (submission.state !== "created" && submission.state !== "reclaimed") {
      throw invalid("This work is already turned in.");
    }
    await this.#host.submit(this.#queue, "turnIn", {
      sectionId: section.id, sectionName: section.name, assignmentId, assignmentTitle: registered.title,
    });
  }

  async #mySubmission(assignmentId: string): Promise<CleverMySubmission> {
    return (await this.#mySubmissionFull(assignmentId)).submission;
  }

  /** The student's own submission, with a turn-in awaiting approval shown as made. */
  async #mySubmissionFull(assignmentId: string) {
    if (!CLEVER_ID.test(assignmentId)) throw notFound("assignment");
    const { context, section } = await this.#reach();
    const registered = await this.#host.ledger(context.identity.districtId).getAssignment(section.id, assignmentId);
    if (registered === null) throw notFound("assignment");
    const record = await context.api.submission(section.id, assignmentId, context.identity.userId);
    if (record === undefined || record.userId !== context.identity.userId) throw notFound("submission");
    const turnedIn = this.#host.pending().some(({ action }) =>
      action.kind === "turnIn" && action.payload.sectionId === section.id && action.payload.assignmentId === assignmentId);
    const state = turnedIn ? "submitted" : record.state;
    // Points and the teacher's comment only once the work is returned.
    const submission: CleverMySubmission = state === "returned"
      ? {
        state,
        ...(record.gradePoints === undefined ? {} : { points: record.gradePoints }),
        ...(record.gradeComment === undefined ? {} : { comment: record.gradeComment }),
      }
      : { state };
    return { registered, section, submission };
  }

  async #reach() {
    return this.#host.access.section("student", this.#sectionId);
  }
}

/** One enrolled section, as its own capability. */
@validateRpc()
export class CleverStudentSectionSessionImpl extends RpcTarget implements CleverStudentSectionSession {
  readonly #core: StudentSectionCore;
  readonly #gate: ObservationGate;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(host: BindingHost, sectionId: string, gate: ObservationGate, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#gate = gate;
    this.#queue = queue;
    this.#core = new StudentSectionCore(host, sectionId, gate, queue);
  }

  [Symbol.dispose](): void {
    this.#gate[Symbol.dispose]();
    this.#queue[Symbol.dispose]();
  }

  getSection(): Promise<CleverSection> { return this.#core.getSection(); }
  getTeachers(): Promise<CleverRosterMember[]> { return this.#core.getTeachers(); }
  listAssignments(): Promise<CleverStudentAssignment[]> { return this.#core.listAssignments(); }
  getMySubmission(assignmentId: string): Promise<CleverMySubmission> { return this.#core.getMySubmission(assignmentId); }
  turnIn(assignmentId: string): Promise<void> { return this.#core.turnIn(assignmentId); }
}

/** Every section the signed-in student is enrolled in. */
@validateRpc()
export class CleverStudentSessionImpl extends RpcTarget implements CleverStudentSession {
  readonly #host: BindingHost;
  readonly #gate: ObservationGate;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(host: BindingHost, gate: ObservationGate, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#host = host;
    this.#gate = gate;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    this.#gate[Symbol.dispose]();
    this.#queue[Symbol.dispose]();
  }

  async listSections(): Promise<CleverSection[]> {
    const context = await this.#host.access.context();
    const { userId, districtId } = context.identity;
    const enrolled = (await context.api.userSections(userId))
      .filter(section => section.district === districtId && section.students.includes(userId));
    const sections = await context.directory.currentSections(enrolled);
    await this.#gate.authorize({
      title: "List Clever classes",
      description: `List the ${sections.length} Clever section(s) the signed-in student is enrolled in this term and later.`,
    }, { kind: "baseline" });
    return sections;
  }

  async section(sectionId: string): Promise<CleverStudentSectionSession> {
    await this.#host.access.section("student", sectionId);
    return new CleverStudentSectionSessionImpl(this.#host, sectionId, this.#gate.lease(), this.#queue.dup());
  }
}

/** Every section of the signed-in administrator's district, every use of it audited. */
@validateRpc()
export class CleverDistrictSessionImpl extends RpcTarget implements CleverDistrictSession {
  readonly #host: BindingHost;
  readonly #gate: ObservationGate;
  readonly #queue: RpcStub<ApprovalQueue>;

  constructor(host: BindingHost, gate: ObservationGate, queue: RpcStub<ApprovalQueue>) {
    super();
    this.#host = host;
    this.#gate = gate;
    this.#queue = queue;
  }

  [Symbol.dispose](): void {
    this.#gate[Symbol.dispose]();
    this.#queue[Symbol.dispose]();
  }

  async listSections(options: { schoolId?: string } = {}): Promise<CleverSection[]> {
    const { context } = await this.#host.access.requireAdmin();
    const { districtId, userId } = context.identity;
    const schoolId = options.schoolId;
    let records: CleverSectionRecord[];
    if (schoolId !== undefined) {
      const school = await context.api.school(schoolId);
      if (school.district !== districtId) throw notFound("school");
      records = await context.api.schoolSections(schoolId);
    } else {
      records = await context.api.sections();
    }
    records = records.filter(section => section.district === districtId);
    if (records.length > 20) await context.directory.preload();
    const sections = await context.directory.currentSections(records);
    await this.#gate.authorize({
      title: "List Clever district sections",
      description: `List ${sections.length} section(s) of the district${schoolId === undefined ? "" : ` in school ${schoolId}`}, this term and later.`,
    }, { kind: "baseline" });
    await this.#host.audit?.(userId, districtId, "read:sections", schoolId === undefined ? `district:${districtId}` : `school:${schoolId}`);
    return sections;
  }

  async listSchools(): Promise<{ id: string; name: string }[]> {
    const { context } = await this.#host.access.requireAdmin();
    const { districtId, userId } = context.identity;
    const schools = (await context.api.schools())
      .filter(school => school.district === districtId)
      .map(({ id, name }) => ({ id, name }));
    await this.#gate.authorize({
      title: "List Clever schools",
      description: `List the district's ${schools.length} school(s).`,
    }, { kind: "baseline" });
    await this.#host.audit?.(userId, districtId, "read:schools", `district:${districtId}`);
    return schools;
  }

  async section(sectionId: string): Promise<CleverSectionSession> {
    await this.#host.access.section("district", sectionId);
    return new CleverSectionSessionImpl(this.#host, sectionId, this.#gate.lease(), this.#queue.dup());
  }
}
