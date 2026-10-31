// The LTI Platform's signing keys (SCHO-179): a key set of their own beside the tool keys, so
// rotating one never touches the other; a public JWKS of public halves only; and key IDs and
// rotation for a district administrator alone, decided by the policy engine.
import { describe, expect, it } from "vitest";
import { toolJwks } from "@educateos/lti";
import { LtiPlatformKeyService, PLATFORM_KEYS_COLLECTION, TOOL_KEYS_COLLECTION } from "../src/index.ts";
import { ADMIN, as, createDistrict, NF, RIVERA, rejection, SCHOOL_ADMIN } from "./setup.ts";

function platformKeys() {
  const district = createDistrict();
  const service = new LtiPlatformKeyService({ districtId: NF, authorizer: district.engine, keys: district.stores.platformKeys });
  return { district, service };
}

describe("LtiPlatformKeyService", () => {
  it("signs with a key set separate from the tool's, in its own collection", async () => {
    const { district, service } = platformKeys();
    const [platformKid] = (await service.jwks()).keys.map((key) => key.kid);
    const toolKid = (await district.stores.toolKeys.keySet()).signing.kid;
    expect(platformKid).not.toBe(toolKid);
    expect(district.table.list(PLATFORM_KEYS_COLLECTION)).toHaveLength(1);
    expect(district.table.list(TOOL_KEYS_COLLECTION)).toHaveLength(1);

    const rotation = await service.rotate(as(ADMIN));
    expect(rotation.retiredKids).toEqual([platformKid]);
    expect((await district.stores.toolKeys.keySet()).signing.kid).toBe(toolKid);
    expect(toolJwks(await district.stores.toolKeys.keySet()).keys.map((key) => key.kid)).toEqual([toolKid]);
  });

  it("publishes only public halves, the previous key too after a rotation", async () => {
    const { service } = platformKeys();
    const first = (await service.jwks()).keys[0]!.kid;
    const { signingKid } = await service.rotate(as(ADMIN));
    const { keys } = await service.jwks();
    expect(keys.map((key) => key.kid)).toEqual([signingKid, first]);
    for (const key of keys) expect(Object.keys(key).toSorted()).toEqual(["alg", "e", "kid", "kty", "n", "use"]);
  });

  it("shows and rotates the keys for a district admin only", async () => {
    const { district, service } = platformKeys();
    const kids = await service.keyIds(as(ADMIN));
    expect(kids).toHaveLength(1);
    expect(await rejection(service.keyIds(as(RIVERA)))).toBe("forbidden");
    expect(await rejection(service.rotate(as(RIVERA)))).toBe("forbidden");
    expect(await rejection(service.rotate(as(SCHOOL_ADMIN)))).toBe("forbidden");
    expect(await service.keyIds(as(ADMIN))).toEqual(kids);
    expect(district.audit.some((event) => event.effect === "deny" && event.principalId === RIVERA)).toBe(true);
  });
});
