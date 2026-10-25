import { SHIPPED_REGISTRY, createDraftRevision } from "@educateos/config";
import { PrincipalId } from "@educateos/contracts";
import { EvidenceContract } from "@educateos/registry";
import { describe, expect, it } from "vitest";
import {
  ActivityContent,
  ActivityDefinition,
  ActivityInstallation,
  checkActivityContent,
  codexCollectionKey,
  compiledConfigAiHelpSource,
  generateActivity,
  resolveAiHelp,
  ResourceReleaseRef,
} from "../src/index.ts";
import {
  AMARA,
  BIO,
  biologyLab,
  CHEN,
  CHIDI,
  D,
  DMITRI,
  ELENA,
  ENG9,
  englishEssay,
  HISTORY,
  historySources,
  MATH7,
  mathProblems,
  MORGAN,
  PAGES,
  PATEL,
  rejectsWith,
  RIVERA,
  setup,
} from "./helpers.ts";

describe("C05 acceptance: English, Biology and History activities share one runtime model", () => {
  it("validates, publishes, installs and serves all four templates through the same code", async () => {
    const { service, publisher, release } = await setup();
    const essay = await release(RIVERA, PAGES.essay, ENG9);
    const lab = await release(MORGAN, PAGES.cells, BIO);
    const letter = await release(CHEN, PAGES.letter, HISTORY);
    const speech = await release(CHEN, PAGES.speech, HISTORY);
    const classes = [
      { subject: "English", teacher: RIVERA, student: AMARA, scope: ENG9, input: englishEssay(essay) },
      { subject: "Biology", teacher: MORGAN, student: AMARA, scope: BIO, input: biologyLab(lab) },
      { subject: "History", teacher: CHEN, student: ELENA, scope: HISTORY, input: historySources([letter, speech]) },
      { subject: "Mathematics", teacher: PATEL, student: CHIDI, scope: MATH7, input: mathProblems() },
    ];

    const shapes = new Set<string>();
    for (const { teacher, student, scope, input } of classes) {
      const draft = await service.createDraft(teacher, { scope, activity: input });
      expect(ActivityDefinition.parse(draft)).toStrictEqual(draft);
      expect(checkActivityContent(draft.content)).toStrictEqual([]);
      expect(EvidenceContract.parse(draft.evidenceContract).competencies).toHaveLength(1);
      shapes.add(Object.keys(draft.content).filter((key) => key !== "citations").toSorted().join(","));

      const published = await service.publish(teacher, draft.id);
      const installation = await service.install(teacher, { definitionId: published.id, offering: scope });
      expect(ActivityInstallation.parse(installation)).toStrictEqual(installation);
      expect(installation).toMatchObject({ definitionVersion: 1, scope: { ...scope, level: "activity" }, codex: { collectionKey: codexCollectionKey(D, scope.offeringId) } });

      const view = await service.getActivity(student, installation.id);
      expect(view.view).toBe("student");
      expect(ActivityContent.parse(view.content)).toStrictEqual(view.content);
      expect(publisher.documents(installation.codex.collectionKey).map((codex) => codex.activityId)).toContain(installation.id);
    }
    // One model: every template's content has the same fields; only `citations` is optional.
    expect(shapes.size).toBe(1);
  });

  it("keeps each template's subject-specific work in steps and evidence, not in new fields", () => {
    const ref = ResourceReleaseRef.parse({ resourceId: "rsc_x", version: "1.0.0" });
    const lab = generateActivity(biologyLab(ref));
    expect(lab.steps.map((s) => [s.id, s.response.kind])).toStrictEqual([["hypothesis", "writing"], ["method", "writing"], ["data", "dataset"], ["analysis", "writing"]]);
    expect(lab.permittedArtifactTypes).toStrictEqual(["document", "dataset"]);

    const essay = generateActivity(englishEssay(ref));
    expect(essay.rubricSlots.map((slot) => slot.id)).toStrictEqual(["structure"]);
    expect(essay.citations).toStrictEqual({ minimum: 2, from: "activity-resources" });
    expect(essay.evidence.criteria.map((c) => c.id)).toContain("cites-sources");

    const history = generateActivity(historySources([ref]));
    expect(history.steps.map((s) => s.id)).toStrictEqual(["sourcing", "contextualization", "claim"]);
    expect(history.steps.every((s) => s.sources.length === 1)).toBe(true);
    expect(history.resources).toStrictEqual([ref]);
  });

  it("refuses content that breaks the shared structural rules, whatever the template", () => {
    const ref = ResourceReleaseRef.parse({ resourceId: "rsc_x", version: "1.0.0" });
    const lab = generateActivity(biologyLab(ref));
    expect(checkActivityContent({ ...lab, permittedArtifactTypes: ["document"] })[0]?.message).toMatch(/asks for a dataset/);
    const history = generateActivity(historySources([ref]));
    expect(checkActivityContent({ ...history, resources: [] }).map((issue) => issue.path)).toContain("steps.0.sources");
  });
});

describe("resources must be released Content Studio releases", () => {
  it("refuses an item that is still awaiting review, and a version that was never released", async () => {
    const { service, pending, release } = await setup();
    const unreviewed = await pending(MORGAN, PAGES.pending, BIO);
    await rejectsWith(service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(unreviewed) }), "validation-failed", /not a released resource/);
    const lab = await release(MORGAN, PAGES.cells, BIO);
    await rejectsWith(service.createDraft(MORGAN, { scope: BIO, activity: biologyLab({ ...lab, version: "2.0.0" }) }), "validation-failed", /not a released resource/);
  });

  it("refuses a release approved only for another class", async () => {
    const { service, release } = await setup();
    const lab = await release(MORGAN, PAGES.cells, BIO);
    await rejectsWith(service.createDraft(RIVERA, { scope: ENG9, activity: englishEssay(lab) }), "validation-failed", /not approved for this class/);
  });

  it("refuses an alignment the district catalog cannot resolve", async () => {
    const { service, release } = await setup();
    const lab = await release(MORGAN, PAGES.cells, BIO);
    const input = biologyLab(lab, { alignments: [{ frameworkKey: "ngss", competencyUri: "https://frameworks.example/ngss/made-up" }] });
    await rejectsWith(service.createDraft(MORGAN, { scope: BIO, activity: input }), "validation-failed", /approved ngss release/);
  });
});

describe("the AI-help policy can only narrow", () => {
  it("reads the district's compiled configuration, so a configured offering override refuses more help", async () => {
    const compiled = await createDraftRevision({
      document: {
        apiVersion: "educateos.io/v1alpha1",
        district: D,
        profile: "us-k12-standard",
        identity: { provider: "district-sso" },
        rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
        modules: { "core-learning": "enabled" },
        rollout: { target: "all-active-offerings", requiresAdminActivation: false },
        overrides: [
          { scope: { level: "school", districtId: D, schoolId: BIO.schoolId }, policies: { ai: { help: "hints-only" } } },
          { scope: BIO, policies: { ai: { help: "none" } } },
        ],
      },
      registry: SHIPPED_REGISTRY,
      actorPrincipalId: PrincipalId.parse("prn_nf-district-admin"),
    });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.problems));
    const { service, release } = await setup({ aiHelpPolicy: compiledConfigAiHelpSource(async () => compiled.compiled.desired) });
    const lab = await release(MORGAN, PAGES.cells, BIO);

    await rejectsWith(service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(lab, { aiHelp: "hints-only" }) }), "policy-violation");
    // English 9 inherits only the school's hints-only.
    const essayModel = await release(RIVERA, PAGES.essay, ENG9);
    await rejectsWith(service.createDraft(RIVERA, { scope: ENG9, activity: englishEssay(essayModel, { aiHelp: "full" }) }), "policy-violation");
    expect((await service.createDraft(RIVERA, { scope: ENG9, activity: englishEssay(essayModel, { aiHelp: "hints-only" }) })).id).toBeDefined();
  });

  it("resolves district, school, offering and activity, reporting every loosening", () => {
    expect(resolveAiHelp({ district: "full", offering: "hints-only" }, "none")).toStrictEqual({ ok: true, effective: "none" });
    expect(resolveAiHelp({ district: "hints-only", school: "full" }, "full")).toStrictEqual({
      ok: false,
      violations: [{ level: "school", floor: "hints-only", requested: "full" }, { level: "activity", floor: "hints-only", requested: "full" }],
    });
  });

  it("refuses an activity that asks for more help than the district or offering allows", async () => {
    const { service, policy, release } = await setup();
    const lab = await release(MORGAN, PAGES.cells, BIO);
    policy.district = "hints-only";
    await rejectsWith(service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(lab, { aiHelp: "full" }) }), "policy-violation");
    policy.district = "full";
    policy.offerings[BIO.offeringId] = { offering: "none" };
    await rejectsWith(service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(lab, { aiHelp: "hints-only" }) }), "policy-violation");
    const none = await service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(lab, { aiHelp: "none" }) });
    expect(none.evidenceContract.restrictions.aiAssistance).toBe("not-allowed");
  });

  it("checks again at installation, and the helper follows a later tightening at once", async () => {
    const { service, policy, release } = await setup();
    const lab = await release(MORGAN, PAGES.cells, BIO);
    const definition = await service.publish(MORGAN, (await service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(lab, { aiHelp: "full" }) })).id);

    policy.offerings[BIO.offeringId] = { offering: "hints-only" };
    await rejectsWith(service.install(MORGAN, { definitionId: definition.id, offering: BIO }), "policy-violation");

    policy.offerings[BIO.offeringId] = {};
    const installation = await service.install(MORGAN, { definitionId: definition.id, offering: BIO });
    expect((await service.helperContext(AMARA, installation.id)).instructions).toMatch(/explain ideas/);

    policy.district = "hints-only";
    expect((await service.helperContext(AMARA, installation.id)).instructions).toMatch(/hints and guiding questions only/);
    policy.district = "none";
    await rejectsWith(service.helperContext(AMARA, installation.id), "policy-violation");
  });
});

describe("installation pins a version", () => {
  it("leaves an installed version unchanged when the definition is edited and republished", async () => {
    const { service, storage, release } = await setup();
    const lab = await release(MORGAN, PAGES.cells, BIO);
    const v1 = await service.publish(MORGAN, (await service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(lab) })).id);
    const first = await service.install(MORGAN, { definitionId: v1.id, offering: BIO });

    const v2 = await service.revise(MORGAN, v1.id, { activity: biologyLab(lab, { title: "Osmosis, revised" }) });
    expect(v2).toMatchObject({ version: 2, status: "draft" });
    // Revising a draft replaces it rather than adding a version.
    expect(await service.revise(MORGAN, v1.id, { activity: biologyLab(lab, { title: "Osmosis, revised again" }) })).toMatchObject({ version: 2 });
    await rejectsWith(service.install(MORGAN, { definitionId: v1.id, version: 2, offering: BIO }), "conflict");
    await service.publish(MORGAN, v1.id);
    await rejectsWith(service.publish(MORGAN, v1.id), "conflict");

    const second = await service.install(MORGAN, { definitionId: v1.id, offering: BIO });
    expect(second.definitionVersion).toBe(2);
    expect((await service.getActivity(AMARA, first.id)).content.title).toBe("Osmosis in potato cores");
    expect((await service.getActivity(AMARA, second.id)).content.title).toBe("Osmosis, revised again");
    expect((await service.getDefinition(MORGAN, v1.id, 1))).toStrictEqual(v1);
    // Storage itself refuses to overwrite a published version.
    await rejectsWith(storage.putVersion({ ...v1, content: { ...v1.content, title: "Rewritten" } }), "conflict");
  });

  it("resolves the due date into the term, and refuses one outside it", async () => {
    const { service, release } = await setup();
    const [letter, speech] = [await release(CHEN, PAGES.letter, HISTORY), await release(CHEN, PAGES.speech, HISTORY)];
    const relative = await service.publish(CHEN, (await service.createDraft(CHEN, { scope: HISTORY, activity: historySources([letter, speech], { due: { kind: "after-install", days: 10 } }) })).id);
    const installed = await service.install(CHEN, { definitionId: relative.id, offering: HISTORY });
    expect(Date.parse(installed.dueAt!) - Date.parse(installed.installedAt)).toBe(10 * 24 * 60 * 60 * 1000);

    const late = await service.publish(CHEN, (await service.createDraft(CHEN, { scope: HISTORY, activity: historySources([letter, speech], { due: { kind: "fixed", dueAt: "2027-03-01T12:00:00Z" } }) })).id);
    await rejectsWith(service.install(CHEN, { definitionId: late.id, offering: HISTORY }), "validation-failed", /end of the term/);
  });
});

describe("authorization", () => {
  it("lets a teacher author and install only in offerings they teach", async () => {
    const { service, release } = await setup();
    const lab = await release(MORGAN, PAGES.cells, BIO);
    await rejectsWith(service.createDraft(RIVERA, { scope: BIO, activity: biologyLab(lab) }), "forbidden");
    const definition = await service.publish(MORGAN, (await service.createDraft(MORGAN, { scope: BIO, activity: biologyLab(lab) })).id);
    // Another teacher cannot see the definition at all, let alone install it.
    await rejectsWith(service.getDefinition(RIVERA, definition.id), "not-found");
    await rejectsWith(service.install(RIVERA, { definitionId: definition.id, offering: ENG9 }), "not-found");
    // Morgan teaches Biology but holds no role in English 9.
    await rejectsWith(service.install(MORGAN, { definitionId: definition.id, offering: ENG9 }), "forbidden");
  });

  it("lets a co-teacher read but not install", async () => {
    const { service, release } = await setup();
    const model = await release(RIVERA, PAGES.essay, ENG9);
    const definition = await service.publish(RIVERA, (await service.createDraft(RIVERA, { scope: ENG9, activity: englishEssay(model) })).id);
    expect((await service.getDefinition(CHEN, definition.id)).id).toBe(definition.id);
    await rejectsWith(service.install(CHEN, { definitionId: definition.id, offering: ENG9 }), "forbidden");
    await rejectsWith(service.publish(CHEN, definition.id), "forbidden");
  });

  it("lets only actively enrolled students read an installed activity, and never its definition", async () => {
    const { service, release } = await setup();
    const model = await release(RIVERA, PAGES.essay, ENG9);
    const definition = await service.publish(RIVERA, (await service.createDraft(RIVERA, { scope: ENG9, activity: englishEssay(model) })).id);
    const installation = await service.install(RIVERA, { definitionId: definition.id, offering: ENG9 });

    expect((await service.getActivity(AMARA, installation.id)).view).toBe("student");
    expect((await service.getActivity(RIVERA, installation.id)).view).toBe("teacher");
    // Chidi is not in English 9; Dmitri's English 9 enrollment is inactive.
    await rejectsWith(service.getActivity(CHIDI, installation.id), "not-found");
    await rejectsWith(service.getActivity(DMITRI, installation.id), "not-found");
    await rejectsWith(service.getStudentCodex(DMITRI, installation.id), "not-found");
    await rejectsWith(service.helperContext(CHIDI, installation.id), "not-found");
    // Students never read definitions or the class Codex, even in their own class.
    await rejectsWith(service.getDefinition(AMARA, definition.id), "not-found");
    await rejectsWith(service.getClassCodex(AMARA, installation.id), "not-found");
    await rejectsWith(service.getActivity(AMARA, "act_does-not-exist"), "not-found");
  });
});
