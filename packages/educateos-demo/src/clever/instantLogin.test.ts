import { describe, expect, it } from "vitest";
import { demoDistrict, districtSeed } from "@educateos/fixtures";
import { CleverDataFake, generatePlatformKey } from "@educateos/provider-fakes";
import { bootCedarValley, type CedarValleyDistrict } from "../districts/cedarvalley.ts";
import { CEDARVALLEY_PERSONAS } from "../districts/cedarvalleyPersonas.ts";
import { CEDARVALLEY_HOSTNAME, cleverFor, districtSignIn, Hops, inPageClever, instantLogin, type InstantLoginResult } from "./instantLogin.ts";

const subjectOf = (id: string) => CEDARVALLEY_PERSONAS.find((p) => p.id === id)!.subject;
const hopIds = (result: InstantLoginResult) => result.hops.map((hop) => hop.id);

/** Signs `id` in through the portal, failing the test unless it signs in. */
async function signIn(district: CedarValleyDistrict, id: string) {
  const result = await instantLogin(cleverFor(district), subjectOf(id), district);
  if (result.outcome !== "signed-in") throw new Error(`${id} was refused at ${result.at}: ${result.reason}`);
  return result;
}

describe("Clever Instant Login", () => {
  it("launches through the control plane's shared launch to Cedar Valley, and signs each persona in as themselves", async () => {
    const district = await bootCedarValley();
    await district.roster.sync();
    const seen: string[] = [];
    const result = await instantLogin(cleverFor(district), subjectOf("teacher"), district, { onHop: (hop) => seen.push(hop.id) });
    expect(result).toMatchObject({
      outcome: "signed-in",
      redirect: `https://${CEDARVALLEY_HOSTNAME}/`,
      identity: { issuer: district.cleverSso.issuer, subject: subjectOf("teacher"), credential: "person" },
      principal: { displayName: "Dana Whitaker" },
    });
    expect(hopIds(result)).toEqual([
      "portal-link",
      "portal-authorize",
      "launch-code-exchange",
      "launch-me",
      "launch-redirect",
      "sign-in-authorize",
      "sign-in-code-exchange",
      "id-token",
      "user-record",
      "district-match",
      "principal",
    ]);
    expect(seen).toEqual(hopIds(result));
    expect(result.hops.every((hop) => hop.ok)).toBe(true);

    const hop = (id: string) => result.hops.find((h) => h.id === id)!;
    expect(hop("portal-link").exchange!.url).toBe(`https://clever.com/oauth/instant-login?client_id=d3m0c1e7e2b4a6f8e0c2&district_id=${district.clever.districtId}`);
    expect(hop("portal-authorize").exchange!.location).toMatch(/^https:\/\/educateos\.io\/clever\/launch\?code=[0-9a-f]{6}…$/);
    expect(hop("launch-me").exchange!.body).toMatchObject({ data: { id: subjectOf("teacher"), district: district.clever.districtId, authorized_by: "district" } });
    expect(hop("id-token").data!["claims"]).toMatchObject({ iss: "https://clever.com", district: district.clever.districtId, user_type: "teacher", multi_role_user_id: subjectOf("teacher") });
    expect(hop("user-record").exchange!.body).toMatchObject({ data: { id: subjectOf("teacher"), name: { first: "Dana", last: "Whitaker" } } });
    // Codes and tokens are shown only as prefixes, and the client secret never.
    const shown = JSON.stringify(result.hops);
    expect(shown).not.toContain("demo-only-not-a-clever-secret");
    expect(shown).not.toMatch(/"(access_token|id_token)":"[^"]{8,}"/);

    // The session is the district's bearer: it signs requests in as Dana.
    if (result.outcome !== "signed-in") throw new Error("refused");
    expect(await district.clientFor(result.session).call("me.get")).toMatchObject({ displayName: "Dana Whitaker" });
    for (const id of ["student", "admin"]) {
      expect((await signIn(district, id)).principal?.displayName).toBe(CEDARVALLEY_PERSONAS.find((p) => p.id === id)!.name);
    }
  });

  it("accepts no bare subject as a bearer: only a session a sign-in started", async () => {
    const district = await bootCedarValley();
    await expect(district.clientFor(subjectOf("admin")).call("me.get")).rejects.toMatchObject({ status: 401 });
    const { session } = await signIn(district, "admin");
    expect(await district.clientFor(session).call("me.get")).toMatchObject({ displayName: "Elaine Park" });
  });

  it("refuses a Clever sign-in from another district, at the launch and at the district", async () => {
    const district = await bootCedarValley();
    // Clever signs every district's tokens with the same keys, so the other district's verify.
    const key = await generatePlatformKey();
    const home = inPageClever(district.clever, key);
    const elsewhere = inPageClever(new CleverDataFake({ seed: districtSeed(demoDistrict("lakeshore")) }), key);
    const stranger = elsewhere.oidc.subjectOf(elsewhere.oidc.seed.people.find((p) => p.role === "teacher")!.id);

    // The launch finds no EducateOS registered for the stranger's Clever district.
    const launched = await instantLogin(elsewhere, stranger, district);
    expect(launched).toMatchObject({ outcome: "refused", at: "launch-redirect", reason: "Your district isn't set up for Clever launch" });

    // A validly signed id_token from the other district is refused by Cedar Valley's sign-in.
    const hops = new Hops();
    expect(await districtSignIn(elsewhere, stranger, district, hops)).toMatchObject({ at: "district-match", reason: "The Clever sign-in is from another district." });
    expect(hops.list.find((hop) => hop.id === "id-token")!.ok).toBe(true);
    expect(hops.list.some((hop) => hop.id === "principal")).toBe(false);

    // The same key signs Cedar Valley's own people in.
    expect(await districtSignIn(home, subjectOf("admin"), district, new Hops())).toMatchObject({ principal: { displayName: "Elaine Park" } });
  });

  it("signs the administrator in before the first sync, and leaves the rostered unresolved until it runs", async () => {
    const district = await bootCedarValley();
    expect((await signIn(district, "admin")).principal).toMatchObject({ displayName: "Elaine Park" });
    for (const id of ["teacher", "student"]) {
      const result = await signIn(district, id);
      expect(result.principal).toBeUndefined();
      expect(result.hops.at(-1)).toMatchObject({ id: "principal", ok: false });
      await expect(district.clientFor(result.session).call("me.get")).rejects.toMatchObject({ status: 401 });
    }
  });
});
