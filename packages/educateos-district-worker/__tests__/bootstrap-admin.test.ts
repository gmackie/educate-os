// SCHO-441: a fresh district's first administrator is created on their first sign-in, from the
// installer's `bootstrapAdmins`, through the Workshop's resolver seam as through the district's own.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PrincipalId } from "@educateos/contracts";
import { durableDistrictStores } from "@educateos/district-app/durable-stores";
import { startDistrict } from "../src/district.ts";
import { ACCESS_AUDIENCES, ACCESS_ISSUER, TEST_CONFIG } from "./fixtures.ts";

const FIRST = "prn_first-admin" as PrincipalId;
const admin = { principalId: FIRST, displayName: "Quinn First", email: "quinn.first@district.example" };
const start = (storage: Parameters<typeof startDistrict>[0], bootstrapAdmins?: typeof admin[]) => startDistrict(storage, {
  config: JSON.stringify({ ...TEST_CONFIG, ...(bootstrapAdmins === undefined ? {} : { bootstrapAdmins }) }),
  accessIssuer: ACCESS_ISSUER,
  accessAudiences: ACCESS_AUDIENCES,
}, { importFetch: async () => new Response(null, { status: 404 }) });

describe("bootstrap administrators", () => {
  it("creates the named administrator on their first Workshop sign-in, and never again", async () => {
    await runInDurableObject(env.DISTRICT.getByName("bootstrap-admin-linked"), async (_instance, state) => {
      const district = await start(state.storage, [admin]);
      const first = { issuer: ACCESS_ISSUER, subject: "access-uuid-first-admin", email: admin.email };
      await expect(district.principals.resolveAccessSignIn(first))
        .resolves.toStrictEqual({ outcome: "resolved", principalId: FIRST, displayName: admin.displayName });
      // The link is stored, so it resolves without the email too.
      await expect(district.principals.resolveAccessSignIn({ issuer: ACCESS_ISSUER, subject: first.subject }))
        .resolves.toMatchObject({ principalId: FIRST });
      // Someone else signing in later with the same email is not linked.
      await expect(district.principals.resolveAccessSignIn({ ...first, subject: "access-uuid-impostor" }))
        .resolves.toStrictEqual({ outcome: "unauthenticated" });
      const stored = (await durableDistrictStores(state.storage, TEST_CONFIG.directory).directory.load()).snapshot;
      expect(stored.principals.find((p) => p.id === FIRST)!.externalIdentities)
        .toStrictEqual([{ districtId: TEST_CONFIG.directory.district.id, issuer: ACCESS_ISSUER, subject: first.subject }]);
      expect(stored.roleAssignments.filter((a) => a.principalId === FIRST).map((a) => a.role)).toStrictEqual(["district-admin"]);
    });
  });

  it("creates no one without the setting", async () => {
    await runInDurableObject(env.DISTRICT.getByName("bootstrap-admin-off"), async (_instance, state) => {
      const district = await start(state.storage);
      await expect(district.principals.resolveAccessSignIn({ issuer: ACCESS_ISSUER, subject: "access-uuid-first-admin", email: admin.email }))
        .resolves.toStrictEqual({ outcome: "unauthenticated" });
    });
  });

  it("refuses a configuration that repeats a principal ID", async () => {
    await runInDurableObject(env.DISTRICT.getByName("bootstrap-admin-repeat"), async (_instance, state) => {
      await expect(start(state.storage, [admin, { ...admin, email: "other@district.example" }])).rejects.toThrow(/bootstrapAdmins/);
    });
  });
});
