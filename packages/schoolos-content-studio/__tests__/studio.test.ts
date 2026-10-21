import { ResourceDescriptor } from "@schoolos/registry";
import { describe, expect, it } from "vitest";
import {
  AMARA,
  BIO_SCOPE,
  CHEN,
  CURRICULUM,
  DISTRICT_SCOPE,
  ENG9_SCOPE,
  html,
  LICENSED_PAGE,
  MORGAN,
  RIVERA,
  rejectsWith,
  studio,
} from "./helpers.ts";

const CELLS = "https://open-lessons.example/cells";

describe("C03 acceptance: a teacher approves a resource with provenance before use", () => {
  it("imports, queues, approves and binds a resource, and the release carries provenance, rights and alignments", async () => {
    const { studio: s, catalog } = await studio();
    const item = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE });
    expect(item.state).toBe("reviewed");

    const queue = await s.listQueue(MORGAN, BIO_SCOPE);
    expect(queue.map((entry) => entry.itemId)).toStrictEqual([item.id]);

    const release = await s.approve(MORGAN, item.id, {
      alignments: [{ frameworkKey: "ccss-math", competencyUri: catalog.competencyUri, purpose: "teaches", evidence: "The membrane section models inputs and outputs." }],
    });
    const { descriptor } = release;
    expect(ResourceDescriptor.parse(descriptor)).toStrictEqual(descriptor);
    expect(descriptor.release.version).toBe("1.0.0");
    expect(descriptor.release.contentDigest).toBe(item.snapshotDigest);
    expect(descriptor.locator).toBe(CELLS);
    expect(descriptor.provenance).toMatchObject({ source: "official", sourceUri: CELLS, sourceRevision: item.snapshotDigest });
    expect(descriptor.license).toMatchObject({ name: "CC BY 4.0", permittedUses: ["link", "embed", "excerpt", "licensed-copy"], verification: { status: "claimed" } });
    expect(descriptor.review).toMatchObject({ status: "approved", reviewer: MORGAN.principalId });
    expect(descriptor.alignments).toStrictEqual([{
      competency: {
        competencyUri: catalog.competencyUri,
        frameworkUri: catalog.release.content.framework.uri,
        frameworkRevision: catalog.release.content.framework.provenance.sourceRevision,
      },
      purpose: "teaches",
      review: { status: "reviewed", reviewer: MORGAN.principalId, reviewedAt: descriptor.release.releasedAt },
    }]);
    expect(release.alignmentEvidence[0]?.evidence).toMatch(/membrane/);

    const binding = await s.bindToOffering(MORGAN, { resourceId: descriptor.id, offering: BIO_SCOPE });
    expect(binding).toMatchObject({ version: "1.0.0", boundBy: MORGAN.principalId });

    const trail = (await s.listAudit(MORGAN, item.id)).map((event) => event.to ?? event.type);
    expect(trail).toStrictEqual(["discovered", "quarantined", "parsed", "provenance-resolved", "reviewed", "approved", "released", "bound"]);
  });

  it("refuses to bind an item that has not been released, in every pre-release state", async () => {
    const { studio: s } = await studio();
    const item = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE });
    await rejectsWith(s.bindToOffering(MORGAN, { resourceId: item.resourceId, offering: BIO_SCOPE }), "conflict");

    await s.reject(MORGAN, item.id, { reason: "Not at grade level." });
    await rejectsWith(s.bindToOffering(MORGAN, { resourceId: item.resourceId, offering: BIO_SCOPE }), "conflict");
    await rejectsWith(s.approve(MORGAN, item.id, { alignments: [] }), "conflict");
  });

  it("refuses alignments to competencies the district's approved catalog does not have", async () => {
    const { studio: s } = await studio();
    const item = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE });
    const invented = { frameworkKey: "ccss-math", competencyUri: "https://standards.example/not-a-real-item", purpose: "teaches", evidence: "x" };
    await rejectsWith(s.approve(MORGAN, item.id, { alignments: [invented] }), "validation-failed");
    // A framework the district never approved resolves nothing either.
    await rejectsWith(s.approve(MORGAN, item.id, { alignments: [{ ...invented, frameworkKey: "ngss" }] }), "validation-failed");
    expect((await s.getReport(MORGAN, item.id)).state).toBe("reviewed");
  });
});

describe("approval authority", () => {
  it("lets a teacher act only on their own offering, and hides other offerings' items", async () => {
    const { studio: s } = await studio();
    const item = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE });

    await rejectsWith(s.getReport(RIVERA, item.id), "not-found");
    await rejectsWith(s.approve(RIVERA, item.id, { alignments: [] }), "not-found");
    await rejectsWith(s.submitUrl(RIVERA, { url: CELLS, targetScope: BIO_SCOPE }), "forbidden");
    expect(await s.listQueue(RIVERA, ENG9_SCOPE)).toStrictEqual([]);
    await rejectsWith(s.listQueue(RIVERA, BIO_SCOPE), "forbidden");
  });

  it("reserves district-wide submission and approval for a curriculum admin", async () => {
    const { studio: s } = await studio();
    await rejectsWith(s.submitUrl(MORGAN, { url: CELLS, targetScope: DISTRICT_SCOPE }), "forbidden");
    const item = await s.submitUrl(CURRICULUM, { url: CELLS, targetScope: DISTRICT_SCOPE });
    await rejectsWith(s.approve(MORGAN, item.id, { alignments: [] }), "not-found");
    const release = await s.approve(CURRICULUM, item.id, { alignments: [] });

    // A district-wide release is usable in any offering, by that offering's teacher.
    expect((await s.listReleases(RIVERA, ENG9_SCOPE)).map((r) => r.descriptor.id)).toStrictEqual([release.descriptor.id]);
    await s.bindToOffering(RIVERA, { resourceId: release.descriptor.id, offering: ENG9_SCOPE });
    // But never by someone who does not teach there.
    await rejectsWith(s.bindToOffering(MORGAN, { resourceId: release.descriptor.id, offering: ENG9_SCOPE }), "forbidden");
  });

  it("does not let a teacher bind their offering's release to another class", async () => {
    const { studio: s } = await studio();
    const item = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE });
    const { descriptor } = await s.approve(MORGAN, item.id, { alignments: [] });
    await rejectsWith(s.bindToOffering(CURRICULUM, { resourceId: descriptor.id, offering: ENG9_SCOPE }), "forbidden");
  });

  it("gives co-teachers and students no studio authority", async () => {
    const { studio: s } = await studio();
    await rejectsWith(s.submitUrl(CHEN, { url: CELLS, targetScope: ENG9_SCOPE }), "forbidden");
    await rejectsWith(s.submitUrl(AMARA, { url: CELLS, targetScope: BIO_SCOPE }), "forbidden");
    const item = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE });
    await rejectsWith(s.getReport(AMARA, item.id), "not-found");
  });

  it("refuses a subject from another district", async () => {
    const { studio: s } = await studio();
    const item = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE });
    const outsider = { principalId: MORGAN.principalId, districtId: "dst_riverbend" } as typeof MORGAN;
    await rejectsWith(s.getReport(outsider, item.id), "not-found");
    await rejectsWith(s.submitUrl(outsider, { url: CELLS, targetScope: BIO_SCOPE }), "forbidden");
  });
});

describe("source updates", () => {
  it("creates a new release for an updated source and keeps the prior approved release", async () => {
    let page = LICENSED_PAGE;
    const { studio: s } = await studio({ routes: { [CELLS]: () => html(page)() } });
    const first = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE });
    const v1 = await s.approve(MORGAN, first.id, { alignments: [] });
    await s.bindToOffering(MORGAN, { resourceId: v1.descriptor.id, offering: BIO_SCOPE });

    // An unchanged source is not a new revision.
    await rejectsWith(s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE, updatesResourceId: v1.descriptor.id }), "conflict");

    page = LICENSED_PAGE.replace("Every living thing", "All known living things");
    const second = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE, updatesResourceId: v1.descriptor.id });
    expect(second.resourceId).toBe(v1.descriptor.id);
    // Until the update is approved, the latest usable release is still 1.0.0.
    expect((await s.bindToOffering(MORGAN, { resourceId: v1.descriptor.id, offering: BIO_SCOPE })).version).toBe("1.0.0");

    const v2 = await s.approve(MORGAN, second.id, { alignments: [] });
    expect(v2.descriptor.release.version).toBe("2.0.0");
    expect(v2.descriptor.release.contentDigest).not.toBe(v1.descriptor.release.contentDigest);

    const releases = await s.listReleases(MORGAN, BIO_SCOPE, v1.descriptor.id);
    expect(releases.map((r) => r.descriptor)).toStrictEqual([v1.descriptor, v2.descriptor]);
    expect((await s.bindToOffering(MORGAN, { resourceId: v1.descriptor.id, version: "1.0.0", offering: BIO_SCOPE })).version).toBe("1.0.0");
  });

  it("refuses an update aimed at a different scope than the resource's release", async () => {
    let page = LICENSED_PAGE;
    const { studio: s } = await studio({ routes: { [CELLS]: () => html(page)() } });
    const first = await s.submitUrl(CURRICULUM, { url: CELLS, targetScope: DISTRICT_SCOPE });
    const v1 = await s.approve(CURRICULUM, first.id, { alignments: [] });
    page = `${LICENSED_PAGE} `;
    await rejectsWith(s.submitUrl(CURRICULUM, { url: CELLS, targetScope: BIO_SCOPE, updatesResourceId: v1.descriptor.id }), "validation-failed");
  });
});

describe("publication", () => {
  it("publishes only released items", async () => {
    const { studio: s } = await studio();
    const item = await s.submitUrl(MORGAN, { url: CELLS, targetScope: BIO_SCOPE });
    await rejectsWith(s.publish(MORGAN, item.id), "conflict");
    await s.approve(MORGAN, item.id, { alignments: [] });
    expect((await s.publish(MORGAN, item.id)).state).toBe("published");
  });
});
