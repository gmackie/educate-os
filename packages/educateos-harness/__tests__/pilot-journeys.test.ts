import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PILOT_PERSONAS } from "@educateos/fixtures";
import { replayPilot } from "../src/pilot/index.ts";

const golden = async () => JSON.parse(await readFile(new URL("../goldens/pilot-journeys.json", import.meta.url), "utf8")) as Awaited<ReturnType<typeof replayPilot>>;

describe("pilot journeys replay the same way every time", () => {
  it("matches the reviewed golden transcript exactly", async () => {
    // A mismatch is a product change to review, then `pnpm educateos:pilot --update`; never edit by hand.
    expect(await replayPilot()).toEqual(await golden());
  });

  it("is deterministic across two fresh districts", async () => {
    expect(await replayPilot()).toEqual(await replayPilot());
  });
});

describe("what each synthetic motivation is offered", () => {
  it("offers the expected approved standards, audited against the registry, and nothing else", async () => {
    const transcript = await replayPilot();
    for (const persona of PILOT_PERSONAS) {
      const first = transcript.personas[persona.key][0]!.result as { offered?: { code: string }[]; alignmentAudit?: unknown };
      expect(first.offered?.map((o) => o.code) ?? [], persona.key).toEqual(persona.expectedCodes);
      if (first.offered !== undefined) expect(first.alignmentAudit, persona.key).toBe("clean");
    }
  });

  it("gives the basketball learner a basketball task and the other two their own, all for the same registry record", async () => {
    const transcript = await replayPilot();
    const task = (key: keyof typeof transcript.personas) => (transcript.personas[key][0]!.result as { offered: { task: string; nodeCode: string }[] }).offered[0]!;
    expect(task("basketball").task).toContain("Basketball practice");
    expect(task("roblox-pizza").task).toContain("Pizza Tycoon");
    expect(task("cookie-business").task).toContain("Cookie project");
    expect(new Set(["basketball", "roblox-pizza", "cookie-business"].map((k) => task(k as never).nodeCode))).toEqual(new Set(["6.RP.A.3"]));
  });

  it("separates the three evidence outcomes the teacher sees", async () => {
    const { coverage } = await replayPilot();
    const rate = coverage.find((r) => (r as { code: string }).code === "6.RP.A.3") as { evidenceByStudent: Record<string, number>; opportunities: Record<string, number> };
    // Two independently reviewed, one practiced with AI-assisted practice, one who never found a fit.
    expect(rate.evidenceByStudent).toEqual({ "needs-evidence": 1, encountered: 0, practiced: 1, "independent-reviewed": 2 });
    expect(rate.opportunities.shared).toBe(3);
  });
});
