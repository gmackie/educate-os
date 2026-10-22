// The test deployment: Northfield's directory with a course, personal and safety pool, one priced
// model, and principals covering each audience and failure mode. Loaded by vitest.config.ts (Node)
// into the `AI_GUARD_CONFIG` binding, and by the tests to build guards directly.

import type { z } from "zod";
import { NORTHFIELD } from "@schoolos/fixtures";
import type { GuardConfig } from "../src/config.ts";

/** Workshop user IDs, one per case. */
export const USERS = {
  /** A student, moderated, failing closed. */
  student: "amara@northfield.example",
  /** A student bound to a profile that would proceed unmoderated: still fails closed. */
  studentMisconfigured: "dmitri@northfield.example",
  /** An educator whose profile proceeds when Hall Monitor is down. */
  educatorProceeds: "morgan@northfield.example",
  /** An educator whose profile fails closed. */
  educatorFailsClosed: "elena@northfield.example",
  /** A student whose profile does not moderate input. */
  unmoderated: "chidi@northfield.example",
  /** A teacher, known to the district only through a confirmed Workshop user link. */
  teacher: "morgan.lee@teachers.example",
  /** A district administrator. */
  admin: "avery@northfield.example",
  /** A middle-school student. */
  middleSchooler: "felix@northfield.example",
} as const;

/** The Workshop gadget that is Amara's Biology I course workspace. */
export const AMARA_BIO_GADGET = "gadget-amara-bio";

export const SONNET = { provider: "anthropic", modelId: "claude-sonnet-example" } as const;
export const MODERATOR = { provider: "cloudflare", modelId: "clef-flash-example" } as const;
/** A Workers AI model the deployment lists without rates, so the shared Cloudflare price book prices it. */
export const WORKERS_AI = { provider: "cloudflare", modelId: "@cf/cloudflare/clef-flash" } as const;
const BIO_FALL = { kind: "course", offeringId: "off_nf-bio-fall-p2" } as const;
const PERSONAL = { kind: "personal" } as const;

/** The safety pool's monthly allocation: $1. */
export const SAFETY_ALLOCATION = "1000000000";
/**
 * What one fake Hall Monitor evaluation costs: $0.000038, the fake's `FAKE_CHECK_COST_USD_NANO`.
 * Repeated rather than imported because vitest.config.ts loads this file in Node, which cannot
 * strip types from the Hall Monitor contracts package the fake imports.
 */
export const CHECK_COST = "38000";

/** The configuration, as JSON-ready data. */
export const TEST_CONFIG = {
  districtId: "dst_northfield",
  directory: NORTHFIELD,
  fundingPools: [
    {
      id: "fpl_nf-bio-fall",
      name: "Biology I, Period 2",
      purpose: "course",
      scope: { level: "offering", districtId: "dst_northfield", schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" },
      monthlyAllocationUsdNano: "10000000000",
      allowedModels: [SONNET],
    },
    {
      id: "fpl_nf-personal",
      name: "Personal workspaces",
      purpose: "personal",
      scope: { level: "district", districtId: "dst_northfield" },
      monthlyAllocationUsdNano: "10000000000",
      allowedModels: [SONNET, WORKERS_AI],
    },
    {
      id: "fpl_nf-safety",
      name: "Moderation",
      purpose: "safety",
      scope: { level: "district", districtId: "dst_northfield" },
      monthlyAllocationUsdNano: SAFETY_ALLOCATION,
      allowedModels: [MODERATOR],
    },
  ],
  modelCatalog: [{ ...SONNET, mode: "enabled" }, { ...WORKERS_AI, mode: "enabled" }, { ...MODERATOR, mode: "hidden" }],
  policy: {
    aiSpending: "capped",
    promptsInGatewayLogs: "prohibited",
    studentPersonalConversations: "private",
    teacherObservation: "assigned-work-only",
    automatedSelProfiling: "prohibited",
    aiMonthlyCapCentsPerPrincipal: 400,
  },
  modelRates: [
    {
      ...SONNET,
      priceBookId: "anthropic-list-2026-10",
      inputUsdNanoPerMTok: "3000000000",
      outputUsdNanoPerMTok: "15000000000",
      cacheReadUsdNanoPerMTok: "300000000",
      cacheWriteUsdNanoPerMTok: "3750000000",
      reserveInputTokens: 100_000,
      defaultMaxOutputTokens: 4096,
    },
    { ...WORKERS_AI, reserveInputTokens: 10_000, defaultMaxOutputTokens: 16 },
  ],
  moderation: {
    model: MODERATOR,
    maxUsdNanoPerCheck: "100000",
    tenantId: "tenant_schoolos",
    costCenterId: "cc_northfield",
    timeoutMs: 2000,
  },
  contextSource: "district",
  workshopUserLinks: [
    [USERS.student, "prn_nf-student-amara"],
    [USERS.unmoderated, "prn_nf-student-chidi"],
    [USERS.teacher, "prn_nf-morgan-lee"],
    [USERS.admin, "prn_nf-district-admin"],
    [USERS.middleSchooler, "prn_nf-student-felix"],
  ].map(([workshopUser, principalId]) => ({
    districtId: "dst_northfield",
    workshopUser: workshopUser!,
    principalId: principalId!,
    confirmedBy: "prn_nf-district-admin",
    confirmedAt: "2026-10-20T15:00:00Z",
  })),
  workspaces: [
    {
      kind: "course",
      id: "wsp_nf-amara-bio",
      districtId: "dst_northfield",
      ownerPrincipalId: "prn_nf-student-amara",
      createdAt: "2026-09-01T12:00:00Z",
      storageHandle: { backend: "workshop", ref: AMARA_BIO_GADGET },
      schoolId: "sch_nf-high",
      offeringId: "off_nf-bio-fall-p2",
      termId: "trm_nf-2026-fall",
    },
  ],
  profiles: {
    "student-k5": { hallMonitorProfileId: "k12-elementary", revision: "r2", moderateInput: true, failureMode: "fail-closed" },
    "student-6-8": { hallMonitorProfileId: "k12-middle", revision: "r2", moderateInput: true, failureMode: "fail-closed" },
    "student-9-12": { hallMonitorProfileId: "k12-high", revision: "r2", moderateInput: true, failureMode: "fail-closed" },
    educator: { hallMonitorProfileId: "educator", revision: "r1", moderateInput: true, failureMode: "proceed" },
    student: { hallMonitorProfileId: "k12-student", revision: "r3", moderateInput: true, failureMode: "fail-closed" },
    "student-misconfigured": { hallMonitorProfileId: "k12-student", revision: "r3", moderateInput: true, failureMode: "proceed" },
    "educator-proceeds": { hallMonitorProfileId: "educator", revision: "r1", moderateInput: true, failureMode: "proceed" },
    "educator-fails-closed": { hallMonitorProfileId: "educator", revision: "r1", moderateInput: true, failureMode: "fail-closed" },
    unmoderated: { hallMonitorProfileId: "k12-student", revision: "r3", moderateInput: false, failureMode: "fail-closed" },
  },
  principals: [
    { workshopUserId: USERS.student, principalId: "prn_nf-student-amara", audience: "student", gradeBand: "9-12", profile: "student", workspace: BIO_FALL },
    { workshopUserId: USERS.studentMisconfigured, principalId: "prn_nf-student-dmitri", audience: "student", gradeBand: "9-12", profile: "student-misconfigured", workspace: PERSONAL },
    { workshopUserId: USERS.educatorProceeds, principalId: "prn_nf-morgan-lee", audience: "educator", profile: "educator-proceeds", workspace: PERSONAL },
    { workshopUserId: USERS.educatorFailsClosed, principalId: "prn_nf-student-elena", audience: "educator", profile: "educator-fails-closed", workspace: PERSONAL },
    { workshopUserId: USERS.unmoderated, principalId: "prn_nf-student-chidi", audience: "student", profile: "unmoderated", workspace: PERSONAL },
  ],
  messages: { support: "You're not in trouble. Please talk to Ms. Rivera or another adult you trust; they can help." },
} satisfies z.input<typeof GuardConfig>;
