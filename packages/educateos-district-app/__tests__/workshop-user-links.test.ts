import { describe, expect, it } from "vitest";
import { bootDistrict, expectError, NF, RIVERBEND } from "./support.ts";

const PATH = "/api/admin/workshop-user-links";

async function call(district: Awaited<ReturnType<typeof bootDistrict>>, token: string | undefined, body?: unknown) {
  const response = await district.app.fetch(new Request(`https://district.example${PATH}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...token === undefined ? {} : { authorization: `Bearer ${token}` } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  }));
  return { status: response.status, body: await response.json(), correlationId: response.headers.get("x-correlation-id") ?? "" };
}

describe("administrator-confirmed Workshop links", () => {
  it("links a student without elevating their role, and the guard reads the link immediately", async () => {
    const d = await bootDistrict();
    const admin = d.tokenFor(NF.admin);
    const workshopUser = `principal:${NF.amara}`;
    expect(await d.app.guardDirectory.guardSubject({ workshopUser })).toBeNull();
    const result = await call(d, admin, { workshopUser, principalId: NF.amara });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ districtId: d.directory.district.id, workshopUser, principalId: NF.amara, confirmedBy: NF.admin });
    expect(await d.app.guardDirectory.guardSubject({ workshopUser })).toMatchObject({ kind: "student", roles: [], principal: { principalId: NF.amara } });
    expect((await call(d, admin)).body).toEqual([result.body]);
  });

  it("refuses unauthenticated callers, teachers and students, without adding a link", async () => {
    const d = await bootDistrict();
    for (const token of [undefined, d.tokenFor(NF.morgan), d.tokenFor(NF.amara)]) {
      const status = token === undefined ? 401 : 403;
      expectError(await call(d, token), status, token === undefined ? "unauthenticated" : "forbidden");
      expectError(await call(d, token, { workshopUser: "new@example.com", principalId: NF.amara }), status, token === undefined ? "unauthenticated" : "forbidden");
    }
    expect((await call(d, d.tokenFor(NF.admin))).body).toEqual([]);
  });

  it("refuses forged confirmer metadata, mismatched canonical keys and another district's principal", async () => {
    const d = await bootDistrict();
    const admin = d.tokenFor(NF.admin);
    expectError(await call(d, admin, { workshopUser: "new@example.com", principalId: NF.amara, confirmedBy: NF.morgan }), 400, "validation-failed");
    expectError(await call(d, admin, { workshopUser: `principal:${NF.morgan}`, principalId: NF.amara }), 400, "validation-failed");
    expectError(await call(d, admin, { workshopUser: "new@example.com", principalId: "prn_rb-district-admin" }), 404, "not-found");
  });

  it("refuses duplicate accounts and duplicate principals, including concurrent confirmations", async () => {
    const d = await bootDistrict();
    const admin = d.tokenFor(NF.admin);
    const results = await Promise.all([1, 2].map(() => call(d, admin, { workshopUser: "amara@example.com", principalId: NF.amara })));
    expect(results.map(r => r.status).toSorted()).toEqual([201, 409]);
    expectError(await call(d, admin, { workshopUser: "amara@example.com", principalId: NF.morgan }), 409, "conflict");
    expectError(await call(d, admin, { workshopUser: "different@example.com", principalId: NF.amara }), 409, "conflict");
    expect((await call(d, admin)).body).toHaveLength(1);
  });

  it("does not make a district's confirmed account available to another district", async () => {
    const north = await bootDistrict();
    const river = await bootDistrict(RIVERBEND);
    await call(north, north.tokenFor(NF.admin), { workshopUser: "same@example.com", principalId: NF.amara });
    expect(await river.app.guardDirectory.guardSubject({ workshopUser: "same@example.com" })).toBeNull();
    expect((await call(river, river.tokenFor("prn_rb-district-admin"))).body).toEqual([]);
  });
});
