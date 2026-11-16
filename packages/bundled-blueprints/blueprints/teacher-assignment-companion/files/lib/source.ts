import type { GoogleClassroomCourseSession } from "./connector.d.ts";
import { sourceUrl, type BoardResult } from "@gadgets/bundled-blueprints/libraries/teacher-board/server";

/** Read the selected course and app-owned coursework, never rosters, submissions or grades. */
export async function readSource(classroom: Pick<GoogleClassroomCourseSession, "getCourse" | "listCourseWork"> | undefined, _input: string): Promise<BoardResult> {
  if (!classroom) throw new Error("Connect CLASSROOM to a course you teach.");
  const [course, work] = await Promise.all([classroom.getCourse(), classroom.listCourseWork()]);
  return {
    title: course.name + (course.section ? " · " + course.section : ""),
    subtitle: "Only coursework created through this Google connection. Due dates are not exposed by this connector.",
    refreshedAt: new Date().toISOString(),
    cards: work.filter(item => item.state !== "DELETED").sort((a, b) => a.title.localeCompare(b.title)).map(item => ({
      id: item.id, title: item.title,
      label: item.pending ? "Awaiting approval" : item.state === "PUBLISHED" ? "Published" : item.state === "DRAFT" ? "Teacher draft" : "State unavailable",
      detail: item.description ?? "Open Classroom to review the full assignment.", url: sourceUrl(item.alternateLink),
    })),
  };
}
