// What the Learning Home reads from the district API, named for the screens that use it. Every type
// is derived from the route table through the API client, so a change to a route's schema is a
// type error here rather than a surprise at run time.
import type { RouteResponse } from "@schoolos/api-client";

/** The signed-in student. */
export type Me = RouteResponse<"me.get">;
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
/** One version of the student's official grade for an assignment. */
export type OfficialGrade = RouteResponse<"student.officialGrades">[number];
/** A class's published modules and their pages, as a student sees them. */
export type CourseOutline = RouteResponse<"student.listModules">["outline"];
/** One published module of a class. */
export type CourseModule = CourseOutline["modules"][number];
