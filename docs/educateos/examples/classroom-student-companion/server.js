import { DurableObject } from "cloudflare:workers";

/** Bind only GoogleClassroomStudentSession. Each learner installs their own copy. */
export class Gadget extends DurableObject {
  async listAssignments() {
    const work = await this.env.GOOGLE_CLASSROOM_STUDENT.listCourseWork();
    return {
      fetchedAt: new Date().toISOString(),
      assignments: work.filter((item) => item.state === "PUBLISHED").map(projectAssignment),
    };
  }

  async getAssignment(courseWorkId) {
    const { assignments, fetchedAt } = await this.listAssignments();
    const assignment = assignments.find((item) => item.id === courseWorkId);
    if (!assignment) throw Error("This assignment is unavailable in your connected course.");
    const submission = await this.env.GOOGLE_CLASSROOM_STUDENT.getMySubmission(courseWorkId);
    return {
      fetchedAt,
      assignment,
      submission: submission && {
        state: submission.state,
        late: submission.late,
        answer: submission.answer,
        alternateLink: safeLink(submission.alternateLink),
        attachments: (submission.attachments || []).map((item) => ({
          title: item.title,
          url: safeLink(item.url),
        })),
      },
    };
  }

  async requestTurnIn(courseWorkId) {
    const { submission } = await this.getAssignment(courseWorkId);
    if (!submission || !["CREATED", "RECLAIMED_BY_STUDENT"].includes(submission.state)) {
      throw Error("Prepare or reclaim your submission in Google Classroom, then refresh here.");
    }
    await this.env.GOOGLE_CLASSROOM_STUDENT.turnIn(courseWorkId);
    // Read the provider again. A local click or approval request is not proof of turn-in.
    return this.getAssignment(courseWorkId);
  }
}

function projectAssignment(item) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    maxPoints: item.maxPoints,
    alternateLink: safeLink(item.alternateLink),
    materials: (item.materials || []).map((material) => ({
      title: material.title,
      kind: material.kind,
      url: safeLink(material.url),
    })),
  };
}

function safeLink(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* A missing link leaves the assignment readable. */ }
  return undefined;
}
