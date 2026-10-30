/** Mobile projections of the public /api route table, not authorization decisions. */
export type District = {
  id: string; name: string;
  /** The school's one origin: the LMS at `/`, the district API at `/api`. */
  origin: string;
  /** The AI workspace URL: `<origin>/ai/`, or a legacy Workshop origin. */
  workshop: string;
  /** Saved before the one-origin manifest; signs in through the legacy Workshop handoff. */
  legacy?: boolean;
  brand?: { logo: string | null; accent: string | null };
  features?: { ai: boolean; mobile: boolean; family: boolean };
};
export type Credential =
  /** A district-issued, key-bound device credential (preferred). Tokens live in SecureStore. */
  | { kind: 'device'; deviceId: string; principalId: string }
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
export type DeviceSummary = {
  id: string; label: string; platform: 'ios' | 'android' | 'web' | 'other'; model: string; appVersion: string;
  createdAt: string; lastSeenAt: string; lastCountry: string | null; push: boolean;
  status: 'active' | 'revoked'; revokedAt: string | null; revokedReason: string | null;
};
/** A class's modules (SCHO-186): ordered items that are pages or activities. Students see published ones. */
export type ModuleItem = { kind: 'page'; id: string; pageId: string } | { kind: 'activity'; id: string; activityId: string };
export type CourseModule = { id: string; title: string; published: boolean; items: ModuleItem[] };
export type CoursePage = { id: string; title: string; body: string };
export type CourseOutline = { outline: { offeringId: string; modules: CourseModule[]; pages: CoursePage[] } };
export type DiscussionTopic = {
  id: string; offeringId: string; title: string; prompt: string; locked: boolean; pinned: boolean;
  settings: { allowReplies: boolean }; createdAt: string;
};
export type TopicListing = { canModerate: boolean; topics: { topic: DiscussionTopic; posts: number; needsAttention: number }[] };
export type DiscussionPost =
  | { status: 'visible' | 'pending'; id: string; parentId?: string; authorId: string; authorRole: 'student' | 'staff';
    body: string; createdAt: string; editedAt?: string; mine: boolean }
  | { status: 'withdrawn'; id: string; parentId?: string; createdAt: string };
export type DiscussionThread = { topic: DiscussionTopic; posts: DiscussionPost[]; authors: { principalId: string; displayName: string }[] };
export type QuizScore = { points: number; maxPoints: number };
export type QuizSummary = {
  id: string; offeringId: string; courseTitle: string; title: string; description: string; assignmentId?: string;
  questionCount: number; totalPoints: number; attemptsAllowed: number; timeLimitMinutes?: number;
  availableFrom?: string; availableUntil?: string; availability: 'upcoming' | 'open' | 'closed';
  attempts: { id: string; number: number; status: 'in-progress' | 'submitted' | 'expired'; startedAt: string; deadline?: string; submittedAt?: string }[];
  canStart: boolean; releasedScore?: QuizScore;
};
export type QuizQuestion = {
  id: string; type: 'multiple-choice' | 'multiple-select' | 'true-false' | 'numeric' | 'short-answer' | 'essay';
  prompt: string; points: number; choices?: { id: string; text: string }[]; maxLength?: number;
};
export type QuizResponse =
  | { type: 'multiple-choice'; choiceId: string } | { type: 'multiple-select'; choiceIds: string[] }
  | { type: 'true-false'; value: boolean } | { type: 'numeric'; value: number }
  | { type: 'short-answer'; text: string } | { type: 'essay'; text: string };
export type QuizAnswer = { itemId: string; response: QuizResponse };
export type QuizAttempt = {
  attemptId: string; quizId: string; title: string; number: number; questions: QuizQuestion[]; answers: QuizAnswer[];
  startedAt: string; deadline?: string; savedAt?: string; serverNow: string;
};
export type QuizResult = {
  attemptId: string; quizId: string; courseTitle: string; title: string; number: number; status: 'submitted' | 'expired';
  submittedAt?: string; answersShown: boolean; released: boolean; releasedScore?: QuizScore;
  items: { question: QuizQuestion; response?: QuizResponse; points?: number | null; correct?: boolean;
    correctResponse?: QuizResponse; acceptedAnswers?: string[]; feedback?: string; comment?: string }[];
};
export type RouteErrorCode = 'unauthenticated' | 'forbidden' | 'not-found' | 'conflict' | 'validation-failed' | 'unavailable';
export type Tab = 'today' | 'classes' | 'review' | 'ai' | 'inbox' | 'family' | 'agenda' | 'me';
export type Role = 'student' | 'teacher' | 'guardian';
export type Detail =
  | { type: 'class'; id: string }
  | { type: 'assignment'; id: string; offeringId: string }
  | { type: 'teacher-class'; id: string }
  | { type: 'teacher-assignment'; id: string; offeringId: string }
  | { type: 'teacher-review'; id: string; assignmentId: string; studentName: string; artifacts: { artifactId: string; type: string }[] }
  | { type: 'write'; id: string; offeringId: string }
  | { type: 'family-child'; id: string }
  | { type: 'family-class'; studentId: string; offeringId: string }
  | { type: 'page'; offeringId: string; pageId: string }
  | { type: 'discussion'; offeringId: string; topicId: string }
  | { type: 'quiz'; offeringId: string; quizId: string }
  | { type: 'grades' } | { type: 'announcements' };
