// NRPS roster projections applied to the district directory through AcademicSync (SCHO-76).
import { describe, expect, it } from "vitest";
import { SchoolId, type AuthorityMap, type DistrictDirectorySnapshot, type Enrollment, type RosterProjection } from "@schoolos/contracts";
import { LtiRosterSync } from "../src/index.ts";
import {
  AMARA,
  BIO,
  BIO_CONTEXT,
  CANVAS_ENROLLMENTS,
  canvasRegistration,
  createDistrict,
  DMITRI,
  ELENA,
  ENG9,
  FELIX,
  MORGAN,
  NF,
  NF_CANVAS,
  NORTHFIELD_CANVAS,
  PATEL,
  rejection,
  RIVERA,
  SUBJECTS,
} from "./setup.ts";

type Member = [subject: string, status: "active" | "inactive" | "deleted", roles?: string[]];

function projection(observedAt: string, members: Member[], overrides: Partial<RosterProjection> = {}): RosterProjection {
  return {
    districtId: NF,
    offeringId: BIO,
    source: { kind: "lti-nrps", issuer: NF_CANVAS, clientId: "10000000000001", contextId: BIO_CONTEXT },
    observedAt,
    members: members.map(([subject, status, roles = []]) => ({
      identity: { districtId: NF, issuer: NF_CANVAS, subject },
      status,
      untrustedPlatformRoles: roles,
    })),
    ...overrides,
  };
}

const INSTRUCTOR = "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor";
const ADMINISTRATOR = "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator";

async function setup(options: { authority?: AuthorityMap; directory?: DistrictDirectorySnapshot } = {}) {
  const district = createDistrict(options.directory);
  await district.stores.registrations.save(canvasRegistration());
  const sync = new LtiRosterSync({
    districtId: NF,
    store: district.academics,
    authority: options.authority ?? CANVAS_ENROLLMENTS,
    registrations: district.stores.registrations,
    sources: district.stores.rosterSources,
  });
  const enrollment = async (principalId: string, offeringId = BIO): Promise<Enrollment | undefined> =>
    (await district.academics.load()).snapshot.enrollments.find((e) => e.offeringId === offeringId && e.principalId === principalId);
  return { ...district, sync, enrollment };
}

describe("LtiRosterSync (SCHO-76)", () => {
  it("applies a roster by identity link, with roles from the district and never from the platform", async () => {
    const { sync, enrollment, academics } = await setup();
    const before = (await academics.load()).snapshot.enrollments.length;
    const result = await sync.apply(
      projection("2026-10-21T10:00:00Z", [
        [SUBJECTS[AMARA]!, "active", [INSTRUCTOR]],
        [SUBJECTS[MORGAN]!, "active", [INSTRUCTOR]],
        [SUBJECTS[DMITRI]!, "active"],
        [SUBJECTS[ELENA]!, "active"],
        [SUBJECTS[FELIX]!, "active", [INSTRUCTOR, ADMINISTRATOR]],
        [SUBJECTS[RIVERA]!, "active", [INSTRUCTOR, ADMINISTRATOR]],
        ["lti-someone-unlinked", "active", [INSTRUCTOR]],
      ]),
    );
    expect(result).toEqual({ added: 1, updated: 0, deactivated: 0, unlinked: 1, unassigned: 1 });
    // Amara stays a student though the platform calls her an instructor; Felix joins as a student.
    expect(await enrollment(AMARA)).toMatchObject({ role: "student", status: "active" });
    expect(await enrollment(FELIX)).toMatchObject({ role: "student", status: "active", id: expect.stringMatching(/^enr_lti-[0-9a-f]{32}$/) });
    // Rivera is staff with no place in Biology: an LMS cannot make her its teacher.
    expect(await enrollment(RIVERA)).toBeUndefined();
    expect((await academics.load()).snapshot.enrollments.length).toBe(before + 1);
  });

  it("marks departed, inactive and deleted members inactive, and deletes nothing", async () => {
    const { sync, enrollment, academics } = await setup();
    const everyone: Member[] = [AMARA, MORGAN, DMITRI, ELENA, FELIX].map((id) => [SUBJECTS[id]!, "active"]);
    await sync.apply(projection("2026-10-21T10:00:00Z", everyone));
    const count = (await academics.load()).snapshot.enrollments.length;

    const result = await sync.apply(
      projection("2026-10-21T11:00:00Z", [
        [SUBJECTS[AMARA]!, "active"],
        [SUBJECTS[MORGAN]!, "active"],
        [SUBJECTS[ELENA]!, "deleted"],
        [SUBJECTS[FELIX]!, "inactive"],
      ]),
    );
    expect(result).toMatchObject({ added: 0, deactivated: 3 });
    expect(await enrollment(DMITRI)).toMatchObject({ status: "inactive" });
    expect(await enrollment(ELENA)).toMatchObject({ status: "inactive" });
    expect(await enrollment(FELIX)).toMatchObject({ status: "inactive" });
    expect(await enrollment(AMARA)).toMatchObject({ status: "active" });
    expect((await academics.load()).snapshot.enrollments.length).toBe(count);

    // A member who returns is active again, under the same enrollment.
    const dmitri = (await enrollment(DMITRI))!.id;
    await sync.apply(projection("2026-10-21T12:00:00Z", [[SUBJECTS[DMITRI]!, "active"], [SUBJECTS[AMARA]!, "active"], [SUBJECTS[MORGAN]!, "active"]]));
    expect(await enrollment(DMITRI)).toMatchObject({ id: dmitri, status: "active" });
  });

  it("records a source link for every enrollment it writes", async () => {
    const { sync, stores, enrollment } = await setup();
    await sync.apply(projection("2026-10-21T10:00:00Z", [[SUBJECTS[FELIX]!, "active"]]));
    const key = JSON.stringify([BIO, NF_CANVAS, "10000000000001", BIO_CONTEXT]);
    const state = await stores.rosterSources.load(key);
    expect(state.observedAt).toBe("2026-10-21T10:00:00Z");
    expect(state.enrollments[(await enrollment(FELIX))!.id]).toEqual({ system: "canvas", sourcedId: SUBJECTS[FELIX], lastSeenAt: "2026-10-21T10:00:00Z" });
  });

  it("does not enroll a principal that is not active, whatever the platform says", async () => {
    const directory: DistrictDirectorySnapshot = {
      ...NORTHFIELD_CANVAS,
      principals: NORTHFIELD_CANVAS.principals.map((p) => (p.id === FELIX ? { ...p, status: "graduated" as const } : p.id === AMARA ? { ...p, status: "inactive" as const } : p)),
    };
    const { sync, enrollment } = await setup({ directory });
    const result = await sync.apply(projection("2026-10-21T10:00:00Z", [[SUBJECTS[FELIX]!, "active"], [SUBJECTS[AMARA]!, "active"]]));
    expect(await enrollment(FELIX)).toBeUndefined();
    expect(await enrollment(AMARA)).toMatchObject({ status: "inactive" });
    expect(result).toMatchObject({ added: 0, deactivated: 1 });
  });

  it("takes a staff role from a district roster assignment at the offering", async () => {
    const directory: DistrictDirectorySnapshot = {
      ...NORTHFIELD_CANVAS,
      principals: NORTHFIELD_CANVAS.principals.map((p) =>
        p.id === PATEL ? { ...p, externalIdentities: [...p.externalIdentities, { districtId: NF, issuer: NF_CANVAS, subject: "lti-patel" }] } : p,
      ),
      roleAssignments: [
        ...NORTHFIELD_CANVAS.roleAssignments,
        { principalId: PATEL, role: "co-teacher", scope: { level: "offering", districtId: NF, schoolId: SchoolId.parse("sch_nf-high"), offeringId: BIO }, source: "roster" },
      ],
    };
    const { sync, enrollment } = await setup({ directory });
    await sync.apply(projection("2026-10-21T10:00:00Z", [["lti-patel", "active", []]]));
    expect(await enrollment(PATEL)).toMatchObject({ role: "co-teacher", status: "active" });
  });

  it("applies nothing unless the authority map names the registration's provider for enrollments", async () => {
    for (const enrollmentAuthority of ["local", "external:oneroster"] as const) {
      const { sync, academics } = await setup({ authority: { ...CANVAS_ENROLLMENTS, enrollment: enrollmentAuthority } });
      const before = await academics.load();
      expect(await rejection(sync.apply(projection("2026-10-21T10:00:00Z", [[SUBJECTS[FELIX]!, "active"]])))).toBe("conflict");
      expect((await academics.load()).version).toBe(before.version);
    }
  });

  it("refuses a stale projection, another district's, and a context the registration does not map to the offering", async () => {
    const { sync } = await setup();
    await sync.apply(projection("2026-10-21T10:00:00Z", [[SUBJECTS[FELIX]!, "active"]]));
    expect(await rejection(sync.apply(projection("2026-10-21T10:00:00Z", [])))).toBe("conflict");
    expect(await rejection(sync.apply(projection("2026-10-21T09:00:00Z", [])))).toBe("conflict");
    expect(await rejection(sync.apply(projection("2026-10-21T11:00:00Z", [], { districtId: "dst_riverbend" as never })))).toBe("forbidden");
    expect(await rejection(sync.apply(projection("2026-10-21T11:00:00Z", [], { offeringId: ENG9 })))).toBe("forbidden");
    expect(
      await rejection(
        sync.apply(projection("2026-10-21T11:00:00Z", [], { source: { kind: "lti-nrps", issuer: NF_CANVAS, clientId: "unknown", contextId: BIO_CONTEXT } })),
      ),
    ).toBe("not-found");
    const foreign = projection("2026-10-21T11:00:00Z", [[SUBJECTS[FELIX]!, "active"]]);
    foreign.members[0]!.identity.issuer = "https://idp.northfield.example";
    expect(await rejection(sync.apply(foreign))).toBe("validation-failed");
  });
});
