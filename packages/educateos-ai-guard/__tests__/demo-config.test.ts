// The guard configuration the schoolos.gmac.io production instance runs with, as its public example
// (deploy/schoolos-gmac-io/ai-guard-config.example.json). The deployed copy differs only in the
// admin's Access email, and is the guard's AI_GUARD_CONFIG secret (see
// docs/educateos/runbooks/production-instance.md). Synthetic: one staff principal in a demo
// district, bound statically to the admin's Access email, which is the Workshop user ID an Access
// sign-in gets (workshop-backend's authenticateFromCfAccess).

import { describe, expect, it } from "vitest";
import { SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { AiLedger, InMemoryLedgerStore } from "@educateos/ai-governance";
import { readGuardConfig } from "../src/config.ts";
import { StaticGuardContextResolver } from "../src/context.ts";
import { ConfiguredGovernanceSource } from "../src/ledger-object.ts";
import { estimateMaxUsdNano, rateFor } from "../src/pricing.ts";
import demoConfig from "../../../deploy/schoolos-gmac-io/ai-guard-config.example.json";

const ADMIN = "admin@example.com";
const text = JSON.stringify(demoConfig);
const config = readGuardConfig(text);

describe("schoolos.gmac.io demo guard config", () => {
  it("fits in one Workers secret", () => {
    // Cloudflare limits a secret, like a plain-text var, to 5 KB.
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(5000);
  });

  it("names Hall Monitor's built-in profiles", () => {
    expect(Object.values(config.profiles).map((profile) => [profile.hallMonitorProfileId, profile.revision]))
      .toEqual(expect.arrayContaining([["educator", "builtin-1"], ["student-6-8", "builtin-1"], ["student-9-12", "builtin-1"]]));
    expect(Object.values(config.profiles).every((profile) => profile.revision === "builtin-1")).toBe(true);
  });

  it("binds the admin's Access email as a staff educator in a personal workspace", async () => {
    const context = await new StaticGuardContextResolver(config).resolve({ initiator: { type: "user", id: ADMIN } });
    expect(context).toMatchObject({
      principal: { principalId: "prn_gmacko-demo-admin", districtId: "dst_gmacko-demo" },
      workspace: { kind: "personal" },
      audience: "educator",
      profile: { moderateInput: true, failureMode: "proceed", outputModeration: "off" },
    });
    expect(config.directory?.principals.find((p) => p.id === context?.principal.principalId)?.kind).toBe("staff");
  });

  it("prices every Workers AI model the Workshop suggests, within the per-principal cap", () => {
    const capUsdNano = BigInt(config.policy.aiMonthlyCapCentsPerPrincipal) * 10_000_000n;
    for (const [modelId, model] of Object.entries(SUGGESTED_MODELS.cloudflare)) {
      const rate = rateFor(config, { provider: "cloudflare", modelId });
      expect(rate, modelId).toBeDefined();
      const hold = BigInt(estimateMaxUsdNano(rate!, model.outputLimit));
      expect(hold, modelId).toBeLessThan(capUsdNano);
    }
  });

  it("keeps the monthly budget in single-digit dollars", () => {
    const total = config.fundingPools.reduce((sum, pool) => sum + BigInt(pool.monthlyAllocationUsdNano), 0n);
    expect(total).toBeLessThan(10_000_000_000n);
    expect(config.fundingPools.map((pool) => pool.purpose).toSorted()).toEqual(["personal", "safety"]);
  });

  it("has a profile for every audience class", () => {
    expect(Object.keys(config.profiles).toSorted()).toEqual(["educator", "student-6-8", "student-9-12", "student-k5"]);
    for (const key of ["student-k5", "student-6-8", "student-9-12"]) {
      expect(config.profiles[key]).toMatchObject({ moderateInput: true, failureMode: "fail-closed", outputModeration: "required" });
    }
  });

  it("is accepted by the production ledger for the admin's generative and moderation holds", async () => {
    const resolver = new StaticGuardContextResolver(config);
    const context = (await resolver.resolve({ initiator: { type: "gadget", id: ADMIN } }))!;
    const ledger = new AiLedger({ districtId: config.districtId, store: new InMemoryLedgerStore(), source: new ConfiguredGovernanceSource(config) });
    for (const [modelId, model] of Object.entries(SUGGESTED_MODELS.cloudflare)) {
      const ref = { provider: "cloudflare" as const, modelId };
      const reserved = await ledger.reserve(`demo-${modelId.replaceAll(/[^a-z0-9]/g, "-")}`, context.principal, context.workspace, ref,
        estimateMaxUsdNano(rateFor(config, ref)!, model.outputLimit));
      expect(reserved, modelId).toMatchObject({ outcome: "reserved", status: "held" });
    }
    const safety = await ledger.reserve("demo-check.m0.c0", context.principal, context.workspace, config.moderation.model,
      config.moderation.maxUsdNanoPerCheck, { fundingPurpose: "safety" });
    expect(safety).toMatchObject({ outcome: "reserved", status: "held" });
  });

  it("knows no one else", async () => {
    const resolver = new StaticGuardContextResolver(config);
    expect(await resolver.resolve({ initiator: { type: "user", id: "someone@example.com" } })).toBeNull();
    expect(await resolver.resolve({ initiator: { type: "agent", id: ADMIN } })).toBeNull();
  });
});
