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
/** One immutable resource release (`ResourceReleaseRef`). The student API names a resource only by its release. */
export type ResourceRef = { resourceId: string; version: string };
/** What a step asks the student to produce (`StepResponse` in @educateos/curriculum). */
export type StepResponse =
  | { kind: 'none' }
  | { kind: 'writing'; minWords?: number }
  | { kind: 'dataset'; columns: { name: string; unit?: string }[] }
  | { kind: 'artifact'; artifactType: string };
export type ActivityStep = {
  id: string; title: string; prompt: string; sources: ResourceRef[]; response: StepResponse;
  /** Sentence starters such as "I see a ___.", for young learners to say or write their answer from. */
  sentenceFrames?: string[];
};
/** An activity's Codex entry. Students only ever receive `students` entries; notes are the teacher's own text. */
export type CodexEntry =
  | { kind: 'resource'; resource: ResourceRef; visibility: 'students' | 'teacher-only' }
  | { kind: 'note'; id: string; title: string; body: string; purpose: 'context' | 'answer-key'; visibility: 'students' | 'teacher-only' };
export type ActivityContent = {
  title: string; overview: string; steps: ActivityStep[];
  /** Such as "K", "K-2" or "9-12"; parsed by src/gradeBand.ts. */
  gradeBand?: string; template?: string;
  resources?: ResourceRef[]; codex?: CodexEntry[]; permittedArtifactTypes?: string[];
};
/** `GET /api/student/activities/:id`: an installed activity as the student sees it. */
export type ActivityView = { view: 'teacher' | 'student'; content: ActivityContent };
export type Workspace = { id: string; kind: 'personal' | 'course'; offeringId?: string; lifecycle: string };
export type ArtifactView = {
  artifact: { id: string; workspaceId: string; type: string; title: string; createdAt: string; deletedAt?: string };
  head: { id: string; number: number; mediaType: string; createdAt: string };
};
/** Revision content as the district returns it; bytes travel as base64. */
export type RevisionContent = { kind: 'text'; text: string } | { kind: 'bytes'; base64: string } | { kind: 'external'; url: string };
export type ArtifactRead = { artifact: ArtifactView['artifact']; revision: ArtifactView['head']; content: RevisionContent };
/** The district's uploadable file types (`UPLOAD_MEDIA_TYPES` in educateos-district-app/src/routes.ts). */
export type UploadMediaType = 'application/pdf' | 'image/png' | 'image/jpeg' | 'audio/webm' | 'audio/ogg' | 'audio/mp4' | 'audio/mpeg' | 'audio/wav';
export type Submission = { id: string; assignmentId: string; studentPrincipalId: string; items: { artifactId: string; revisionId: string; artifactType: string }[]; submittedAt: string; attempt: number; withdrawnAt?: string };
export type GradeSummary = {
  row?: {
    totals?: { final: number | null; letter: string | null };
    cells?: { assignmentId: string; score?: { points: number; maxPoints: number }; percent: number | null; dropped?: boolean }[];
  };
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
  /** Bare announcements here, unlike the student routes' `{ announcement, courseLabel }`. */
  announcements?: Announcement['announcement'][];
};
export type DeviceSummary = {
  id: string; label: string; platform: 'ios' | 'android' | 'web' | 'other'; model: string; appVersion: string;
  createdAt: string; lastSeenAt: string; lastCountry: string | null; push: boolean;
  status: 'active' | 'revoked'; revokedAt: string | null; revokedReason: string | null;
};
/**
 * A class's modules (SCHO-186): ordered pages, activities, external links and teacher-only notes
 * (SCHO-331). Students see published modules, never teacher notes.
 */
export type ModuleItem =
  | { kind: 'page'; id: string; pageId: string }
  | { kind: 'activity'; id: string; activityId: string }
  | { kind: 'link'; id: string; title: string; url: string }
  | { kind: 'teacher-note'; id: string; pageId: string; purpose: 'context' | 'answer-key' };
/** Where a module came from: a Common Cartridge, or a unit of a course installed from the district library. */
export type ModuleSource =
  | { kind: 'cartridge'; fileName: string; packageDigest: string }
  | { kind: 'course'; packageId: string; version: string; packageDigest: string; unitKey: string };
export type CourseModule = { id: string; title: string; published: boolean; items: ModuleItem[]; source?: ModuleSource };
export type CoursePage = { id: string; title: string; body: string };
export type CourseOutline = { outline: { offeringId: string; modules: CourseModule[]; pages: CoursePage[] } };
export type DiscussionTopic = {
  id: string; offeringId: string; title: string; prompt: string; locked: boolean; pinned: boolean;
  settings: { allowReplies: boolean }; createdAt: string;
};
export type TopicListing = { canModerate: boolean; topics: { topic: DiscussionTopic; posts: number; needsAttention: number }[] };
/** A post as a student sees it, or (with `flags` and the hidden/removed/deleted states) as staff do. */
export type DiscussionPost =
  | { status: 'visible' | 'pending' | 'hidden' | 'removed' | 'deleted'; id: string; parentId?: string; authorId: string;
    authorRole: 'student' | 'staff'; body: string; createdAt: string; editedAt?: string; mine?: boolean; flags?: { reason: string }[] }
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
export type GradebookCell = { assignmentId: string; score?: QuizScore; percent: number | null; counted?: boolean; dropped?: boolean; marker?: string };
export type Gradebook = {
  columns: { assignmentId: string; title: string; dueAt: string; pointsPossible: number | null }[];
  rows: { studentPrincipalId: string; displayName: string; cells: GradebookCell[];
    totals: { final: number | null; letter: string | null; points?: { earned: number; possible: number } } }[];
};
export type StaffQuizSummary = { quiz: { id: string; title: string; status: string; assignmentId?: string };
  started: number; submitted: number; needsGrading: number; lastReleasedAt?: string };
export type QuizResults = {
  quiz: { id: string; title: string; items: (QuizQuestion & { correctChoiceId?: string; acceptedAnswers?: string[] })[] };
  students: { studentId: string; needsGrading: boolean;
    attempts: { id: string; number: number; status: string; submittedAt?: string; points: number | null; maxPoints: number }[] }[];
  items: { itemId: string; responses: number; correct: number; graded: number; percentCorrect: number | null; meanPoints: number | null }[];
  releasable: number; names: { principalId: string; displayName: string }[];
};
export type StaffAttempt = {
  quiz: QuizResults['quiz']; studentName: string;
  attempt: { id: string; number: number; status: string; submittedAt?: string; answers: QuizAnswer[];
    itemScores?: { itemId: string; points: number | null; maxPoints: number; source: 'auto' | 'teacher'; comment?: string }[] };
};
export type ModerationQueue = { settings: { premoderation: boolean }; pending: DiscussionPost[]; flagged: DiscussionPost[] };
export type GradeProposal = { id: string; studentPrincipalId: string; submissionId: string; score: QuizScore; proposedAt: string;
  approvedAsVersion?: number; declined?: unknown; expired?: unknown };
export type EmailPreferences = {
  email: { announcements: boolean; assignments: boolean; feedback: boolean; grades: boolean; digest: boolean };
  hasEmailAddress: boolean; emailEnabled: boolean;
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
