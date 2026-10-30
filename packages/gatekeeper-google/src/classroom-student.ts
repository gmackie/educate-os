import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import { CLASSROOM_STUDENT_ACTIONS, type ClassroomStudentAction } from "./classroom-actions";
import { ClassroomApi, validateClassroomCourseWorkId } from "./classroom-api";
import type {
  ClassroomStudentCourseWork, ClassroomStudentSubmission, GoogleClassroomStudentSession,
} from "./classroom-student-types";
import CLASSROOM_STUDENT_TYPES_CODE from "./classroom-student-types.txt";

type Env = Cloudflare.Env;

/** The student's Google account and one enrolled course. */
export type GoogleClassroomStudentGatekeeperImplProps = { userObjectId: string; courseId: string };

/** A personal student connection for a single Classroom course. */
@validateRpc()
export class GoogleClassroomStudentGatekeeperImpl
    extends DurableObject<Env, GoogleClassroomStudentGatekeeperImplProps>
    implements Gatekeeper<GoogleClassroomStudentSession> {
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });
  #api = new ClassroomApi((opts?: AccessTokenRequest) => this.#tokens.get(opts));
  #journal = new ActionJournal<ClassroomStudentAction>(this.ctx.storage.kv, { namespace: "classroom-student" });
  #actions = CLASSROOM_STUDENT_ACTIONS.bind(this.#journal, {
    api: this.#api, courseId: this.ctx.props.courseId,
  });

  async describe(): Promise<ResourceDescription> {
    let course = await this.#api.getCourse(this.ctx.props.courseId);
    if (!(await this.#api.isStudent(this.ctx.props.courseId))) {
      throw new Error("The connected Google account is not a student in this Classroom course.");
    }
    return {
      url: course.alternateLink ?? "https://classroom.google.com/",
      title: `Classroom student: ${course.name}`,
      snippet: `Your published coursework and submissions in ${course.name}.`,
      suggestedBindingName: "GOOGLE_CLASSROOM_STUDENT",
      tsType: "GoogleClassroomStudentSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> { return CLASSROOM_STUDENT_TYPES_CODE; }

  async getAutoApprovableActions(): Promise<ActionKind[]> { return []; }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<GoogleClassroomStudentSession> {
    return new GoogleClassroomStudentSessionImpl(
      this.#api, this.ctx.props.courseId, approvalQueue.dup(), this.#actions);
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    await this.#actions.apply(actionId);
  }

  async rejectAction(actionId: number): Promise<void> { await this.#actions.reject(actionId); }

  async revertAction(): Promise<{ message: string }> {
    return { message: "A Classroom turn-in cannot be reverted here. Reclaim the work in Google Classroom." };
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    throw new Error("A student Classroom session contains personal work and cannot be shared with collaborators.");
  }

  async removeObserver(_id: string): Promise<void> {}
}

/** One course's own-student view, with no roster, classmate submissions, or teacher configuration. */
@validateRpc()
export class GoogleClassroomStudentSessionImpl extends RpcTarget implements GoogleClassroomStudentSession {
  #api: ClassroomApi;
  #courseId: string;
  #queue: RpcStub<ApprovalQueue>;
  #actions: ReturnType<typeof CLASSROOM_STUDENT_ACTIONS.bind>;

  constructor(
    api: ClassroomApi, courseId: string, queue: RpcStub<ApprovalQueue>,
    actions: ReturnType<typeof CLASSROOM_STUDENT_ACTIONS.bind>,
  ) {
    super();
    this.#api = api;
    this.#courseId = courseId;
    this.#queue = queue;
    this.#actions = actions;
  }

  [Symbol.dispose](): void { this.#queue[Symbol.dispose](); }

  async listCourseWork(): Promise<ClassroomStudentCourseWork[]> {
    await this.#assertStudent();
    const work = await this.#api.listStudentCourseWork(this.#courseId);
    await this.#queue.authorizeObservation({
      title: "Read published Google Classroom coursework",
      description: `Read ${work.length} published assignment(s) available to the signed-in student in course ${this.#courseId}.`,
    });
    return work;
  }

  async getMySubmission(courseWorkId: string): Promise<ClassroomStudentSubmission | null> {
    validateClassroomCourseWorkId(courseWorkId);
    await this.#assertStudent();
    if (!(await this.#api.listStudentCourseWork(this.#courseId)).some(work => work.id === courseWorkId)) {
      throw new Error("This coursework is not published in the bound Classroom course.");
    }
    const submission = await this.#api.getMySubmission(this.#courseId, courseWorkId);
    await this.#queue.authorizeObservation({
      title: "Read own Google Classroom submission",
      description: `Read the signed-in student's submission state for coursework ${courseWorkId}.`,
    });
    return submission;
  }

  async turnIn(courseWorkId: string): Promise<void> {
    validateClassroomCourseWorkId(courseWorkId);
    await this.#assertStudent();
    const work = (await this.#api.listStudentCourseWork(this.#courseId))
      .find(candidate => candidate.id === courseWorkId);
    if (!work) throw new Error("This coursework is not published in the bound Classroom course.");
    const submission = await this.#api.getMySubmission(this.#courseId, courseWorkId);
    if (!submission || (submission.state !== "CREATED" && submission.state !== "RECLAIMED_BY_STUDENT")) {
      throw new Error("Only a created or reclaimed personal submission can be turned in.");
    }
    await this.#actions.submit(this.#queue, "turnIn", { courseWorkId, courseWorkTitle: work.title });
  }

  async #assertStudent(): Promise<void> {
    if (!(await this.#api.isStudent(this.#courseId))) {
      throw new Error("The connected Google account is not a student in this Classroom course.");
    }
  }
}
