// `DistrictApp.serveAs` (SCHO-218): the `/api` surface for a principal the caller already verified,
// as the EducateOS connector's school pages reach it. Same routes, schemas, surfaces and policy as
// `fetch`, on the `http` channel; anyone the directory does not hold as an active principal of this
// district is nobody.
import { describe, expect, it } from "vitest";
import { DistrictId, PrincipalId, EducateOsErrorBody, type VerifiedPrincipal } from "@educateos/contracts";
import { CORRELATION_HEADER, ROUTES, routePath, type RouteInput, type RouteName } from "../src/index.ts";
import { bootDistrict, NF, NORTHFIELD, RB, RIVERBEND, type TestDistrict } from "./support.ts";

const as = (principalId: string, districtId: string = NORTHFIELD.district.id): VerifiedPrincipal =>
  ({ principalId: PrincipalId.parse(principalId), districtId: DistrictId.parse(districtId) });

/** A request for `name`, carrying no credential: the principal comes from `serveAs` alone. */
function request<N extends RouteName>(name: N, input: RouteInput<N> = {} as RouteInput<N>): Request {
  const spec = ROUTES[name];
  const parts = input as { params?: Record<string, string>; body?: unknown };
  return new Request(new URL(routePath(spec.path, parts.params), "https://district.example"), {
    method: spec.method,
    headers: { "content-type": "application/json" },
    ...(spec.method === "POST" ? { body: JSON.stringify(parts.body ?? {}) } : {}),
  });
}

async function serve<N extends RouteName>(d: TestDistrict, principal: VerifiedPrincipal, name: N, input?: RouteInput<N>) {
  const response = await d.app.serveAs(principal, request(name, input));
  const body: unknown = await response.json();
  if (response.ok) ROUTES[name].response.parse(body);
  else expect(EducateOsErrorBody.parse(body).correlationId).toBe(response.headers.get(CORRELATION_HEADER));
  return { status: response.status, body: body as Record<string, unknown> };
}

const refused = (status: number, code: string) => expect.objectContaining({ status, body: expect.objectContaining({ code }) });

describe("serving a verified principal", () => {
  it("answers a GET as the principal, exactly as their own sign-in would", async () => {
    const d = await bootDistrict();
    const served = await serve(d, as(NF.rivera), "teacher.roster", { params: { offeringId: NF.eng9 } });
    expect(served.status).toBe(200);
    expect(served.body).toStrictEqual(await d.ok(d.tokenFor(NF.rivera), "teacher.roster", { params: { offeringId: NF.eng9 } }));
    expect((await serve(d, as(NF.amara), "me.get")).body).toMatchObject({ principalId: NF.amara, kind: "student" });
  });

  it("runs a POST as the principal's own action, on the http channel", async () => {
    // A district that authors its own terms, so an administrator may create one.
    const d = await bootDistrict(NORTHFIELD, { authority: "local" });
    const created = await serve(d, as(NF.admin), "admin.createTerm", { body: { name: "Summer 2027", startsOn: "2027-06-21", endsOn: "2027-08-13" } });
    expect(created).toMatchObject({ status: 201, body: { name: "Summer 2027" } });
    const decided = d.audit.events().filter((e) => e.action === "create" && e.resourceKind === "term");
    expect(decided.map((e) => [e.principalId, e.channel, e.effect])).toStrictEqual([[NF.admin, "http", "allow"]]);
  });

  it("keeps each surface to its principal kinds, and the policy to the principal's roles", async () => {
    const d = await bootDistrict();
    expect(await serve(d, as(NF.amara), "teacher.roster", { params: { offeringId: NF.eng9 } })).toEqual(refused(403, "forbidden"));
    // Within a surface, the engine decides for the served principal as it would for their sign-in.
    for (const principalId of [NF.chen, NF.morgan]) {
      const input = { params: { offeringId: NF.eng9 } };
      const own = await d.call(d.tokenFor(principalId), "teacher.roster", input);
      const served = await serve(d, as(principalId), "teacher.roster", input);
      expect(served.status).toBe(own.status);
      // An error body differs only in its correlation ID.
      expect({ ...served.body, correlationId: "" }).toStrictEqual({ ...(own.body as object), correlationId: "" });
    }
  });

  it("refuses a principal of another district, even one with the same ID", async () => {
    const d = await bootDistrict();
    expect(await serve(d, as(RB.teacher, RIVERBEND.district.id), "me.get")).toEqual(refused(401, "unauthenticated"));
    expect(await serve(d, as(NF.rivera, RIVERBEND.district.id), "me.get")).toEqual(refused(401, "unauthenticated"));
    // A malformed principal names nobody rather than failing open.
    expect(await serve(d, { principalId: "", districtId: NORTHFIELD.district.id } as unknown as VerifiedPrincipal, "me.get"))
      .toEqual(refused(401, "unauthenticated"));
  });

  it("refuses a principal the directory does not know, or no longer holds as active", async () => {
    expect(await serve(await bootDistrict(), as("prn_nf-nobody"), "me.get")).toEqual(refused(401, "unauthenticated"));
    for (const status of ["inactive", "graduated"] as const) {
      const directory = structuredClone(NORTHFIELD);
      directory.principals.find((p) => p.id === NF.amara)!.status = status;
      const d = await bootDistrict(directory);
      expect(await serve(d, as(NF.amara), "me.get")).toEqual(refused(401, "unauthenticated"));
      expect((await serve(d, as(NF.elena), "me.get")).status).toBe(200);
    }
  });

  it("refuses the onboarding route, which answers a sign-in that is nobody's principal yet", async () => {
    const d = await bootDistrict();
    const invited = await d.ok(d.tokenFor(NF.admin), "admin.inviteGuardian", { params: { studentId: NF.amara }, body: { guardianDisplayName: "Gina Okafor" } });
    const token = new URLSearchParams(new URL(invited.invitationUrl).hash.slice(1)).get("invitation")!;
    expect(await serve(d, as(NF.admin), "onboarding.redeemGuardianInvitation", { body: { token } })).toEqual(refused(403, "forbidden"));
    // The invitation is untouched, so the guardian can still redeem it.
    expect(await d.ok(d.idp.issue("gina-okafor"), "onboarding.redeemGuardianInvitation", { body: { token } })).toEqual({ outcome: "awaiting-approval" });
  });

  it("ignores the request's own credential, and serves nothing outside the routes", async () => {
    const d = await bootDistrict();
    const signedInAsAdmin = request("me.get");
    signedInAsAdmin.headers.set("authorization", `Bearer ${d.tokenFor(NF.admin)}`);
    expect(await (await d.app.serveAs(as(NF.amara), signedInAsAdmin)).json()).toMatchObject({ principalId: NF.amara });
    expect((await d.app.serveAs(as(NF.amara), new Request("https://district.example/api/nothing"))).status).toBe(404);
  });
});
