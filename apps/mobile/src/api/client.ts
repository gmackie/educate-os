import type {
  Activity, Announcement, Assignment, CalendarEvent, ClassItem, Credential, DeviceSummary, GradeSummary,
  CourseOutline, DiscussionPost, Gradebook, GradeProposal, ModerationQueue, QuizResults, StaffAttempt, StaffQuizSummary, DiscussionThread, GuardianChild, GuardianCourse, Notifications, Principal,
  QuizAnswer, QuizAttempt, QuizResult, QuizSummary, Submission, TopicListing,
} from '../types';
import type { DeviceSession } from './device.ts';
import { DistrictApiError, MESSAGES, errorFrom, isRedirect } from './errors.ts';

/**
 * District API calls. Two credentials are accepted:
 * - `device` (preferred): a district-issued, key-bound credential, sent to `/api/m/*` through
 *   DeviceSession (proofs, silent refresh, revocation; see device.ts).
 * - `cloudflare-access` (legacy): an Access assertion, sent to `/api/*` as the header and cookie.
 * The Workshop's password-token session is NOT a district API credential.
 * The district always validates the credential and authorizes each request on the server.
 */
export { DistrictApiError } from './errors.ts';

export class DistrictClient {
  constructor(private readonly base: string, private readonly credential: Credential,
    private readonly device?: DeviceSession) {}

  get available(): boolean {
    return this.credential.kind === 'cloudflare-access' || (this.credential.kind === 'device' && !!this.device);
  }
  get usesDevice(): boolean { return this.credential.kind === 'device'; }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    if (this.credential.kind === 'device') {
      if (!this.device) throw new DistrictApiError(401, 'needs-pairing', MESSAGES.needsPairing);
      return this.device.request<T>(method, path, body, query);
    }
    if (this.credential.kind !== 'cloudflare-access') {
      throw new DistrictApiError(403, 'needs-access', 'Your school has not enabled native district API access.');
    }
    const token = this.credential.token;
    const url = new URL(path, this.base);
    if (!url.pathname.startsWith('/api/') || url.origin !== this.base) throw new Error('Invalid district API path.');
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method,
        // Never follow: a redirect here is Access sending the request to its login page. 'manual'
        // hands the 3xx back so it can be reported as a sign-in problem, not a network failure.
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          'cf-access-jwt-assertion': token,
          // Access's edge checks the cookie before the district Worker validates the assertion.
          cookie: 'CF_Authorization=' + token,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
    } catch {
      // Native fetch errors are not user-readable.
      throw new DistrictApiError(0, 'unreachable', MESSAGES.unreachable);
    }
    if (isRedirect(response)) throw new DistrictApiError(401, 'needs-sign-in', MESSAGES.needsSignIn);
    if (!response.ok) throw await errorFrom(response);
    return await response.json().catch(() => null) as T;
  }
  private id(value: string): string { return encodeURIComponent(value); }
  me(): Promise<Principal> { return this.call('GET', '/api/me'); }
  studentClasses(): Promise<ClassItem[]> { return this.call('GET', '/api/student/offerings'); }
  teacherClasses(): Promise<ClassItem[]> { return this.call('GET', '/api/teacher/offerings'); }
  studentActivities(offeringId: string): Promise<Activity[]> {
    return this.call('GET', '/api/student/offerings/' + this.id(offeringId) + '/activities');
  }
  studentAssignment(assignmentId: string): Promise<{ assignment: Assignment; starterMaterials: { id: string; title: string }[] }> {
    return this.call('GET', '/api/student/assignments/' + this.id(assignmentId));
  }
  studentSubmissions(assignmentId: string): Promise<Submission[]> {
    return this.call('GET', '/api/student/assignments/' + this.id(assignmentId) + '/submissions');
  }
  studentGradeSummary(offeringId: string): Promise<GradeSummary> {
    return this.call('GET', '/api/student/offerings/' + this.id(offeringId) + '/grade-summary');
  }
  studentAnnouncements(): Promise<Announcement[]> { return this.call('GET', '/api/student/announcements'); }
  notifications(): Promise<Notifications> { return this.call('GET', '/api/me/notifications'); }
  markRead(ids: string[] | 'all'): Promise<unknown> {
    return this.call('POST', '/api/me/notifications/read', ids === 'all' ? { all: true } : { ids });
  }
  calendar(from: Date, to: Date): Promise<{ events: CalendarEvent[] }> {
    return this.call('GET', '/api/me/calendar', undefined, { from: from.toISOString(), to: to.toISOString() });
  }
  teacherAssignments(offeringId: string): Promise<Assignment[]> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/assignments');
  }
  teacherSubmissions(assignmentId: string): Promise<Submission[]> {
    return this.call('GET', '/api/teacher/assignments/' + this.id(assignmentId) + '/submissions');
  }
  teacherRoster(offeringId: string): Promise<{ enrollment: { principalId: string }; displayName: string }[]> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/roster');
  }
  studentActivity(activityId: string): Promise<{ content: { overview: string; steps: { id: string; title: string; prompt: string }[] } }> {
    return this.call('GET', '/api/student/activities/' + this.id(activityId));
  }
  studentOfficialGrades(assignmentId: string): Promise<{ score: { points: number; maxPoints: number } }[]> {
    return this.call('GET', '/api/student/assignments/' + this.id(assignmentId) + '/grades');
  }
  openCourseWorkspace(offeringId: string): Promise<{ id: string }> {
    return this.call('POST', '/api/student/offerings/' + this.id(offeringId) + '/workspace');
  }
  createDocument(workspaceId: string, title: string, text: string): Promise<{
    artifact: { id: string }; head: { id: string };
  }> {
    return this.call('POST', '/api/student/artifacts', {
      workspaceId, title, type: 'document', content: { kind: 'text', text }, aiAssistance: { level: 'none' },
    });
  }
  saveDocumentRevision(artifactId: string, text: string): Promise<{ artifact: { id: string }; head: { id: string } }> {
    return this.call('POST', '/api/student/artifacts/' + this.id(artifactId) + '/revisions', {
      content: { kind: 'text', text }, aiAssistance: { level: 'none' },
    });
  }
  /** An uploaded photo or PDF (`bytes` content; the district checks the type and the 5 MiB limit). */
  createUpload(workspaceId: string, title: string, type: 'image' | 'evidence', mediaType: 'image/jpeg' | 'image/png' | 'application/pdf',
    base64: string): Promise<{ artifact: { id: string }; head: { id: string } }> {
    return this.call('POST', '/api/student/artifacts', {
      workspaceId, title, type, content: { kind: 'bytes', mediaType, base64 }, aiAssistance: { level: 'none' },
    });
  }
  withdrawSubmission(submissionId: string): Promise<unknown> {
    return this.call('POST', '/api/student/submissions/' + this.id(submissionId) + '/withdraw');
  }
  starterMaterial(assignmentId: string, materialId: string): Promise<{
    material: { id: string; title: string }; content: { kind: 'text'; text: string } | { kind: 'bytes'; base64: string } | { kind: 'external'; url: string };
  }> {
    return this.call('GET', '/api/student/assignments/' + this.id(assignmentId) + '/starter-materials/' + this.id(materialId));
  }
  submitDocument(assignmentId: string, revision: { artifactId: string; revisionId: string }): Promise<{ submissionId: string }> {
    return this.call('POST', '/api/student/assignments/' + this.id(assignmentId) + '/submissions',
      { revisions: [revision] });
  }
  teacherAssignment(assignmentId: string): Promise<{ assignment: Assignment }> {
    return this.call('GET', '/api/teacher/assignments/' + this.id(assignmentId));
  }
  teacherSubmittedContent(submissionId: string, artifactId: string): Promise<{
    title?: string; content: { kind: string; text?: string; base64?: string };
  }> {
    return this.call('GET', '/api/teacher/submissions/' + this.id(submissionId) + '/artifacts/' + this.id(artifactId));
  }
  studentAssignmentFeedback(assignmentId: string): Promise<{ comments: { body: string }[]; state: string }[]> {
    return this.call('GET', '/api/student/assignments/' + this.id(assignmentId) + '/feedback');
  }
  teacherFeedback(submissionId: string): Promise<{ comments: { body: string }[]; state?: string }> {
    return this.call('GET', '/api/teacher/submissions/' + this.id(submissionId) + '/feedback');
  }
  teacherComment(submissionId: string, body: string): Promise<unknown> {
    return this.call('POST', '/api/teacher/submissions/' + this.id(submissionId) + '/comments', { body });
  }
  teacherRecordGrade(submissionId: string, points: number, maxPoints: number): Promise<{ status: 'official' | 'pending-approval' }> {
    return this.call('POST', '/api/teacher/submissions/' + this.id(submissionId) + '/grade', {
      score: { points, maxPoints },
    });
  }
  teacherReleaseFeedback(submissionId: string, state: 'shared-with-student' | 'final'): Promise<unknown> {
    return this.call('POST', '/api/teacher/submissions/' + this.id(submissionId) + '/feedback/release', { state });
  }
  // Course content (SCHO-186, 189, 190, 191): modules and pages, announcements, discussions, quizzes.
  studentModules(offeringId: string): Promise<CourseOutline> {
    return this.call('GET', '/api/student/offerings/' + this.id(offeringId) + '/modules');
  }
  teacherModules(offeringId: string): Promise<CourseOutline> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/modules');
  }
  studentCourseAnnouncements(offeringId: string): Promise<Announcement[]> {
    return this.call('GET', '/api/student/offerings/' + this.id(offeringId) + '/announcements');
  }
  discussions(role: 'student' | 'teacher', offeringId: string): Promise<TopicListing> {
    return this.call('GET', '/api/' + role + '/offerings/' + this.id(offeringId) + '/discussions');
  }
  discussionThread(role: 'student' | 'teacher', offeringId: string, topicId: string): Promise<DiscussionThread> {
    return this.call('GET', '/api/' + role + '/offerings/' + this.id(offeringId) + '/discussions/' + this.id(topicId));
  }
  createPost(role: 'student' | 'teacher', offeringId: string, topicId: string, body: string, parentId?: string): Promise<DiscussionPost> {
    return this.call('POST', '/api/' + role + '/offerings/' + this.id(offeringId) + '/discussions/' + this.id(topicId) + '/posts',
      parentId ? { body, parentId } : { body });
  }
  reportPost(offeringId: string, postId: string, reason: 'unkind' | 'unsafe' | 'off-topic' | 'other'): Promise<unknown> {
    return this.call('POST', '/api/student/offerings/' + this.id(offeringId) + '/posts/' + this.id(postId) + '/report', { reason });
  }
  studentQuizzes(offeringId: string): Promise<QuizSummary[]> {
    return this.call('GET', '/api/student/offerings/' + this.id(offeringId) + '/quizzes');
  }
  studentQuiz(offeringId: string, quizId: string): Promise<QuizSummary> {
    return this.call('GET', '/api/student/offerings/' + this.id(offeringId) + '/quizzes/' + this.id(quizId));
  }
  startQuizAttempt(offeringId: string, quizId: string): Promise<QuizAttempt> {
    return this.call('POST', '/api/student/offerings/' + this.id(offeringId) + '/quizzes/' + this.id(quizId) + '/attempts');
  }
  quizAttempt(offeringId: string, attemptId: string): Promise<QuizAttempt> {
    return this.call('GET', '/api/student/offerings/' + this.id(offeringId) + '/quiz-attempts/' + this.id(attemptId));
  }
  saveQuizAnswers(offeringId: string, attemptId: string, answers: QuizAnswer[]): Promise<unknown> {
    return this.call('POST', '/api/student/offerings/' + this.id(offeringId) + '/quiz-attempts/' + this.id(attemptId) + '/answers', { answers });
  }
  submitQuizAttempt(offeringId: string, attemptId: string, answers: QuizAnswer[]): Promise<QuizResult> {
    return this.call('POST', '/api/student/offerings/' + this.id(offeringId) + '/quiz-attempts/' + this.id(attemptId) + '/submit', { answers });
  }
  quizResult(offeringId: string, attemptId: string): Promise<QuizResult> {
    return this.call('GET', '/api/student/offerings/' + this.id(offeringId) + '/quiz-attempts/' + this.id(attemptId) + '/result');
  }
  // Teaching (SCHO-272): what Teacher Studio does day to day, from the phone.
  teacherGradebook(offeringId: string): Promise<Gradebook> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/gradebook');
  }
  teacherAnnouncements(offeringId: string): Promise<Announcement[]> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/announcements');
  }
  createAnnouncement(offeringId: string, title: string, body: string): Promise<Announcement> {
    return this.call('POST', '/api/teacher/offerings/' + this.id(offeringId) + '/announcements', { title, body });
  }
  weeklyNote(offeringId: string): Promise<{ week: string; note: { text: string } | null }> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/weekly-note');
  }
  setWeeklyNote(offeringId: string, text: string): Promise<{ week: string; note: { text: string } | null }> {
    return this.call('POST', '/api/teacher/offerings/' + this.id(offeringId) + '/weekly-note', { text });
  }
  teacherQuizzes(offeringId: string): Promise<{ quizzes: StaffQuizSummary[] }> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/quizzes');
  }
  quizResults(offeringId: string, quizId: string): Promise<QuizResults> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/quizzes/' + this.id(quizId) + '/results');
  }
  staffQuizAttempt(offeringId: string, attemptId: string): Promise<StaffAttempt> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/quiz-attempts/' + this.id(attemptId));
  }
  gradeQuizItem(offeringId: string, attemptId: string, itemId: string, points: number, comment?: string): Promise<StaffAttempt> {
    return this.call('POST', '/api/teacher/offerings/' + this.id(offeringId) + '/quiz-attempts/' + this.id(attemptId) + '/items/' +
      this.id(itemId) + '/grade', comment ? { points, comment } : { points });
  }
  releaseQuizScores(offeringId: string, quizId: string): Promise<{ official: number }> {
    return this.call('POST', '/api/teacher/offerings/' + this.id(offeringId) + '/quizzes/' + this.id(quizId) + '/release');
  }
  moderationQueue(offeringId: string): Promise<ModerationQueue> {
    return this.call('GET', '/api/teacher/offerings/' + this.id(offeringId) + '/discussion-moderation');
  }
  moderatePost(offeringId: string, postId: string, decision: 'approve' | 'hide' | 'unhide' | 'remove' | 'dismiss-flags'): Promise<DiscussionPost> {
    return this.call('POST', '/api/teacher/offerings/' + this.id(offeringId) + '/posts/' + this.id(postId) + '/moderation', { decision });
  }
  updateAssignment(assignmentId: string, patch: { dueAt?: string; attemptsAllowed?: number }): Promise<Assignment> {
    return this.call('POST', '/api/teacher/assignments/' + this.id(assignmentId), patch);
  }
  gradeProposals(assignmentId: string): Promise<GradeProposal[]> {
    return this.call('GET', '/api/teacher/assignments/' + this.id(assignmentId) + '/grade-proposals');
  }
  approveGrade(proposalId: string): Promise<unknown> {
    return this.call('POST', '/api/teacher/grade-proposals/' + this.id(proposalId) + '/approve');
  }
  declineGrade(proposalId: string, reason: string): Promise<unknown> {
    return this.call('POST', '/api/teacher/grade-proposals/' + this.id(proposalId) + '/decline', { reason });
  }
  guardianChildren(): Promise<GuardianChild[]> { return this.call('GET', '/api/guardian/children'); }
  guardianClasses(studentId: string): Promise<ClassItem[]> {
    return this.call('GET', '/api/guardian/children/' + this.id(studentId) + '/offerings');
  }
  guardianClass(studentId: string, offeringId: string): Promise<GuardianCourse> {
    return this.call('GET', '/api/guardian/children/' + this.id(studentId) + '/offerings/' + this.id(offeringId));
  }
  /** Your devices (SCHO-261). Device credentials only: these are `/api/m/me/devices…`. */
  myDevices(): Promise<{ devices: DeviceSummary[] }> { return this.call('GET', '/api/me/devices'); }
  revokeDevice(deviceId: string): Promise<DeviceSummary> {
    return this.call('POST', '/api/me/devices/' + this.id(deviceId) + '/revoke');
  }
  /** Registers this phone's Expo push token. A district without push answers 404, which is fine. */
  async registerPushToken(token: string, platform: string): Promise<'registered' | 'unsupported'> {
    try {
      await this.call('POST', '/api/me/devices/push-token', { token, provider: 'expo', platform });
      return 'registered';
    } catch (e) {
      if (e instanceof DistrictApiError && (e.status === 404 || e.status === 405)) return 'unsupported';
      throw e;
    }
  }
}
