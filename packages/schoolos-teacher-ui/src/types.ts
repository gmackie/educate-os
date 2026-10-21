// The shapes Teacher Studio renders, named once. Each comes from the district API's own route
// table through the client, so a change on the server is a type error here.
import type { RouteInput, RouteResponse } from "@schoolos/api-client";

/** A class the teacher teaches, with its course and their role in it. */
export type TeachingOffering = RouteResponse<"teacher.listOfferings">[number];
/** One row of a class roster. */
export type RosterEntry = RouteResponse<"teacher.roster">[number];
/** A resource waiting in the class's review queue. */
export type QueueEntry = RouteResponse<"teacher.reviewQueue">[number];
/** A resource's full review report. */
export type ResourceReport = RouteResponse<"teacher.resourceReport">;
/** A resource approved for the class. */
export type ResourceRelease = RouteResponse<"teacher.listReleases">[number];
/** How a resource may be used, from narrowest to widest. */
export type RightsMode = ResourceReport["rights"]["current"];
/** A saved activity, draft or published. */
export type ActivityDefinition = RouteResponse<"teacher.createActivity">;
/** What a template takes to make an activity. */
export type TemplateInput = RouteInput<"teacher.createActivity">["body"]["activity"];
/** One of the templates. */
export type TemplateKind = TemplateInput["template"];
/** How much AI help an activity allows. */
export type AiHelpLevel = TemplateInput["aiHelp"];
/** A learning goal an activity gathers evidence of. */
export type LearningGoal = TemplateInput["alignments"][number];
/** A note in the class context, for students or for teachers only. */
export type ClassNote = Extract<NonNullable<TemplateInput["codex"]>[number], { kind: "note" }>;
/** An activity assigned in a class. */
export type Assignment = RouteResponse<"teacher.listAssignments">[number];
/** A student's submitted, read-only work. */
export type Submission = RouteResponse<"teacher.listSubmissions">[number];
/** The feedback on one submission. */
export type Feedback = RouteResponse<"teacher.getFeedback">;
/** A score for one rubric criterion, the teacher's own or a suggestion. */
export type CriterionScore = Feedback["scores"][number];
/** A comment on a submission. */
export type FeedbackComment = Feedback["comments"][number];
/** Who a score or comment comes from. */
export type FeedbackSource = CriterionScore["source"];
/** A run of the automatic checks and the scores it suggested. */
export type CheckRun = RouteResponse<"teacher.runCi">;
/** A signed rubric. */
export type RubricRelease = RouteResponse<"teacher.signRubric">;
/** A draft rubric, before the teacher signs it. */
export type RubricDraft = RouteInput<"teacher.signRubric">["body"]["rubric"];
/** A reference to one signed rubric. */
export type RubricRef = NonNullable<Assignment["rubric"]>;
/** A grade waiting for the lead teacher's approval. */
export type GradeProposal = RouteResponse<"teacher.pendingGrades">[number];
/** One version of a student's official grade. */
export type OfficialGrade = RouteResponse<"teacher.approveGrade">;
