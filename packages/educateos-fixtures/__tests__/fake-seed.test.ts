import { describe, expect, it } from "vitest";
import { CleverDataFake, DEFAULT_ONEROSTER_CLIENT, GoogleClassroomFake, OIDC_PRESETS, OidcFake, OneRosterFake, validateSeed } from "@educateos/provider-fakes";
import { DEMO_DISTRICTS, classroomSeed, cleverSeed, demoDistrict, fakeSeed } from "../src/index.ts";

const subjectOf = (slug: Parameters<typeof demoDistrict>[0], principalId: string) =>
  demoDistrict(slug).directory.principals.find((p) => p.id === principalId)!.externalIdentities[0]!.subject;

describe("fakeSeed", () => {
  it("adapts every demo district to a valid seed with its people and active rosters", () => {
    for (const demo of DEMO_DISTRICTS) {
      const seed = validateSeed(fakeSeed(demo));
      expect(seed.people.map((p) => p.id).toSorted()).toEqual(demo.directory.principals.map((p) => p.id).toSorted());
      for (const section of seed.sections) {
        const active = demo.directory.enrollments.filter((e) => e.offeringId === section.id && e.role === "student" && e.status === "active");
        expect(section.studentIds.toSorted()).toEqual(active.map((e) => e.principalId).toSorted());
      }
    }
  });

  it("leaves a dropped student off the section roster", () => {
    // Dmitri Novak's English 9 enrollment is inactive in the fixtures.
    const eng9 = fakeSeed(demoDistrict("northfield")).sections.find((s) => s.id === "off_nf-eng9-fall-p3")!;
    expect(eng9.studentIds).not.toContain("prn_nf-student-dmitri");
    expect(eng9.teacherIds).toEqual(["prn_nf-teacher-rivera", "prn_nf-teacher-chen"]);
  });

  it("makes Clever sign-in and the Clever Data API assert Cedar Valley's own subjects", () => {
    const demo = demoDistrict("cedarvalley");
    const seed = fakeSeed(demo);
    const sso = new OidcFake({ seed, preset: OIDC_PRESETS.clever, clients: [] });
    const data = new CleverDataFake({ seed });
    for (const principal of demo.directory.principals) {
      expect(sso.subjectOf(principal.id)).toBe(principal.externalIdentities[0]!.subject);
      expect(data.userId(principal.id)).toBe(principal.externalIdentities[0]!.subject);
    }
    expect(cleverSeed(demo).users.map((u) => u.id).toSorted()).toEqual(demo.directory.principals.map((p) => data.userId(p.id)).toSorted());
  });

  it("makes Google sign-in and Classroom agree with the Classroom seed, which is Harbor's subjects", () => {
    for (const slug of ["harbor", "cedarvalley"] as const) {
      const demo = demoDistrict(slug);
      const seed = fakeSeed(demo);
      const sso = new OidcFake({ seed, preset: OIDC_PRESETS.google, clients: [] });
      const classroom = new GoogleClassroomFake({ seed });
      for (const user of classroomSeed(demo).users) {
        expect(classroom.userId(user.fixtureId)).toBe(user.id);
        expect(sso.subjectOf(user.fixtureId)).toBe(user.id);
      }
    }
    expect(new GoogleClassroomFake({ seed: fakeSeed(demoDistrict("harbor")) }).userId("prn_hb-student-nia")).toBe(subjectOf("harbor", "prn_hb-student-nia"));
  });

  it("serves each OneRoster user with their IdP subject as username, as Lakeshore's ClassLink asserts it", async () => {
    const seed = fakeSeed(demoDistrict("lakeshore"));
    expect(seed.people.find((p) => p.id === "prn_ls-teacher-raman")!.username).toBe("ls-t-301");
    const sis = new OneRosterFake({ seed });
    const token = await sis.fetch(sis.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${btoa(`${DEFAULT_ONEROSTER_CLIENT.clientId}:${DEFAULT_ONEROSTER_CLIENT.clientSecret}`)}` },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://purl.imsglobal.org/spec/or/v1p2/scope/roster-core.readonly" }),
    });
    const { access_token } = (await token.json()) as { access_token: string };
    const users = await sis.fetch(`${sis.baseUrl}/ims/oneroster/rostering/v1p2/users/prn_ls-teacher-raman`, { headers: { authorization: `Bearer ${access_token}` } });
    expect(((await users.json()) as { user: { username: string } }).user.username).toBe("ls-t-301");
  });
});
