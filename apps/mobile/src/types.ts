/** Mobile projections of the public /api route table, not authorization decisions. */
export type District = { id: string; name: string; portal: string; workshop: string };
export type Credential =
  | { kind: 'workshop'; token: string; expiresAt: number }
  | { kind: 'cloudflare-access'; token: string };
export type Session = { district: District; credential: Credential; confirmedAt: number };
export type Principal = {
  principalId: string; districtId: string; displayName: string;
  kind: 'student' | 'staff' | 'guardian' | 'service';
  roles: { role: string; scope: unknown }[];
  enrollments: { offeringId: string; role: string }[];
};
export type Offering = { id: string; sectionName: string; courseId: string; termId: string };
export type Course = { id: string; title: string; subject?: string; gradeBand?: string };
export type Term = { name: string; state?: string; endsOn?: string };
export type ClassItem = { offering: Offering; course: Course; term?: Term; role?: string };
export type Assignment = {
  id: string; offeringId: string; activityId: string; title: string;
  dueAt: string; attemptsAllowed: number; feedbackVisibility?: string;
  permittedArtifactTypes?: string[];
};
export type Activity = { assignment: Assignment; activity?: { content?: ActivityContent } };
export type ActivityContent = { title: string; overview: string; steps: { id: string; title: string; prompt: string }[]; };
export type Submission = { id: string; assignmentId: string; studentPrincipalId: string; items: { artifactId: string; revisionId: string; artifactType: string }[]; submittedAt: string; attempt: number; withdrawnAt?: string };
export type GradeSummary = {
  row?: { totals?: { final: number | null; letter: string | null } };
  columns?: { assignmentId: string; title: string; dueAt: string }[];
};
export type Announcement = {
  announcement: { id: string; title: string; body: string; publishAt: string; offeringId: string };
  courseLabel: string; published: boolean;
};
export type Notification = {
  id: string; title: string; kind: string; occurredAt: string; readAt?: string; offeringId: string;
  ref: { assignmentId?: string; announcementId?: string; submissionId?: string };
};
export type Notifications = { notifications: Notification[]; unread: number };
export type CalendarEvent = {
  uid: string; kind: string; title: string; start: string; allDay: boolean;
  offeringId?: string; assignmentId?: string;
};
export type GuardianChild = { studentPrincipalId: string; displayName: string };
export type GuardianCourse = ClassItem & {
  assignments: { assignment: { id: string; title: string; dueAt: string; kind: string }; grades: { score: { points: number; maxPoints: number } }[] }[];
  announcements?: Announcement[];
};
export type RouteErrorCode = 'unauthenticated' | 'forbidden' | 'not-found' | 'conflict' | 'validation-failed' | 'unavailable';
export type Tab = 'today' | 'classes' | 'calendar' | 'inbox' | 'workspace' | 'account';
export type Detail =
  | { type: 'class'; id: string }
  | { type: 'assignment'; id: string; offeringId: string }
  | { type: 'teacher-class'; id: string }
  | { type: 'teacher-assignment'; id: string; offeringId: string }
  | { type: 'teacher-review'; id: string; assignmentId: string; studentName: string; artifacts: { artifactId: string; type: string }[] }
  | { type: 'write'; id: string; offeringId: string }
  | { type: 'family-child'; id: string }
  | { type: 'family-class'; studentId: string; offeringId: string }
  | { type: 'grades' } | { type: 'announcements' };
