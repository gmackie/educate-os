import { DistrictId, OfferingId, SchoolId } from "@educateos/contracts";
import { DOCS_HOST, doc, O, P, setup, sub } from "./setup.ts";

const encoder = new TextEncoder();
const amara = P.amara.principal.principalId;
const elena = P.elena.principal.principalId;
const morgan = P.morgan.principal.principalId;
const district = { level: "district", districtId: DistrictId.parse("dst_northfield") } as const;

/**
 * Amara's year so far, with everything around it an export must leave out:
 * - a personal essay with two revisions, the second AI-assisted;
 * - a personal link to a Docs file, whose URL carries a share key;
 * - a Biology lab report and its submission, in a term that has since completed;
 * - feedback on the lab, one note shared with her and one teacher-only note about her;
 * - Elena's lab, submission and feedback in the same class;
 * - four cited resources: a link-only page, a licensed textbook that may not be redistributed,
 *   a CC-BY excerpt that may, and a teacher-only answer key.
 *
 * Every string an export must not carry is marked in capitals, so tests can search for it.
 */
export async function amarasYear(env: ReturnType<typeof setup>) {
  const { artifacts, workspaces, records, completeFallTerm } = env;
  const personal = await workspaces.ensurePersonalWorkspace(P.amara);
  const essay = await artifacts.createArtifact(P.amara, doc(personal.id, "Cells are small.", "Cell membranes essay"));
  const essayV2 = await artifacts.saveRevision(P.amara, essay.artifact.id, {
    content: { kind: "text", mediaType: "text/markdown", text: "Cells are small.\n\nMembranes control what enters." },
    aiAssistance: { level: "assisted", modelId: "workers-ai/example-model" },
  });
  const link = await artifacts.createArtifact(P.amara, {
    workspaceId: personal.id,
    type: "external-ref",
    title: "Shared research notes",
    content: { kind: "external", url: `https://${DOCS_HOST}/d/notes-1?resourcekey=SHAREKEY0001&usp=sharing#part-2` },
    aiAssistance: { level: "none" },
  });

  const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  const lab = await artifacts.createArtifact(P.amara, doc(bio.id, "Osmosis lab: the potato lost 12% of its mass.", "Osmosis lab report"));
  const elenaBio = await workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
  const peerLab = await artifacts.createArtifact(P.elena, doc(elenaBio.id, "PEER-WORK: Elena's lab.", "PEER-TITLE Elena's lab"));

  records.submissionRecords.push(
    {
      id: sub("sub_amara-osmosis"),
      ownerPrincipalId: amara,
      offeringId: O.bioFall,
      activityTitle: "Osmosis lab",
      submittedAt: "2026-10-01T15:00:00.000Z",
      revisions: [{ artifactId: lab.artifact.id, revisionId: lab.head.id, digest: lab.head.content.digest }],
    },
    {
      id: sub("sub_elena-osmosis"),
      ownerPrincipalId: elena,
      offeringId: O.bioFall,
      activityTitle: "PEER-ACTIVITY Osmosis lab",
      submittedAt: "2026-10-01T15:05:00.000Z",
      revisions: [{ artifactId: peerLab.artifact.id, revisionId: peerLab.head.id, digest: peerLab.head.content.digest }],
    },
  );
  records.feedbackRecords.push(
    {
      id: "fbk_amara-shared",
      subjectPrincipalId: amara,
      offeringId: O.bioFall,
      submissionId: sub("sub_amara-osmosis"),
      authorPrincipalId: morgan,
      visibility: "shared-with-learner",
      createdAt: "2026-10-03T09:00:00.000Z",
      body: "Clear method. Next time, add a control group.",
    },
    {
      id: "fbk_amara-note",
      subjectPrincipalId: amara,
      offeringId: O.bioFall,
      submissionId: sub("sub_amara-osmosis"),
      authorPrincipalId: morgan,
      visibility: "teacher-only",
      createdAt: "2026-10-03T09:01:00.000Z",
      body: "TEACHER-ONLY-NOTE: check the numbers against Elena's.",
    },
    {
      id: "fbk_elena-shared",
      subjectPrincipalId: elena,
      offeringId: O.bioFall,
      submissionId: sub("sub_elena-osmosis"),
      authorPrincipalId: morgan,
      visibility: "shared-with-learner",
      createdAt: "2026-10-03T09:02:00.000Z",
      body: "PEER-FEEDBACK for Elena.",
    },
  );
  records.resourceRecords.push(
    { id: "res-cells-page", title: "How cells work", scope: district, classification: "district-internal", rights: { mode: "link" }, url: "https://publisher.example/cells?utm_source=educateos" },
    {
      id: "res-textbook",
      title: "Biology textbook, chapter 3",
      scope: district,
      classification: "district-internal",
      rights: { mode: "licensed-copy", redistribution: "forbidden", license: "Publisher site licence" },
      url: "https://publisher.example/textbook/ch3",
      contentMediaType: "text/plain",
    },
    {
      id: "res-diffusion-excerpt",
      title: "Diffusion, an excerpt",
      scope: district,
      classification: "district-internal",
      rights: { mode: "permitted-excerpt", redistribution: "permitted", license: "CC-BY-4.0" },
      contentMediaType: "text/markdown",
    },
    {
      id: "res-answer-key",
      title: "STAFF-ONLY Osmosis answer key",
      scope: { level: "offering", districtId: DistrictId.parse("dst_northfield"), schoolId: SchoolId.parse("sch_nf-high"), offeringId: OfferingId.parse("off_nf-bio-fall-p2") },
      classification: "teacher-only",
      rights: { mode: "link" },
      url: "https://publisher.example/answer-key",
    },
  );
  records.contents.set("res-textbook", encoder.encode("LICENSED-TEXTBOOK-CONTENT"));
  records.contents.set("res-diffusion-excerpt", encoder.encode("Diffusion moves particles from high to low concentration."));

  await completeFallTerm();
  return { personal, essay, essayV2, link, bio, lab, peerLab };
}

/** Strings from `amarasYear` that must never appear in Amara's archive. */
export const FORBIDDEN_STRINGS = [
  "PEER-",
  "TEACHER-ONLY-NOTE",
  "STAFF-ONLY",
  "LICENSED-TEXTBOOK-CONTENT",
  "SHAREKEY0001",
  "utm_source",
  "resourcekey",
];
