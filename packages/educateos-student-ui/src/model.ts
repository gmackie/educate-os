// What the Learning Home reads from the district API, named for the screens that use it. Every type
// is derived from the route table through the API client, so a change to a route's schema is a
// type error here rather than a surprise at run time.
import type { RouteResponse } from "@educateos/api-client";

/** The signed-in student. */
export type Me = RouteResponse<"me.get">;
/** A class the student is or was enrolled in, with its course and term, which name it (SCHO-222). */
export type StudentOffering = RouteResponse<"student.listOfferings">[number];
/** A personal or course workspace, with its lifecycle. */
export type WorkspaceView = RouteResponse<"student.listWorkspaces">[number];
/** A course workspace. */
export type CourseWorkspaceView = Extract<WorkspaceView, { kind: "course" }>;
/** An activity assigned in a class, as a student sees it. */
export type AssignedActivity = RouteResponse<"student.listActivities">[number];
/** The assignment half of an {@link AssignedActivity}: due date, attempts, permitted work. */
export type Assignment = AssignedActivity["assignment"];
/** The student view of an activity's content. */
export type ActivityContent = AssignedActivity["activity"]["content"];
/** One step of an activity's instructions. */
export type ActivityStep = ActivityContent["steps"][number];
/** An artifact and its latest saved version. */
export type ArtifactView = RouteResponse<"student.listArtifacts">[number];
/** One saved version of an artifact, with its content. */
export type ArtifactRead = RouteResponse<"student.getArtifact">;
/** One saved version of an artifact, without content. */
export type ArtifactVersion = RouteResponse<"student.artifactHistory">[number];
/** What kind of work an artifact is. */
export type ArtifactType = ArtifactView["artifact"]["type"];
/** What submitting returns. */
export type SubmissionReceipt = RouteResponse<"student.submit">;
/** One submission, as the student's own list shows it. */
export type Submission = RouteResponse<"student.listSubmissions">[number];
/** Released feedback on one submission. */
export type Feedback = RouteResponse<"student.getFeedback">;
/** A comment in released feedback. */
export type FeedbackComment = Feedback["comments"][number];
/** One version of the student's official grade for an assignment. */
export type OfficialGrade = RouteResponse<"student.officialGrades">[number];
/** The student's own gradebook row in a class: course totals and letter grade (SCHO-187). */
export type GradeSummary = RouteResponse<"student.gradeSummary">;
/** What the teacher marked on one of the student's assignments. */
export type GradeMarker = NonNullable<GradeSummary["row"]["cells"][number]["marker"]>;
/** A class's published modules and their pages, as a student sees them. */
export type CourseOutline = RouteResponse<"student.listModules">["outline"];
/** One published module of a class. */
export type CourseModule = CourseOutline["modules"][number];
/** A class announcement, with its class's name (SCHO-189). */
export type AnnouncementView = RouteResponse<"student.announcements">[number];
/** One of the student's notifications (SCHO-189). */
export type NotificationView = RouteResponse<"me.notifications">["notifications"][number];
/** One event on the student's calendar (SCHO-189). */
export type CalendarEvent = RouteResponse<"me.calendar">["events"][number];
/** The student's email preferences (SCHO-189). */
export type Preferences = RouteResponse<"me.preferences">;

// Discussions (SCHO-190).
/** A class's discussion topics, as a student sees them. */
export type DiscussionListing = RouteResponse<"student.listDiscussions">;
/** One discussion topic. */
export type DiscussionTopic = DiscussionListing["topics"][number]["topic"];
/** A topic's thread as a student reads it, with its authors' names. */
export type DiscussionThread = RouteResponse<"student.discussionThread">;
/** One post as a student reads it: with its text, or a placeholder for one withdrawn. */
export type DiscussionPostView = DiscussionThread["posts"][number];

// Quizzes (SCHO-191).
/** A published quiz as a student sees it: its settings and their own attempts, never its questions. */
export type QuizView = RouteResponse<"student.getQuiz">;
/** An attempt in progress: its questions in this attempt's order, the saved answers, and the time. */
export type QuizAttemptView = RouteResponse<"student.startQuizAttempt">;
/** One question as the student taking the quiz sees it. No answer key. */
export type QuizQuestion = QuizAttemptView["questions"][number];
/** A response to one question. */
export type QuizResponse = QuizAttemptView["answers"][number]["response"];
/** A finished attempt as its student sees it. */
export type QuizAttemptResult = RouteResponse<"student.quizAttemptResult">;
