import { describe, expect, it } from "vitest";
import {
  CompetencyAssociation,
  CurriculumPack,
  EvidenceContract,
  FrameworkDefinition,
  ResourceDescriptor,
} from "../src/index.ts";

const derived = {
  source: "derived",
  sourceUri: "https://registry.example/crosswalks/earth-science",
  retrievedAt: "2026-10-01T00:00:00Z",
  sourceRevision: "1",
} as const;

const reviewed = { reviewer: "prn_reviewer-1", reviewedAt: "2026-10-02T00:00:00Z" } as const;

const association = (relation: string, evidence: unknown[]) => ({
  uri: "https://registry.example/associations/1",
  identifier: "0d4c2a5e-1111-4222-8333-444455556666",
  relation,
  origin: { title: "A", identifier: "a", uri: "https://case.registry.example/uri/a" },
  destination: { title: "B", identifier: "b", uri: "https://other-publisher.example/uri/b" },
  lastChangeDateTime: "2026-10-01T00:00:00Z",
  evidence,
  provenance: derived,
});

describe("competency associations", () => {
  const ai = { basis: "ai-similarity", model: "example-embedder", score: 0.99 };

  it("never lets AI similarity alone establish an exact equivalence", () => {
    expect(CompetencyAssociation.safeParse(association("exact", [ai])).success).toBe(false);
  });

  it("lets AI similarity support a weaker crosswalk relation", () => {
    for (const relation of ["close", "partial", "broader", "narrower"]) {
      expect(CompetencyAssociation.safeParse(association(relation, [ai])).success, relation).toBe(true);
    }
  });

  it("accepts an exact equivalence once a named reviewer accepts it", () => {
    const evidence = [ai, { basis: "human-review", ...reviewed }];
    expect(CompetencyAssociation.safeParse(association("exact", evidence)).success).toBe(true);
  });

  it("requires evidence, and a reviewer that is a principal ID rather than a name or email", () => {
    expect(CompetencyAssociation.safeParse(association("close", [])).success).toBe(false);
    const byEmail = { basis: "human-review", reviewer: "reviewer@district.example", reviewedAt: reviewed.reviewedAt };
    expect(CompetencyAssociation.safeParse(association("exact", [byEmail])).success).toBe(false);
  });

  it("keeps opaqueType only on opaque relations", () => {
    const publisher = [{ basis: "publisher-assertion", sourceUri: "https://case.registry.example/uri/x" }];
    expect(CompetencyAssociation.safeParse(association("opaque", publisher)).success).toBe(false);
    expect(CompetencyAssociation.safeParse({ ...association("related", publisher), opaqueType: "covers" }).success)
      .toBe(false);
  });
});

describe("provenance", () => {
  const framework = {
    uri: "https://case.registry.example/uri/f",
    identifier: "0d4c2a5e-1111-4222-8333-444455556666",
    title: "Framework",
    creator: "Example District",
    lastChangeDateTime: "2026-10-01T00:00:00Z",
  };

  it("is required on every record and distinguishes official from derived content", () => {
    expect(FrameworkDefinition.safeParse(framework).success).toBe(false);
    expect(FrameworkDefinition.safeParse({ ...framework, provenance: { ...derived, source: "generated" } }).success)
      .toBe(false);
    const parsed = FrameworkDefinition.parse({ ...framework, provenance: derived });
    expect(parsed.provenance.source).toBe("derived");
  });
});

const resource = {
  id: "rsc_water-cycle-lab",
  release: {
    version: "1.0.0",
    releasedAt: "2026-10-01T00:00:00Z",
    contentDigest: `sha256:${"a".repeat(64)}`,
  },
  kind: "interactive",
  title: "Synthetic water cycle lab",
  locator: "https://content.example/labs/water-cycle",
  license: { name: "Example Open License", permittedUses: ["link", "embed"], verification: { status: "claimed" } },
  audience: { educationLevels: ["9-12"], ageRange: { minYears: 14, maxYears: 18 } },
  accessibility: { features: ["captions"], hazards: [] },
  alignments: [{
    competency: {
      competencyUri: "https://case.registry.example/uri/i2",
      frameworkUri: "https://case.registry.example/uri/doc",
      frameworkRevision: "2026.1",
    },
    purpose: "teaches",
    review: { status: "suggested" },
  }],
  review: { status: "unreviewed" },
  provenance: derived,
};

describe("resource descriptors", () => {
  it("accepts an unreviewed resource whose rights and alignments are only claims", () => {
    expect(ResourceDescriptor.safeParse(resource).success).toBe(true);
  });

  it("requires a named reviewer to approve a resource, verify its rights or confirm an alignment", () => {
    expect(ResourceDescriptor.safeParse({ ...resource, review: { status: "approved" } }).success).toBe(false);
    expect(ResourceDescriptor.safeParse({
      ...resource,
      license: { ...resource.license, verification: { status: "verified" } },
    }).success).toBe(false);
    expect(ResourceDescriptor.safeParse({
      ...resource,
      alignments: [{ ...resource.alignments[0], review: { status: "reviewed" } }],
    }).success).toBe(false);
    expect(ResourceDescriptor.safeParse({ ...resource, review: { status: "approved", ...reviewed } }).success)
      .toBe(true);
  });

  it("pins each release to a content digest and each alignment to a framework revision", () => {
    expect(ResourceDescriptor.safeParse({ ...resource, release: { ...resource.release, contentDigest: "latest" } }).success)
      .toBe(false);
    const { frameworkRevision: _, ...unpinned } = resource.alignments[0]!.competency;
    expect(ResourceDescriptor.safeParse({
      ...resource,
      alignments: [{ ...resource.alignments[0], competency: unpinned }],
    }).success).toBe(false);
  });

  it("rejects an inverted age range", () => {
    expect(ResourceDescriptor.safeParse({ ...resource, audience: { ageRange: { minYears: 18, maxYears: 14 } } }).success)
      .toBe(false);
  });
});

describe("curriculum packs and evidence contracts", () => {
  const pack = {
    id: "pck_earth-science",
    release: resource.release,
    title: "Synthetic earth science",
    audience: { educationLevels: ["9-12"] },
    units: [{ unitId: "unt_water-cycle", releaseVersion: "1.0.0" }],
    review: { status: "unreviewed" },
    provenance: derived,
  };

  it("lists each unit once and only under its own ID kind", () => {
    expect(CurriculumPack.safeParse(pack).success).toBe(true);
    expect(CurriculumPack.safeParse({ ...pack, units: [pack.units[0], pack.units[0]] }).success).toBe(false);
    expect(CurriculumPack.safeParse({ ...pack, units: [{ unitId: "rsc_water-cycle", releaseVersion: "1.0.0" }] }).success)
      .toBe(false);
  });

  const contract = {
    id: "evc_water-cycle-model",
    version: 1,
    title: "Model the water cycle",
    competencies: [resource.alignments[0]!.competency],
    responseType: "artifact",
    criteria: [{ id: "labels-energy-source", description: "Labels the energy source." }],
    restrictions: { aiAssistance: "allowed-with-disclosure", collaboration: "individual" },
    provenance: { ...derived, source: "district-authored" },
  };

  it("requires uniquely named observable criteria", () => {
    expect(EvidenceContract.safeParse(contract).success).toBe(true);
    expect(EvidenceContract.safeParse({ ...contract, criteria: [] }).success).toBe(false);
    expect(EvidenceContract.safeParse({ ...contract, criteria: [contract.criteria[0], contract.criteria[0]] }).success)
      .toBe(false);
  });
});
