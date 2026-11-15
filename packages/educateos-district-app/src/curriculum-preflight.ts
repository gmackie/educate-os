// Course-level read-only preflight for already imported, digest-verified OCS packages.
// This is a deterministic *coverage and readiness report*, NOT editorial review,
// publication approval, evidence of learning outcomes, or a substitute for Content Studio.
// Content Studio handles individual resource scanning and rights review at import.
// OCS controls package composition; Assessment CI handles student submissions.
import type { CourseInstallPlan } from "@educateos/ocs";

export type CurriculumCheckStatus = "pass" | "attention" | "not-verified";
export type CurriculumCheckId =
  | "package-integrity" | "publisher-trust" | "standards" | "activity-portability"
  | "resource-portability" | "reading-attribution" | "instructor-material"
  | "copyright-rights" | "accessibility" | "educational-effectiveness";

export interface CurriculumCheck {
  id: CurriculumCheckId;
  status: CurriculumCheckStatus;
  /** Short factual explanation suitable for an educator; no raw content or student data. */
  explanation: string;
  /** True when the underlying check is deterministic, not a human/AI evaluation. */
  deterministic: boolean;
}

export interface CurriculumPreflight {
  packageId: string;
  version: string;
  digest: string;
  title: string;
  /** No machine check can grant publication rights or authorize an installation. */
  publicationApproved: false;
  /** This preview does not modify resources, courses, student work, or grades. */
  readOnly: true;
  summary: { passed: number; attention: number; notVerified: number };
  checks: CurriculumCheck[];
}

export interface CurriculumPreflightInput {
  digest: string;
  /** Recorded by the district's approved course-library importer, not reverified here. */
  signedAtImport: boolean;
  /** District-owned CASE catalog acceptance, not a cross-framework equivalence claim. */
  isApproved(frameworkKey: string, competencyUri: string): Promise<boolean>;
}

const check = (
  id: CurriculumCheckId,
  status: CurriculumCheckStatus,
  explanation: string,
  deterministic = true,
): CurriculumCheck => ({ id, status, explanation, deterministic });

/**
 * No I/O other than the recipient district's approved-standard lookup.
 * Called only AFTER planLibraryInstall verified the package's structure, digests,
 * dependency resolution and portable-activity exports against the local library.
 *
 * Deliberately does not:
 *   - fetch pages or PDF/PPTX resources, run a model, or contact a Foundation service;
 *   - inspect rights to use/copy third-party material (rights ceilings are not grants);
 *   - pass judgment on scientific truth, instructional effectiveness or accessibility;
 *   - authorize installing or publishing anything.
 *
 * It returns coarse counts and explanatory flags, never answer-key bodies or
 * identifiers of students. An institution must run actual Content Studio reviews
 * and any required human approval separately.
 */
export async function inspectCurriculumPreflight(
  plan: CourseInstallPlan,
  input: CurriculumPreflightInput,
): Promise<CurriculumPreflight> {
  const declared = new Map<string, { frameworkKey: string; competencyUri: string }>();
  const add = (alignments: readonly { frameworkKey: string; competencyUri: string }[]) => {
    for (const alignment of alignments) declared.set(
      JSON.stringify([alignment.frameworkKey, alignment.competencyUri]), alignment,
    );
  };
  add(plan.course.standards);
  for (const unit of plan.units) add(unit.standards);
  for (const imported of plan.imports) add(imported.export.alignments);
  const approved = await Promise.all([...declared.values()].map(
    (alignment) => input.isApproved(alignment.frameworkKey, alignment.competencyUri),
  ));
  const unapprovedCount = approved.filter((ok) => !ok).length;
  const localDefinitions = plan.units.flatMap((u) => u.items).filter(
    (item) => item.kind === "activity" && item.definition.kind === "district",
  ).length;
  const resources = plan.units.flatMap((u) => u.items).filter(
    (item) => item.kind === "resource",
  ).length;
  const teacherNotes = plan.units.flatMap((u) => u.items).filter(
    (item) => item.kind === "teacher-note",
  ).length;
  const answerKeys = plan.units.flatMap((u) => u.items).filter(
    (item) => item.kind === "teacher-note" && item.purpose === "answer-key",
  ).length;
  const readings = plan.imports.flatMap((item) => item.export.readings);
  const missingAttribution = readings.filter((reading) => !reading.attribution?.trim()).length;

  const checks: CurriculumCheck[] = [
    check("package-integrity", "pass",
      "OCS package structure, locked dependencies and portable activity digests were checked against the district's stored course library."),
    check("publisher-trust", "not-verified",
      input.signedAtImport
        ? "The district recorded a signed publisher at import. Current key trust, author's identity and copyright ownership are not established by this preflight."
        : "This library version was imported without an external publisher signature under the district's local-publisher policy. Publishing authority is not independently established.",
      false),
    check("standards",
      declared.size === 0 ? "not-verified" : unapprovedCount > 0 ? "attention" : "pass",
      declared.size === 0
        ? "The course contains no declared CASE alignments. Curriculum coverage is not established."
        : unapprovedCount > 0
          ? String(unapprovedCount) + " of " + String(declared.size) + " referenced competencies are not approved in this district's catalog."
          : "All " + String(declared.size) + " declared competency references were found in the district's approved catalog. This does not establish instructional alignment or cross-state equivalence."),
    check("activity-portability", localDefinitions > 0 ? "attention" : "pass",
      localDefinitions > 0
        ? String(localDefinitions) + " activities reference definitions from another district and cannot automatically transfer."
        : "Every planned activity uses a portable reference, or the course has no activities. Importing a definition still requires local review."),
    check("resource-portability", resources > 0 ? "attention" : "not-verified",
      resources > 0
        ? String(resources) + " resources use district-local releases. Other districts may need separate rights-cleared files."
        : "No district-local resource reference was found, but accessibility and rights of linked material have not been checked.",
      resources > 0),
    check("reading-attribution",
      missingAttribution > 0 ? "attention" : "not-verified",
      missingAttribution > 0
        ? String(missingAttribution) + " of " + String(readings.length) + " portable activity readings lack an attribution field. Review authorship and source rights."
        : readings.length > 0
          ? "Portable activity readings have attribution fields; these claims and the underlying licenses still require review."
          : "No portable activity readings were present to inspect for attribution.",
      missingAttribution > 0),
    check("instructor-material", teacherNotes > 0 ? "attention" : "not-verified",
      teacherNotes > 0
        ? "The package contains " + String(teacherNotes) + " teacher-only notes, including " + String(answerKeys) + " marked answer keys. A downloadable OCS bundle is not an access-control boundary; restrict sensitive distributions."
        : "No teacher-only Codex notes were declared. This does not prove the absence of sensitive material elsewhere.",
      teacherNotes > 0),
    check("copyright-rights", "not-verified",
      "No redistribution license or employer/third-party ownership check has been performed. An OCS rights ceiling is not a license grant.", false),
    check("accessibility", "not-verified",
      "Automated media checks and human accessibility review have not been performed for the complete lesson. Use Content Studio for individual assets.", false),
    check("educational-effectiveness", "not-verified",
      "No educator review, validated learning study or student outcome evidence was assessed. Machine-readable packaging cannot prove instructional impact.", false),
  ];

  return {
    packageId: plan.course.packageId,
    version: plan.course.version,
    digest: input.digest,
    title: plan.course.title,
    publicationApproved: false,
    readOnly: true,
    summary: {
      passed: checks.filter((c) => c.status === "pass").length,
      attention: checks.filter((c) => c.status === "attention").length,
      notVerified: checks.filter((c) => c.status === "not-verified").length,
    },
    checks,
  };
}
