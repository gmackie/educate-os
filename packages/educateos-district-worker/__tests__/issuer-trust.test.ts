import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { durableDistrictStores } from "@educateos/district-app/durable-stores";
import { startDistrict } from "../src/district.ts";
import { readDistrictWorkerConfig } from "../src/config.ts";
import { ACCESS_AUDIENCES, ACCESS_ISSUER, TEST_CONFIG } from "./fixtures.ts";

const GOOGLE = "https://accounts.google.com";
const start = (storage: Parameters<typeof startDistrict>[0], trustedIssuers?: string[]) => startDistrict(storage, {
  config: JSON.stringify({ ...TEST_CONFIG, ...(trustedIssuers === undefined ? {} : { additionalTrustedIssuers: trustedIssuers }) }),
  accessIssuer: ACCESS_ISSUER,
  accessAudiences: ACCESS_AUDIENCES,
}, { importFetch: async () => new Response(null, { status: 404 }) });

describe("deployment-controlled issuer trust", () => {
  it("updates a populated directory, preserves all records and is idempotent across starts", async () => {
    await runInDurableObject(env.DISTRICT.getByName("issuer-trust-update"), async (_instance, state) => {
      const stores = durableDistrictStores(state.storage, TEST_CONFIG.directory);
      const before = await stores.directory.load();
      const issuers = [...before.snapshot.district.trustedIssuers, GOOGLE];
      await start(state.storage, issuers);
      const after = await stores.directory.load();
      expect(after.snapshot).toEqual({ ...before.snapshot, district: { ...before.snapshot.district, trustedIssuers: issuers } });
      expect(after.version).toBe(before.version + 1);
      await start(state.storage, [...issuers, GOOGLE]);
      expect((await stores.directory.load()).version).toBe(after.version);
      await start(state.storage);
      expect(await stores.directory.load()).toEqual(after);
      await start(state.storage, before.snapshot.district.trustedIssuers);
      expect(await stores.directory.load()).toEqual(after);
    });
  });

  it("rejects empty lists and non-HTTPS issuers", () => {
    for (const trustedIssuers of [[], ["http://accounts.google.com"], ["not-a-url"]]) {
      expect(() => readDistrictWorkerConfig(JSON.stringify({ ...TEST_CONFIG, additionalTrustedIssuers: trustedIssuers }))).toThrow();
    }
  });
});
