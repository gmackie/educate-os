// What a connect flow ends with, and the integrations `connect` knows.

/** One check a flow ran against a live system. */
export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** How a connect flow ended. */
export interface ConnectOutcome {
  integration: IntegrationId;
  /**
   * `connected`: everything this tool can do is done and the live check passed. `pending`: waiting on
   * a step in the other system or the admin console. `failed`: a live check failed. `skipped`: the
   * operator stopped. `unsupported`: EducateOS can't connect it yet.
   */
  status: "connected" | "pending" | "failed" | "skipped" | "unsupported";
  checks: Check[];
  nextSteps: string[];
  /** The answers file changed and needs applying (a `DISTRICT_CONFIG` edit). */
  answersChanged?: boolean;
}

/** The integrations `connect` takes. */
export const INTEGRATION_IDS = ["canvas", "moodle", "schoology", "google-classroom", "clever", "classlink", "oneroster"] as const;
/** An integration `connect` takes. */
export type IntegrationId = (typeof INTEGRATION_IDS)[number];

/** What the menu says about each integration. */
export interface IntegrationInfo {
  id: IntegrationId;
  name: string;
  kind: "LMS" | "Roster";
  /** Whether `connect` can set it up. */
  supported: boolean;
  /** One line: what it gives the district, or why it isn't available. */
  summary: string;
  /** What has and hasn't been proven against the real system. */
  evidence: string;
}

/** Every integration, in menu order. */
export const INTEGRATIONS: readonly IntegrationInfo[] = [
  {
    id: "canvas", name: "Canvas", kind: "LMS", supported: true,
    summary: "LTI 1.3: EducateOS activities in Canvas courses, deep linking, rosters (NRPS) and teacher-approved grade passback (AGS).",
    evidence: "Passed a live run against a self-hosted current Canvas (2026-10-26, SCHO-177/240). Not yet run on Canvas Cloud (instructure.com); not 1EdTech-certified.",
  },
  {
    id: "moodle", name: "Moodle", kind: "LMS", supported: true,
    summary: "LTI 1.3 Advantage: EducateOS activities in Moodle courses, deep linking, rosters and grade passback.",
    evidence: "Passed a live run against Moodle 4.5 (2026-10-26, SCHO-240). Not 1EdTech-certified.",
  },
  {
    id: "schoology", name: "Schoology", kind: "LMS", supported: false,
    summary: "Not available yet: Schoology registers LTI 1.3 tools manually, and EducateOS accepts only Dynamic Registration today.",
    evidence: "Tested only against a simulated Schoology. Write to hello@educateos.io if your district needs it.",
  },
  {
    id: "google-classroom", name: "Google Classroom", kind: "Roster", supported: true,
    summary: "District-wide roster sync from Classroom through a service account with domain-wide delegation.",
    evidence: "Coursework and grade sync validated live on one course; district-wide roster sync is tested against simulated Google only.",
  },
  {
    id: "clever", name: "Clever", kind: "Roster", supported: true,
    summary: "Hourly roster sync from Clever's Data API with the district-app token Clever issues for your district.",
    evidence: "Tested against a simulated Clever only: no real Clever roster has been imported yet (the sandbox token lacked roster scopes).",
  },
  {
    id: "classlink", name: "ClassLink", kind: "Roster", supported: false,
    summary: "Scheduled ClassLink (OneRoster API) sync isn't wired into the district yet: export OneRoster CSV from ClassLink Roster Server and use `connect oneroster`.",
    evidence: "The ClassLink client is tested against simulated ClassLink only.",
  },
  {
    id: "oneroster", name: "OneRoster (CSV)", kind: "Roster", supported: true,
    summary: "Import a OneRoster 1.2 CSV export (from your SIS or ClassLink), with a preview of every change before anything is applied.",
    evidence: "CSV import is unit- and harness-tested; no real SIS export has been imported yet. Scheduled OneRoster API sync isn't available yet.",
  },
];

/** The menu entry of one integration. */
export function integration(id: IntegrationId): IntegrationInfo {
  return INTEGRATIONS.find((entry) => entry.id === id)!;
}

/** One row of `status`. */
export interface StatusRow {
  /** What it is about: `district`, `sign-in`, `lti-tool`, an integration, `roster-sync`. */
  area: string;
  state: "ok" | "not configured" | "failing" | "unknown" | "not available";
  detail: string;
  /** What to run or do about it. */
  fix?: string;
}
