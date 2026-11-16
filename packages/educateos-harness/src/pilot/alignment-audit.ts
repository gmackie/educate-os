// An independent check of what the planner offers, written against the approved registry release
// and not against the planner's own mapping. It exists so that a future change to the planner's
// keyword mapping, or a model's suggested alignment, cannot quietly invent a standard.
import type { CatalogMirror } from "@educateos/catalog";
import type { PilotPlan } from "./district.ts";

type Opportunity = PilotPlan["opportunities"][number];

/** The only alignments the pilot may offer, with the registry record each one must pin. */
export const ALLOWED_ALIGNMENTS = {
  // 6.RP.A.3b is a lettered component of the registry's 6.RP.A.3 record; there is no separate node.
  "6.RP.A.3b": { frameworkKey: "ccss-math", nodeCode: "6.RP.A.3", level: "06", subject: "Mathematics", statement: "(b) Solve unit rate problems including those involving unit pricing and constant speed" },
  "W.6.1": { frameworkKey: "ccss-ela", nodeCode: "W.6.1", level: "06", subject: "English Language Arts & Literacy", statement: "Write arguments to support claims with clear reasons and relevant evidence" },
  "7.RP.A.1": { frameworkKey: "ccss-math", nodeCode: "7.RP.A.1", level: "07", subject: "Mathematics", statement: "Compute unit rates associated with ratios of fractions" },
  "W.7.1": { frameworkKey: "ccss-ela", nodeCode: "W.7.1", level: "07", subject: "English Language Arts & Literacy", statement: "acknowledge alternate or opposing claims" },
} as const;

/** One reason an opportunity must not be shown to a learner. */
export interface AlignmentProblem {
  rule: "unknown-code" | "not-approved" | "wrong-release" | "not-in-registry" | "altered-node" | "wrong-subject" | "wrong-code" | "wrong-grade" | "foreign-identifier" | "component-not-verified" | "contract-mismatch";
  detail: string;
}

/**
 * Every problem with one offered opportunity. An empty list means the opportunity pins a record
 * that the district's approved release really holds, unchanged, for this code and grade.
 */
export async function auditOpportunity(catalog: CatalogMirror, opportunity: Opportunity, classLevels: ReadonlySet<string>): Promise<AlignmentProblem[]> {
  const rule = (ALLOWED_ALIGNMENTS as Record<string, (typeof ALLOWED_ALIGNMENTS)[keyof typeof ALLOWED_ALIGNMENTS]>)[opportunity.code];
  if (rule === undefined) return [{ rule: "unknown-code", detail: `${opportunity.code} is not a pilot standard` }];
  const problems: AlignmentProblem[] = [];
  const release = await catalog.approvedRelease(opportunity.frameworkKey);
  if (release === undefined) return [{ rule: "not-approved", detail: `${opportunity.frameworkKey} has no approved release` }];
  if (opportunity.frameworkKey !== rule.frameworkKey) problems.push({ rule: "wrong-subject", detail: `${opportunity.code} belongs to ${rule.frameworkKey}, not ${opportunity.frameworkKey}` });
  if (release.version !== opportunity.releaseVersion || release.contentDigest !== opportunity.releaseDigest) problems.push({ rule: "wrong-release", detail: "the pinned release is not the approved release" });
  const held = release.content.nodes?.find((n) => n.uri === opportunity.node.uri);
  if (held === undefined) {
    problems.push({ rule: "not-in-registry", detail: opportunity.node.uri });
    return problems;
  }
  if (JSON.stringify(held) !== JSON.stringify(opportunity.node)) problems.push({ rule: "altered-node", detail: "the node differs from the registry's record" });
  if (!held.uri.startsWith("urn:educateos:catalog:")) problems.push({ rule: "foreign-identifier", detail: held.uri });
  if (held.humanCodingScheme !== rule.nodeCode) problems.push({ rule: "wrong-code", detail: `${opportunity.code} must pin ${rule.nodeCode}, not ${held.humanCodingScheme ?? "an uncoded node"}` });
  if (!held.subjects?.includes(rule.subject)) problems.push({ rule: "wrong-subject", detail: `node subjects ${JSON.stringify(held.subjects)}` });
  if (!held.educationLevels?.includes(rule.level) || !classLevels.has(rule.level)) problems.push({ rule: "wrong-grade", detail: `${opportunity.code} is a grade ${rule.level} standard` });
  if (!held.fullStatement.includes(rule.statement)) problems.push({ rule: "component-not-verified", detail: `the verified statement lacks "${rule.statement}"` });
  const pinned = opportunity.contract.competencies;
  if (pinned.length !== 1 || pinned[0]!.competencyUri !== held.uri || pinned[0]!.frameworkUri !== release.content.framework.uri) problems.push({ rule: "contract-mismatch", detail: "the evidence contract must assess exactly this one competency" });
  return problems;
}
