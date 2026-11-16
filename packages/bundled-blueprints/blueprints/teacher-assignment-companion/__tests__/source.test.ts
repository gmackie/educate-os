// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { GoogleClassroomCourseSession } from "../../../../gatekeeper-google/src/classroom-types.js";
import { readSource } from "../files/lib/source.ts";
it("uses only selected-course reads and labels drafts and pending records", async () => {
  const session: Pick<GoogleClassroomCourseSession, "getCourse" | "listCourseWork"> = {
    getCourse: vi.fn(async () => ({ id: "selected", name: "Science", courseState: "ACTIVE" as const })),
    listCourseWork: vi.fn(async () => [{ id: "a", title: "Journal", state: "DRAFT" as const }, { id: "b", title: "Deleted", state: "DELETED" as const }, { id: "c", title: "Pending", state: "PUBLISHED" as const, pending: true as const }]),
  };
  const board = await readSource(session, "ignored: other course id");
  expect(session.getCourse).toHaveBeenCalledWith();
  expect(session.listCourseWork).toHaveBeenCalledWith();
  expect(board.cards.map(card => card.label)).toEqual(["Teacher draft", "Awaiting approval"]);
  expect(board.subtitle).toContain("Due dates are not exposed");
});
it("refuses missing and denied capabilities", async () => {
  await expect(readSource(undefined, "")).rejects.toThrow("CLASSROOM");
  await expect(readSource({ getCourse: async () => { throw new Error("denied"); }, listCourseWork: async () => [] }, "")).rejects.toThrow("denied");
});
