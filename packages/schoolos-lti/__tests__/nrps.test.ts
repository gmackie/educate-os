import { describe, expect, it } from "vitest";
import { createDirectoryPrincipalResolver } from "@schoolos/identity";
import { NrpsClient, RosterProjection } from "../src/index.ts";
import { NORTHFIELD_LTI, rejection } from "./helpers.ts";
import { AMARA_SUB, BIO, BIO_CONTEXT, createServicesWorld, type ServicesWorld } from "./services-helpers.ts";

const ROLE = "http://purl.imsglobal.org/vocab/lis/v2/";

function roster(count: number) {
  return Array.from({ length: count }, (_, i) => ({ user_id: `lti-user-${1000 + i}`, roles: [`${ROLE}membership#Learner`] }));
}

const bioServices = (world: ServicesWorld) => world.canvas.contextServices(BIO_CONTEXT);

function limited(world: ServicesWorld, limits: { maxMembers?: number; maxPages?: number }): NrpsClient {
  return new NrpsClient({ services: world.services, registrations: world.registrations, limits, now: world.clock.now });
}

describe("NRPS", () => {
  it("follows Link rel=next through every page and projects the whole roster", async () => {
    const world = await createServicesWorld();
    world.canvas.pageSize = 2;
    world.canvas.members.set(BIO_CONTEXT, roster(5));
    const projection = await world.nrps.rosterProjection(world.canvas.contextServices(BIO_CONTEXT));

    expect(RosterProjection.parse(projection)).toEqual(projection);
    expect(projection).toMatchObject({
      districtId: "dst_northfield",
      offeringId: BIO,
      source: { kind: "lti-nrps", issuer: world.canvas.platform.issuer, contextId: BIO_CONTEXT },
    });
    expect(projection.members.map((member) => member.identity.subject)).toEqual(roster(5).map((member) => member.user_id));
    const pages = world.canvas.requests.filter((request) => request.url.includes("names_and_roles"));
    expect(pages).toHaveLength(3);
    // One token served every page.
    expect(world.canvas.tokenRequests).toHaveLength(1);
  });

  it("refuses a roster over the member cap rather than returning part of it", async () => {
    const world = await createServicesWorld();
    world.canvas.pageSize = 3;
    world.canvas.members.set(BIO_CONTEXT, roster(7));
    const services = world.canvas.contextServices(BIO_CONTEXT);
    expect(await rejection(limited(world, { maxMembers: 6 }).rosterProjection(services))).toBe("validation-failed");
    await expect(limited(world, { maxMembers: 7 }).rosterProjection(services)).resolves.toBeDefined();
  });

  it("refuses a roster over the page cap, and a paging loop", async () => {
    const world = await createServicesWorld();
    world.canvas.pageSize = 1;
    world.canvas.members.set(BIO_CONTEXT, roster(4));
    const services = world.canvas.contextServices(BIO_CONTEXT);
    expect(await rejection(limited(world, { maxPages: 3 }).rosterProjection(services))).toBe("validation-failed");

    world.canvas.linkOverride = () => `<${world.canvas.membershipsUrl(BIO_CONTEXT)}>; rel="next"`;
    expect(await rejection(world.nrps.rosterProjection(services))).toBe("validation-failed");
  });

  it("never follows a next link to another origin, so the token stays with the platform", async () => {
    const world = await createServicesWorld();
    world.canvas.pageSize = 1;
    world.canvas.members.set(BIO_CONTEXT, roster(2));
    world.canvas.linkOverride = (page) => (page === 1 ? '<https://collector.attacker.example/roster>; rel="next"' : undefined);
    expect(await rejection(world.nrps.rosterProjection(world.canvas.contextServices(BIO_CONTEXT)))).toBe("forbidden");
    expect(world.fetched.some((url) => url.includes("attacker.example"))).toBe(false);
  });

  it("refuses malformed members instead of defaulting them", async () => {
    for (const bad of [{ roles: [] }, { user_id: "", roles: [] }, { user_id: "x", roles: [], status: "Suspended" }, { user_id: "x" }]) {
      const world = await createServicesWorld();
      world.canvas.members.set(BIO_CONTEXT, [bad as never]);
      expect(await rejection(world.nrps.rosterProjection(bioServices(world)))).toBe("validation-failed");
    }
    const world = await createServicesWorld();
    world.canvas.members.set(BIO_CONTEXT, [{ user_id: "x", roles: [] }, { user_id: "x", roles: [] }]);
    expect(await rejection(world.nrps.rosterProjection(bioServices(world)))).toBe("validation-failed");
  });

  it("refuses a container for another context and a context the registration does not map", async () => {
    const world = await createServicesWorld();
    world.canvas.members.set("nf-canvas-course-eng9-p3", roster(1));
    const forBio = world.canvas.contextServices(BIO_CONTEXT);
    // The platform answers Biology's URL with English 9's container.
    const swapped = { ...forBio, nrps: { membershipsUrl: world.canvas.membershipsUrl("nf-canvas-course-eng9-p3") } };
    expect(await rejection(world.nrps.rosterProjection(swapped))).toBe("validation-failed");
    expect(await rejection(world.nrps.rosterProjection(world.canvas.contextServices("canvas-course-unmapped")))).toBe("forbidden");
  });

  it("keeps platform roles as untrusted metadata and drops names and emails", async () => {
    const world = await createServicesWorld();
    world.canvas.members.set(BIO_CONTEXT, [
      {
        user_id: AMARA_SUB,
        // Canvas says Amara is an administrator and instructor of this course.
        roles: [`${ROLE}institution/person#Administrator`, `${ROLE}membership#Instructor`],
        status: "Active",
        name: "Amara Okafor",
        email: "amara@northfield.example",
        lis_person_sourcedid: "sis-2001",
      },
      { user_id: "lti-user-left", roles: [`${ROLE}membership#Learner`], status: "Deleted" },
    ]);
    const projection = await world.nrps.rosterProjection(world.canvas.contextServices(BIO_CONTEXT));

    expect(projection.members[0]).toEqual({
      identity: { districtId: "dst_northfield", issuer: world.canvas.platform.issuer, subject: AMARA_SUB },
      status: "active",
      untrustedPlatformRoles: [`${ROLE}institution/person#Administrator`, `${ROLE}membership#Instructor`],
    });
    expect(projection.members[1]!.status).toBe("deleted");
    expect(JSON.stringify(projection)).not.toMatch(/Okafor|amara@|sis-2001/);

    // The identity link is the only bridge to the directory, and the directory still says student.
    const resolver = createDirectoryPrincipalResolver(NORTHFIELD_LTI);
    const principal = await resolver.resolve({ ...projection.members[0]!.identity, credential: "person" });
    expect(principal).toMatchObject({ principalId: "prn_nf-student-amara", kind: "student" });
  });

  it("is refused when the platform offers no roster service", async () => {
    const world = await createServicesWorld();
    const { nrps: _, ...withoutNrps } = world.canvas.contextServices(BIO_CONTEXT);
    expect(await rejection(world.nrps.rosterProjection(withoutNrps))).toBe("conflict");
  });
});
