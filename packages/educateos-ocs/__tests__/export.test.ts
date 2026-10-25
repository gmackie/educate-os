import { InMemoryAcademicStore } from "@educateos/academics";
import { ContentStudio, InMemoryContentStudioStorage } from "@educateos/content-studio";
import { type DistrictDirectorySnapshot, DistrictId, type PolicySettings, PrincipalId, type VerifiedPrincipal } from "@educateos/contracts";
import {
  contentStudioReleases,
  CurriculumService,
  InMemoryCodexPublisher,
  InMemoryCurriculumStorage,
  type OfferingScope,
  type TemplateInput,
} from "@educateos/curriculum";
import { NORTHFIELD } from "@educateos/fixtures";
import { directoryPolicyInformation, InMemoryPolicyAuditSink, PolicyEngine } from "@educateos/policy";
import { describe, expect, it } from "vitest";
import { addModule, hide, installCourse, planInstallations, preview, startCourse } from "../src/index.ts";
import { activity, IDS, libraryOf, packageFiles, unit } from "./helpers.ts";

const D = DistrictId.parse("dst_northfield");

/** The policy floor the tests decide under: the conservative district defaults. */
const FLOOR: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "private",
  teacherObservation: "assigned-work-only",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};

/** The district's one policy engine over `directory`. */
function policyEngine(directory: DistrictDirectorySnapshot) {
  const information = directoryPolicyInformation(InMemoryAcademicStore.seeded(directory), { effectivePolicy: async () => FLOOR });
  return { engine: new PolicyEngine({ information, audit: new InMemoryPolicyAuditSink() }) };
}
/** Teaches Biology, fall period 2. */
const MORGAN: VerifiedPrincipal = { principalId: PrincipalId.parse("prn_nf-morgan-lee"), districtId: D };
/** Teaches Mathematics 7, not Biology. */
const PATEL: VerifiedPrincipal = { principalId: PrincipalId.parse("prn_nf-teacher-patel"), districtId: D };
const BIO = { level: "offering", districtId: D, schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" } as OfferingScope;

const LAB_PAGE = "https://open-lessons.example/osmosis-lab";
const STRUCTURE = { frameworkKey: "ngss", competencyUri: "https://frameworks.example/ngss/HS-LS1-3" };

/** A Northfield curriculum service with a real Content Studio, and two published Biology activities. */
async function curriculum() {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 20, 9, tick++)).toISOString();
  const { engine } = policyEngine(NORTHFIELD);
  const studioStorage = new InMemoryContentStudioStorage();
  const studio = new ContentStudio({
    districtId: D,
    storage: studioStorage,
    authorizer: engine,
    fetch: async () => new Response("<!doctype html><html lang=\"en\"><head><title>Osmosis in Potato Cells</title></head><body><p>Synthetic.</p></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    scanner: undefined,
    alignments: { resolve: async () => undefined },
    now,
  });
  const service = new CurriculumService({
    districtId: D,
    directory: NORTHFIELD,
    authorizer: engine,
    releases: contentStudioReleases(studioStorage),
    alignments: {
      resolve: async (frameworkKey, competencyUri) =>
        frameworkKey === STRUCTURE.frameworkKey && competencyUri === STRUCTURE.competencyUri
          ? { competencyUri, frameworkUri: "https://frameworks.example/ngss", frameworkRevision: "2026.1" }
          : undefined,
    },
    aiHelpPolicy: { layersFor: async () => ({ district: "full" }) },
    publisher: new InMemoryCodexPublisher(),
    storage: new InMemoryCurriculumStorage(),
    now,
  });
  const item = await studio.submitUrl(MORGAN, { url: LAB_PAGE, targetScope: BIO });
  const released = await studio.approve(MORGAN, item.id, { alignments: [] });
  const lab = { resourceId: released.descriptor.id, version: released.descriptor.release.version };
  const investigation = (title: string): TemplateInput => ({
    template: "science-investigation",
    title,
    subject: "science",
    gradeBand: "9-10",
    overview: "Investigate how salt concentration affects potato cores.",
    resources: [lab],
    codex: [{ kind: "resource", resource: lab, visibility: "students" }],
    alignments: [STRUCTURE],
    aiHelp: "full",
    due: { kind: "after-install", days: 7 },
    question: "How does salt concentration affect the mass of potato cores?",
    methodPrompt: "Describe how you will prepare, soak and weigh the cores.",
    dataColumns: [{ name: "Concentration", unit: "M" }, { name: "Mass change", unit: "%" }],
    analysisPrompt: "Explain what your data shows about osmosis.",
  }) as TemplateInput;
  const definitions = [];
  for (const title of ["Osmosis in potato cores", "Diffusion through membranes"]) {
    const draft = await service.createDraft(MORGAN, { scope: BIO, activity: investigation(title) });
    definitions.push(await service.publish(MORGAN, draft.id));
  }
  return { service, definitions };
}

describe("export to curriculum installations", () => {
  it("installs a composed course's activities into an offering, in course order, pinned to their versions", async () => {
    const { service, definitions } = await curriculum();
    const [osmosis, diffusion] = definitions.map((d) => ({ definitionId: d.id, version: d.version }));
    // Two course packages, both using the osmosis activity; the course hides one unit.
    const bio = packageFiles({
      manifest: { id: IDS.bio, version: "1.0.0", outline: [{ kind: "unit", unit: "cells" }, { kind: "unit", unit: "extension" }] },
      units: [unit("cells", [{ kind: "activity", ref: "diffusion" }]), unit("extension", [{ kind: "activity", ref: "extension-lab" }])],
      activities: [activity("diffusion", diffusion!.definitionId, diffusion!.version, "lesson"), activity("extension-lab", "adf_never-installed")],
    });
    const lab = packageFiles({
      manifest: { id: IDS.safety, version: "1.0.0", outline: [{ kind: "unit", unit: "practical" }] },
      units: [unit("practical", [{ kind: "activity", ref: "osmosis" }])],
      activities: [activity("osmosis", osmosis!.definitionId, osmosis!.version)],
    });
    let draft = startCourse({ id: IDS.course, title: "Biology 9", language: "en" });
    draft = addModule(draft, { packageId: IDS.safety, version: "1.0.0" });
    draft = addModule(draft, { packageId: IDS.bio, version: "1.0.0" });
    draft = hide(draft, { modules: ["cells-core"], unit: "extension" });
    const { course } = await preview(draft, await libraryOf(bio, lab));

    expect(planInstallations(course, BIO).map((p) => [p.itemKey, p.input.definitionId])).toStrictEqual([
      ["lab-safety:practical#osmosis", osmosis!.definitionId],
      ["cells-core:cells#diffusion", diffusion!.definitionId],
    ]);
    const installed = await installCourse(service, MORGAN, course, BIO);
    expect(installed.map(({ itemKey, installation }) => [itemKey, installation.definitionId, installation.definitionVersion, installation.scope.offeringId])).toStrictEqual([
      ["lab-safety:practical#osmosis", osmosis!.definitionId, 1, BIO.offeringId],
      ["cells-core:cells#diffusion", diffusion!.definitionId, 1, BIO.offeringId],
    ]);
  });

  it("installs an activity two modules share once", async () => {
    const { definitions } = await curriculum();
    const shared = activity("osmosis", definitions[0]!.id, definitions[0]!.version);
    const one = packageFiles({ manifest: { id: IDS.bio, version: "1.0.0", outline: [{ kind: "unit", unit: "a" }] }, units: [unit("a", [{ kind: "activity", ref: "osmosis" }])], activities: [shared] });
    const two = packageFiles({ manifest: { id: IDS.safety, version: "1.0.0", outline: [{ kind: "unit", unit: "b" }] }, units: [unit("b", [{ kind: "activity", ref: "osmosis" }])], activities: [shared] });
    const draft = addModule(addModule(startCourse({ id: IDS.course, title: "Biology 9", language: "en" }), { packageId: IDS.bio, version: "1.0.0" }), { packageId: IDS.safety, version: "1.0.0" });
    const { course } = await preview(draft, await libraryOf(one, two));
    expect(planInstallations(course, BIO).map((p) => p.itemKey)).toStrictEqual(["cells-core:a#osmosis"]);
  });

  it("leaves authorization to the curriculum service: a teacher of another class cannot install", async () => {
    const { service, definitions } = await curriculum();
    const pkg = packageFiles({
      manifest: { id: IDS.bio, version: "1.0.0", outline: [{ kind: "unit", unit: "a" }] },
      units: [unit("a", [{ kind: "activity", ref: "osmosis" }])],
      activities: [activity("osmosis", definitions[0]!.id, definitions[0]!.version)],
    });
    const { course } = await preview(addModule(startCourse({ id: IDS.course, title: "Biology 9", language: "en" }), { packageId: IDS.bio, version: "1.0.0" }), await libraryOf(pkg));
    await expect(installCourse(service, PATEL, course, BIO)).rejects.toMatchObject({ name: "EducateOsError", code: expect.stringMatching(/^(not-found|forbidden)$/) });
  });
});
