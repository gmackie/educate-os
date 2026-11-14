// The guard reports Workshop-offered models its config would refuse (SCHO-401).
import { describe, expect, it } from "vitest";
import { readGuardConfig } from "../src/config.ts";
import { unfundedOfferedModels } from "../src/coverage.ts";
import demoConfig from "../../../deploy/schoolos-gmac-io/ai-guard-config.example.json";

describe("offered model coverage", () => {
  it("finds nothing missing in the production template", () => {
    expect(unfundedOfferedModels(readGuardConfig(JSON.stringify(demoConfig)))).toEqual([]);
  });

  it("names each offered model the config drops, and what it lacks", () => {
    const drop = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
    const config = readGuardConfig(JSON.stringify({
      ...demoConfig,
      modelCatalog: demoConfig.modelCatalog.filter((m) => m.modelId !== drop),
      fundingPools: demoConfig.fundingPools.map((pool) => ({ ...pool, allowedModels: pool.allowedModels.filter((m) => m.modelId !== drop) })),
      modelRates: demoConfig.modelRates.filter((r) => r.modelId !== drop),
    }));
    expect(unfundedOfferedModels(config)).toEqual([{ provider: "cloudflare", modelId: drop, missing: ["catalog", "pool", "rate"] }]);
  });
});
