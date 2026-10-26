// SCHO-203: the district Worker builds a Clever roster source from its token and runs whichever
// roster sync is due on its hourly Cron Trigger, skipping quietly when it has nothing to run.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { workerRosterSource } from "../src/district.ts";
import { NOTIFICATION_CRON } from "../src/schedule.ts";

const district = () => env.DISTRICT.getByName(NORTHFIELD.district.id);
const CLEVER = { provider: "clever", mode: "apply-automatically", clever: { districtId: "6650c1a0e1b2c3d4e5f6d001" } } as const;
const unused: typeof fetch = async () => {
  throw new Error("no request is made while building a source");
};

describe("the Worker's roster source", () => {
  it("reads a Clever roster with the district's token", () => {
    const built = workerRosterSource("district-token", unused)(CLEVER);
    expect("source" in built && built.source.kind).toBe("clever");
  });

  it("says why it has none: no token, no Clever district, or a provider it does not sync", () => {
    expect(workerRosterSource(undefined, unused)(CLEVER)).toEqual({ reason: "no CLEVER_DISTRICT_TOKEN secret is set" });
    expect(workerRosterSource("", unused)(CLEVER)).toEqual({ reason: "no CLEVER_DISTRICT_TOKEN secret is set" });
    expect(workerRosterSource("district-token", unused)({ provider: "clever", mode: "apply-automatically" })).toEqual({ reason: "the roster names no Clever district" });
    expect(workerRosterSource("district-token", unused)({ provider: "oneroster-api", mode: "apply-automatically" }))
      .toEqual({ reason: "the district Worker syncs a Clever roster only, not oneroster-api" });
  });
});

describe("the hourly roster sync", () => {
  it("skips without a Clever token or roster configuration, and the hourly job still completes", async () => {
    expect(env.CLEVER_DISTRICT_TOKEN).toBeUndefined();
    expect(await district().scheduledRosterSync()).toMatchObject({ ran: false, reason: expect.any(String) });
    await district().runScheduled(NOTIFICATION_CRON);
  });
});
