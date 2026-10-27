import type {
  Activity, Announcement, Assignment, CalendarEvent, ClassItem, Credential, GradeSummary,
  GuardianChild, GuardianCourse, Notifications, Principal, Submission,
} from '../types';

/**
 * Direct district API calls are available only with an Access assertion accepted by that district.
 * The Workshop's password-token session is NOT a district API credential.
 * The district always validates the JWT and authorizes each request on the server.
 */
export class DistrictApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'DistrictApiError';
  }
}
export class DistrictClient {
  constructor(private readonly base: string, private readonly credential: Credential) {}

  get available(): boolean { return this.credential.kind === 'cloudflare-access'; }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
    if (!this.available) throw new DistrictApiError(403, 'needs-access', 'Your school has not enabled native district API access.');
    const url = new URL(path, this.base);
    if (!url.pathname.startsWith('/api/') || url.origin !== this.base) throw new Error('Invalid district API path.');
    for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
    const response = await fetch(url.toString(), {
      method, redirect: 'error',
      headers: {
        accept: 'application/json',
        'cf-access-jwt-assertion': this.credential.token,
        // Access's edge checks the cookie before the district Worker validates the assertion.
        cookie: 'CF_Authorization=' + this.credential.token,
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = value as { code?: string; message?: string } | null;
      throw new DistrictApiError(response.status, error?.code || 'unavailable',
        typeof error?.message === 'string' ? error.message : 'Your school could not complete this request.');
    }
    return value as T;
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
  guardianChildren(): Promise<GuardianChild[]> { return this.call('GET', '/api/guardian/children'); }
  guardianClasses(studentId: string): Promise<ClassItem[]> {
    return this.call('GET', '/api/guardian/children/' + this.id(studentId) + '/offerings');
  }
  guardianClass(studentId: string, offeringId: string): Promise<GuardianCourse> {
    return this.call('GET', '/api/guardian/children/' + this.id(studentId) + '/offerings/' + this.id(offeringId));
  }
}
