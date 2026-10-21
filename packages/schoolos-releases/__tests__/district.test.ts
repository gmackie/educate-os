import { describe, expect, it } from "vitest";
import { compareSemVer, DistrictReleasePolicy } from "../src/index.ts";
import { DAY, driftFor, makeManager, makeSigner, manualClock, rejection, signedOffer, statementFor } from "./support.ts";

const MIGRATING = {
  migrations: [{ migrationId: "0002_learning_artifacts", irreversible: true, summary: "adds the artifacts table" }],
};

describe("R03 acceptance: a district can decline an update", () => {
  it("records the decline and its reason, and never applies the release", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    await manager.receiveOffer(await signedOffer(signer, clock, statement));

    const declined = await manager.decline(1, "pilot-term-freeze");

    expect(declined).toMatchObject({ status: "declined", decidedBy: "district", declineReason: "pilot-term-freeze" });
    expect((await rejection(manager.approve(1, { drift: driftFor(statement) }))).code).toBe("conflict");
    expect((await manager.state()).installed.map((r) => r.releaseId)).toEqual(["r1-baseline"]);
  });

  it("lets only the district rescind its decline", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    await manager.receiveOffer(await signedOffer(signer, clock, statement));
    await manager.decline(1, "pilot-term-freeze");

    await manager.rescindDecline("r2-fixture");
    await manager.approve(1, { drift: driftFor(statement) });
    await expect(manager.authorizeApply(1, driftFor(statement))).resolves.toMatchObject({ purpose: "upgrade" });
  });

  it("defers an offer, which then is not applicable even under an auto-apply policy", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust, { policy: { channel: "stable", autoApply: true } });
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    expect((await manager.receiveOffer(await signedOffer(signer, clock, statement))).status).toBe("approved");

    const deferred = await manager.defer(1, new Date(clock.now().getTime() + 3 * DAY));
    expect(deferred).toMatchObject({ status: "deferred", deferredUntil: "2026-10-23T12:00:00.000Z" });
    expect((await rejection(manager.authorizeApply(1, driftFor(statement)))).code).toBe("forbidden");
  });

  it("supersedes older open offers, so only the newest can be applied", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const r2 = statementFor(clock, "r2-fixture", "0.2.0");
    await manager.receiveOffer(await signedOffer(signer, clock, r2, { offerSequence: 1 }));
    await manager.approve(1, { drift: driftFor(r2) });
    await manager.receiveOffer(await signedOffer(signer, clock, statementFor(clock, "r3-fixture", "0.3.0"), { offerSequence: 2 }));

    expect((await rejection(manager.authorizeApply(1, driftFor(r2)))).code).toBe("forbidden");
  });
});

describe("R03 approval policy", () => {
  it("refuses a canary policy that auto-applies, and never auto-approves canary or rollback offers", async () => {
    expect(DistrictReleasePolicy.safeParse({ channel: "canary", autoApply: true }).success).toBe(false);

    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust, { policy: { channel: "canary", autoApply: false } });
    const canary = statementFor(clock, "r2-canary", "0.2.0", { channel: "canary" });
    expect((await manager.receiveOffer(await signedOffer(signer, clock, canary))).status).toBe("pending");
  });

  it("auto-applies an ordinary stable upgrade only when the policy says so", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const manual = makeManager(clock, trust).manager;
    const auto = makeManager(clock, trust, { policy: { channel: "stable", autoApply: true } }).manager;
    const statement = statementFor(clock, "r2-fixture", "0.2.0");

    expect((await manual.receiveOffer(await signedOffer(signer, clock, statement))).status).toBe("pending");
    expect(await auto.receiveOffer(await signedOffer(signer, clock, statement))).toMatchObject({ status: "approved", decidedBy: "policy" });
    await expect(auto.authorizeApply(1, driftFor(statement))).resolves.toBeDefined();
  });

  it("does not auto-apply a release the root marked as carrying an irreversible migration", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust, { policy: { channel: "lts", autoApply: true } });
    const statement = statementFor(clock, "r2-lts", "0.2.0", { channel: "lts", ...MIGRATING });
    expect((await manager.receiveOffer(await signedOffer(signer, clock, statement))).status).toBe("pending");
  });

  it("refuses an upgrade from a version older than the release's minimum compatible version", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const statement = statementFor(clock, "r4-fixture", "0.4.0", { minimumCompatibleVersion: "0.3.0" });
    expect((await rejection(manager.receiveOffer(await signedOffer(signer, clock, statement)))).code).toBe("policy-violation");
  });
});

describe("R03 migration gates and the dry-run drift report", () => {
  it("needs every irreversible migration acknowledged before approval", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const statement = statementFor(clock, "r2-fixture", "0.2.0", MIGRATING);
    await manager.receiveOffer(await signedOffer(signer, clock, statement));
    const drift = driftFor(statement, ["0002_learning_artifacts"]);

    const error = await rejection(manager.approve(1, { drift }));
    expect(error).toMatchObject({ code: "policy-violation", message: expect.stringContaining("0002_learning_artifacts") });
    await manager.approve(1, { drift, acknowledgedMigrations: ["0002_learning_artifacts"] });
    await expect(manager.authorizeApply(1, drift)).resolves.toMatchObject({ statement: { releaseId: "r2-fixture" } });
  });

  it("stops an auto-approved release at apply time when the dry run finds a D1 migration the root didn't declare", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust, { policy: { channel: "stable", autoApply: true } });
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    expect((await manager.receiveOffer(await signedOffer(signer, clock, statement))).status).toBe("approved");

    const drift = driftFor(statement, ["0003_undeclared"]);
    expect((await rejection(manager.authorizeApply(1, drift))).code).toBe("policy-violation");
    await manager.approve(1, { drift, acknowledgedMigrations: ["0003_undeclared"] });
    await expect(manager.authorizeApply(1, drift)).resolves.toBeDefined();
  });

  it("refuses a drift report for another release, or one whose dry run is blocked", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    await manager.receiveOffer(await signedOffer(signer, clock, statement));

    const other = { ...driftFor(statement), manifestSha256: "c".repeat(64) };
    expect((await rejection(manager.approve(1, { drift: other }))).code).toBe("validation-failed");
    expect((await rejection(manager.approve(1, { drift: { ...driftFor(statement), ready: false } }))).code).toBe("conflict");
  });

  it("refuses to approve an offer after it expired", async () => {
    const clock = manualClock();
    const { signer, trust } = await makeSigner();
    const { manager } = makeManager(clock, trust);
    const statement = statementFor(clock, "r2-fixture", "0.2.0");
    await manager.receiveOffer(await signedOffer(signer, clock, statement));
    clock.advance(8 * DAY);
    expect((await rejection(manager.approve(1, { drift: driftFor(statement) }))).code).toBe("conflict");
  });
});

describe("semantic version order", () => {
  it("orders releases, pre-releases and numeric identifiers by SemVer precedence", () => {
    const ordered = ["0.9.0", "0.10.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    for (let i = 1; i < ordered.length; i++) expect(compareSemVer(ordered[i - 1]!, ordered[i]!)).toBe(-1);
    expect(compareSemVer("1.2.3", "1.2.3")).toBe(0);
  });
});
