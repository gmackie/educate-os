import { describe, expect, it } from "vitest";
import {
  PedagogicalIntentV0, EvidencePassportV0, assertProfileSource,
} from "../src/index.ts";

const source = {
  packageId: "university.example/biology-lab",
  version: "1.2.0",
  digest: "sha256:" + "a".repeat(64),
};

const intent = () => ({
  profile: "educateos.pedagogical-intent/0.1",
  id: "biology-investigation",
  revision: "1.0.0",
  source,
  origin: "educator-draft",
  learningGoals: [{
    id: "explain-carbon",
    statement: "Explain how carbon dioxide contributes to photosynthesis.",
    alignments: [],
  }],
  prerequisites: ["Understand that carbon atoms can form molecules."],
  misconceptions: ["Plant biomass comes primarily from soil."],
  strategies: [{ id: "model-carbon", approach: "Trace carbon atoms through a diagram.", conditions: [] }],
  expectedDemonstrations: [{
    id: "carbon-model", goalId: "explain-carbon",
    observable: "Label and describe where the carbon enters the system.", modality: "explain",
  }],
});

const claim = (dimension: string, finding: string, basis: string) => ({
  id: "claim-one", dimension, finding, basis,
  method: "Reviewed published package metadata.",
  methodVersion: "1.0.0",
  reportedAt: "2026-11-15T12:00:00Z",
  summary: "A documented, bounded finding.",
  issuer: { organization: "Example Research Collective" },
});

const passport = (claims: unknown[]) => ({
  profile: "educateos.evidence-passport/0.1",
  subject: source,
  createdAt: "2026-11-15T12:00:00Z",
  independentlyVerified: false,
  publicationApproved: false,
  claims,
});

describe("optional quality profiles (detached from OCS)", () => {
  it("allows pedagogical intention from K-12 through higher education", () => {
    const parsed = PedagogicalIntentV0.parse(intent());
    expect(parsed.origin).toBe("educator-draft");
    expect(parsed.learningGoals[0]?.alignments).toStrictEqual([]);
    assertProfileSource(parsed.source, source);
    expect(() => assertProfileSource(parsed.source, { ...source, digest: "sha256:" + "b".repeat(64) }))
      .toThrow(/does not match/);
  });

  it("rejects dangling learning goals, duplicate IDs, scripts, and unknown fields", () => {
    expect(PedagogicalIntentV0.safeParse({ ...intent(), extra: true }).success).toBe(false);
    expect(PedagogicalIntentV0.safeParse({ ...intent(), learningGoals: [] }).success).toBe(false);
    expect(PedagogicalIntentV0.safeParse({
      ...intent(), expectedDemonstrations: [{ ...intent().expectedDemonstrations[0], goalId: "unlisted" }],
    }).success).toBe(false);
    expect(PedagogicalIntentV0.safeParse({
      ...intent(), misconceptions: ['<iframe src="x"></iframe>'],
    }).success).toBe(false);
    const first = intent().strategies[0]!;
    expect(PedagogicalIntentV0.safeParse({
      ...intent(), strategies: [first, { ...first }],
    }).success).toBe(false);
  });

  it("holds immutable course claims but no independent verification or approval", () => {
    const parsed = EvidencePassportV0.parse(passport([claim("package-integrity", "pass", "deterministic-check")]));
    expect(parsed.independentlyVerified).toBe(false);
    expect(parsed.publicationApproved).toBe(false);
    assertProfileSource(parsed.subject, source);
    expect(() => assertProfileSource(parsed.subject, { ...source, version: "2.0.0" }))
      .toThrow(/does not match/);
    expect(EvidencePassportV0.safeParse({ ...passport([]), publicationApproved: true }).success).toBe(false);
    expect(EvidencePassportV0.safeParse({ ...passport([]), independentlyVerified: true }).success).toBe(false);
  });

  it("refuses AI or self-report certification and inappropriate learning impact claims", () => {
    expect(EvidencePassportV0.safeParse(passport([claim("learning-outcomes", "pass", "educator-review")])).success).toBe(false);
    expect(EvidencePassportV0.safeParse(passport([claim("learning-outcomes", "study-reported", "self-report")])).success).toBe(false);
    expect(EvidencePassportV0.safeParse(passport([claim("copyright-rights", "pass", "deterministic-check")])).success).toBe(false);
    expect(EvidencePassportV0.safeParse(passport([claim("subject-accuracy", "pass", "model-suggestion")])).success).toBe(false);
    expect(EvidencePassportV0.safeParse(passport([claim("accessibility", "pass", "self-report")])).success).toBe(false);
    expect(EvidencePassportV0.safeParse(passport([claim("learning-outcomes", "study-reported", "research-publication")])).success).toBe(true);
  });

  it("refuses duplicate claims, extra fields, and active markup", () => {
    const first = claim("package-integrity", "pass", "deterministic-check");
    expect(EvidencePassportV0.safeParse(passport([first, first])).success).toBe(false);
    expect(EvidencePassportV0.safeParse(passport([{ ...first, html: "<h1>ok</h1>" }])).success).toBe(false);
    expect(EvidencePassportV0.safeParse(passport([{ ...first, summary: "<script>bad</script>" }])).success).toBe(false);
  });
});
