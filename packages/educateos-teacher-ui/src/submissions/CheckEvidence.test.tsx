import { act } from "react";
import { createRoot } from "react-dom/client";
import { within } from "@testing-library/dom";
import { describe, expect, it } from "vitest";
import type { RouteResponse } from "@educateos/api-client";
import { CheckEvidence } from "./CheckEvidence.tsx";

type Submitted = RouteResponse<"teacher.submittedContent">;
const item: Submitted["item"] = {
  artifactId: "art_example" as Submitted["item"]["artifactId"],
  revisionId: "rev_pinned" as Submitted["item"]["revisionId"],
  digest: `sha256:${"a".repeat(64)}` as Submitted["item"]["digest"],
  artifactType: "document", mediaType: "text/plain", sizeBytes: 19, aiAssistance: { level: "none" },
};
const work = [{ label: "Student argument", submitted: { item, content: { kind: "text" as const, text: "Evidence supports A" } } }];

describe("assessment evidence passages", () => {
  it.each([
    { name: "exact submitted revision", revision: item.revisionId, start: 0, end: 8, quote: "Evidence" },
    { name: "a different revision", revision: "rev_current" as typeof item.revisionId, start: 0, end: 8, quote: undefined },
    { name: "an out-of-bounds range", revision: item.revisionId, start: 0, end: 200, quote: undefined },
    { name: "a negative range", revision: item.revisionId, start: -1, end: 8, quote: undefined },
  ])("handles $name without misattributing text", async ({ revision, start, end, quote }) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<CheckEvidence work={work} excerpts={[{ artifact: item.artifactId, revision, range: { start, end } }]} />));
      if (quote === undefined) {
        expect(within(container).getByText(/could not be matched to the submitted revision/)).toBeTruthy();
        expect(container.querySelector("blockquote")).toBeNull();
      } else {
        expect(container.querySelector("blockquote")?.textContent).toBe(quote);
        expect(within(container).getByText("Student argument")).toBeTruthy();
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not invent a quote for an aggregate finding", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<CheckEvidence work={work} excerpts={[]} />));
      expect(within(container).getByText(/cites no specific passage/)).toBeTruthy();
      expect(container.querySelector("blockquote")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});
