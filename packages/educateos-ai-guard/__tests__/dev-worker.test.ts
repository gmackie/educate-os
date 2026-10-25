// The development entrypoint `pnpm dev-server --with-ai-guard` and PR previews run (src/dev-worker.ts):
// its synthetic config must be one the production ledger accepts for every model a dev Workshop
// offers, every dev user must resolve to a moderated student, and the fake Hall Monitor allows
// unless told otherwise by a marker.

import { describe, expect, it } from "vitest";
import { SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { createHallMonitorClient, serviceBindingTransport } from "@gmacko/hall-monitor-client";
import { SCHEMA_VERSION } from "@gmacko/hall-monitor-contracts";
import { AiLedger, InMemoryLedgerStore } from "@educateos/ai-governance";
import { readGuardConfig } from "../src/config.ts";
import { DEV_GUARD_CONFIG, DEV_MODERATOR } from "../src/dev-config.ts";
import { DevGuardContextResolver, withDevConfig } from "../src/dev-worker.ts";
import { FAKE_CHECK_COST_USD_NANO, fakeHallMonitor } from "../src/fake-hall-monitor.ts";
import { CHECK_COST } from "./fixtures.ts";
import { ConfiguredGovernanceSource } from "../src/ledger-object.ts";

const config = readGuardConfig(JSON.stringify(DEV_GUARD_CONFIG));

describe("dev guard config", () => {
  it("prices every suggested model, so no dev call is refused as unpriced", () => {
    const priced = new Set(config.modelRates.map((rate) => `${rate.provider}/${rate.modelId}`));
    for (const [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      for (const modelId of Object.keys(models)) expect(priced, `${provider}/${modelId}`).toContain(`${provider}/${modelId}`);
    }
  });

  it("is accepted by the production ledger for generative and moderation holds", async () => {
    const resolver = new DevGuardContextResolver(config);
    const context = await resolver.resolve({ initiator: { type: "user", id: "0123abcd-any-dev-user" } });
    expect(context).toMatchObject({ audience: "student", profile: { moderateInput: true, failureMode: "fail-closed" } });

    const ledger = new AiLedger({ districtId: config.districtId, store: new InMemoryLedgerStore(), source: new ConfiguredGovernanceSource(config) });
    const [rate] = config.modelRates;
    const generative = await ledger.reserve("dev-call-1", context!.principal, context!.workspace, { provider: rate!.provider, modelId: rate!.modelId }, "50000000");
    expect(generative).toMatchObject({ outcome: "reserved", status: "held" });
    const safety = await ledger.reserve("dev-call-1.m0.c0", context!.principal, context!.workspace, DEV_MODERATOR, "100000", { fundingPurpose: "safety" });
    expect(safety).toMatchObject({ outcome: "reserved", status: "held" });
  });

  it("is the default only while AI_GUARD_CONFIG is unset", () => {
    const supplied = { AI_GUARD_CONFIG: "{\"supplied\":true}" } as Cloudflare.Env;
    expect(withDevConfig(supplied).AI_GUARD_CONFIG).toBe("{\"supplied\":true}");
    expect(JSON.parse(withDevConfig({ AI_GUARD_CONFIG: "" } as Cloudflare.Env).AI_GUARD_CONFIG)).toMatchObject({ districtId: "dst_northfield" });
  });
});

describe("DevGuardContextResolver", () => {
  it("still refuses an agent initiator", async () => {
    expect(await new DevGuardContextResolver(config).resolve({ initiator: { type: "agent", id: "model" } })).toBeNull();
  });
});

describe("the fake Hall Monitor", () => {
  const client = createHallMonitorClient({ transport: serviceBindingTransport({ fetch: fakeHallMonitor }), timeoutMs: 2000 });
  const evaluate = (text: string) => {
    const id = crypto.randomUUID();
    return client.evaluate({
      schemaVersion: SCHEMA_VERSION,
      requestId: id,
      idempotencyKey: id,
      source: { product: "educateos", tenantId: "tenant_dev", surface: "educateos.workshop" },
      policy: { profileId: "k12-student", revision: "dev" },
      context: { audience: "student", gradeBand: "9-12", costCenterId: "cc_dev" },
      evaluationKind: "interaction.input",
      content: { type: "text", text },
    });
  };

  it("allows by default and follows a decision marker", async () => {
    expect((await evaluate("How do cells divide?")).decision).toBe("allow");
    expect((await evaluate("[[block]] something")).decision).toBe("block");
    expect((await evaluate("[[support]] I feel awful")).decision).toBe("support");
  });

  it("charges what the guard tests expect", () => {
    expect(FAKE_CHECK_COST_USD_NANO).toBe(CHECK_COST);
  });
});
