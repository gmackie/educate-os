// Canvas and Moodle, by LTI 1.3 Dynamic Registration (docs/educateos/lti.md):
//
//   1. Check the district serves its Tool: `/lti/jwks`, public, answers with its keys.
//   2. As a district administrator, create a single-use registration invitation (`POST /api/lti/invitations`).
//   3. The LMS administrator pastes the invitation URL into the LMS, which registers the Tool; the
//      registration lands in the district as pending, and can launch nothing yet.
//   4. Trust the LMS's issuer and approve the registration with the courses it maps
//      (`POST /api/lti/trusted-issuers`, `POST /api/lti/pending/<id>/approve`).
//   5. Live check: the registration is approved and the Tool's keys are published.
//
// Without a terminal, step 3 can't be waited for: the first run prints the invitation, and a second
// run with `--issuer` (and `--context-id`, `--offering-id`, and `--deployment-id` for Canvas)
// approves it.
import { EducateOsError } from "@educateos/contracts";
import { ACCESS_TOKEN_ENV, adminSession, askValue, type ConnectContext, type DistrictAdmin, printCheck, probe } from "./district.ts";
import type { Check, ConnectOutcome } from "./outcome.ts";

/** The LMSs that register by Dynamic Registration. */
export type DynamicRegistrationLms = "canvas" | "moodle";

/** A registration the district received and hasn't approved. */
export interface PendingRegistration {
  id: string;
  issuer: string;
  clientId: string;
  deploymentId?: string;
  productFamily?: string;
  receivedAt?: string;
}

/** An approved registration. */
export interface ApprovedRegistration {
  provider: string;
  issuer: string;
  clientId: string;
  deploymentIds: string[];
  offerings: { contextId: string; offeringId: string }[];
}

interface Registrations {
  registrations: ApprovedRegistration[];
  pending: PendingRegistration[];
}

/** The Tool's URLs, as an LMS administrator enters them for a manual registration. */
export function toolUrls(ltiOrigin: string) {
  return {
    login: `${ltiOrigin}/lti/login`,
    launch: `${ltiOrigin}/lti/launch`,
    redirect: `${ltiOrigin}/lti/launch`,
    jwks: `${ltiOrigin}/lti/jwks`,
    deepLink: `${ltiOrigin}/lti/deep-link`,
    register: `${ltiOrigin}/lti/register`,
  };
}

const LMS_NAME: Record<DynamicRegistrationLms, string> = { canvas: "Canvas", moodle: "Moodle" };

/** What the LMS administrator does with the invitation URL. */
export function platformSteps(lms: DynamicRegistrationLms, invitationUrl: string): string[] {
  if (lms === "canvas") {
    return [
      "Sign in to Canvas as an account administrator.",
      "Admin > (your account) > Developer Keys > + Developer Key > LTI Registration.",
      `Paste this as the registration URL and continue: ${invitationUrl}`,
      "Review what EducateOS asks for (AGS and NRPS scopes, anonymous privacy: Canvas sends no names or emails) and enable it. Canvas creates the developer key; turn it On.",
      "Install it: Admin > Settings > Apps > View App Configurations > + App > By Client ID (or in one course's Settings > Apps), with the key's client ID. Note the Deployment ID Canvas shows: approval needs it.",
    ];
  }
  return [
    "Sign in to Moodle as a site administrator.",
    "Site administration > Plugins > Activity modules > External tool > Manage tools.",
    `Paste this into Tool URL and choose Add LTI Advantage: ${invitationUrl}`,
    "Moodle registers EducateOS and lists it as Pending: choose Activate.",
  ];
}

/** Where the LMS course's context ID comes from. */
function contextHelp(lms: DynamicRegistrationLms): string {
  return lms === "canvas"
    ? "Canvas: the course's LTI context ID (`lti_context_id` in Canvas's Courses API, a 40-character hex string)."
    : "Moodle: the course ID (the `id` in the course's URL, course/view.php?id=<id>).";
}

async function checkTool(context: ConnectContext): Promise<Check> {
  const { ltiOrigin, accessTeamDomain } = context.district;
  const jwks = await probe(context.fetch, ltiOrigin, "/lti/jwks");
  const keys = (jwks.body as { keys?: unknown[] } | undefined)?.keys;
  if (jwks.status === 200 && Array.isArray(keys) && keys.length > 0) {
    return { name: "lti-tool", ok: true, detail: `${ltiOrigin}/lti/jwks publishes ${keys.length} tool key(s)` };
  }
  if (jwks.status === 0) return { name: "lti-tool", ok: false, detail: `no response from ${ltiOrigin}: is the install finished and the hostname resolving?` };
  if (jwks.status >= 300 && jwks.status < 400 && (jwks.location ?? "").includes(accessTeamDomain)) {
    return { name: "lti-tool", ok: false, detail: "Cloudflare Access is in front of /lti/*: LMS servers and students' browsers can't pass it. Re-run the install (it creates the bypass for /lti/*)." };
  }
  if (jwks.status === 404) return { name: "lti-tool", ok: false, detail: `the district at ${ltiOrigin} serves no LTI Tool (LTI_TOOL_ORIGIN unset): re-run the install with the district LMS enabled` };
  return { name: "lti-tool", ok: false, detail: `${ltiOrigin}/lti/jwks answered HTTP ${jwks.status}` };
}

function printUrls(context: ConnectContext): void {
  const urls = toolUrls(context.district.ltiOrigin);
  context.out.line();
  context.out.line("EducateOS's LTI 1.3 Tool (for reference; Dynamic Registration sends these to the LMS itself):");
  context.out.line(`  OIDC login URL         ${urls.login}`);
  context.out.line(`  Target link (launch)   ${urls.launch}`);
  context.out.line(`  Redirect URI           ${urls.redirect}`);
  context.out.line(`  Public JWKS URL        ${urls.jwks}`);
  context.out.line(`  Deep linking URL       ${urls.deepLink}`);
}

function manualRequests(origin: string, lms: DynamicRegistrationLms): string[] {
  const curl = (method: string, path: string, body?: string) =>
    `curl -sS -X ${method} ${origin}${path} -H "cf-access-token: $T" -H 'content-type: application/json'${body ? ` -d '${body}'` : ""}`;
  return [
    `T=$(cloudflared access token --app ${origin})`,
    curl("POST", "/api/lti/invitations"),
    `# then, after ${LMS_NAME[lms]} has registered:`,
    curl("GET", "/api/lti/registrations"),
    curl("POST", "/api/lti/trusted-issuers", '{"issuer":"<issuer>"}'),
    curl("POST", "/api/lti/pending/<id>/approve", `{"provider":"${lms}","offerings":[{"contextId":"<course context ID>","offeringId":"<off_...>"}]${lms === "canvas" ? ',"deploymentIds":["<deployment ID>"]' : ""}}`),
  ];
}

function teacherSteps(lms: DynamicRegistrationLms, origin: string): string[] {
  const steps = lms === "canvas"
    ? [
      "Teachers: the course now has an EducateOS tab; Assignments > + Assignment > Submission type External Tool > Find > EducateOS opens the activity picker.",
    ]
    : [
      "Teachers: Add an activity or resource > External tool > EducateOS, then Select content to open the activity picker.",
    ];
  steps.push(
    `Link LMS accounts to EducateOS people: a launch from an unlinked account shows its issuer and subject; record the link with POST ${origin}/api/lti/identity-links and approve it under Admin > identity requests.`,
    `Map more courses later with POST ${origin}/api/lti/registrations/course-links (docs/educateos/lti.md).`,
  );
  return steps;
}

async function choosePending(context: ConnectContext, admin: DistrictAdmin, lms: DynamicRegistrationLms): Promise<PendingRegistration | undefined> {
  const { out, prompter, flags } = context;
  for (let attempt = 0; ; attempt++) {
    const { pending } = await admin.call<Registrations>("GET", "/api/lti/registrations");
    const candidates = flags.issuer
      ? pending.filter((entry) => entry.issuer === flags.issuer)
      : pending.filter((entry) => entry.productFamily === undefined || entry.productFamily === lms || entry.productFamily.includes(lms));
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) {
      if (!prompter) throw new EducateOsError("conflict", `${candidates.length} pending registrations match: pass --issuer to choose one`);
      return await prompter.select("Which pending registration is this LMS?", candidates.map((entry) => ({
        label: `${entry.issuer} (client ${entry.clientId}${entry.deploymentId ? `, deployment ${entry.deploymentId}` : ""}, received ${entry.receivedAt ?? "?"})`,
        value: entry,
      })));
    }
    if (!prompter || attempt >= 5) return undefined;
    out.line(`No pending registration from ${LMS_NAME[lms]} yet.`);
    if (!(await prompter.confirm("Check again?", true))) return undefined;
  }
}

/** Connects Canvas or Moodle to the district by LTI 1.3 Dynamic Registration. */
export async function connectLti(context: ConnectContext, lms: DynamicRegistrationLms): Promise<ConnectOutcome> {
  const { out, district } = context;
  const name = LMS_NAME[lms];
  const checks: Check[] = [];
  const outcome = (status: ConnectOutcome["status"], nextSteps: string[]): ConnectOutcome => ({ integration: lms, status, checks, nextSteps });

  out.line(`Before you start: a ${name} administrator account, and a district administrator in EducateOS.`);
  out.line();
  const tool = await checkTool(context);
  checks.push(tool);
  printCheck(out, tool);
  if (!tool.ok) return outcome("failed", [tool.detail]);
  printUrls(context);

  const admin = await adminSession(context);
  if (admin === undefined) {
    out.line();
    out.line("No Access token, so nothing was registered. As a district administrator, run:");
    const requests = manualRequests(district.origin, lms);
    for (const line of requests) out.line(`  ${line}`);
    return outcome("pending", [`Create an invitation and approve the registration as a district administrator (see docs/educateos/lti.md), or re-run with ${ACCESS_TOKEN_ENV} set.`]);
  }

  if (!context.flags.issuer) {
    const invitation = await admin.call<{ url: string; expiresAt: string }>("POST", "/api/lti/invitations");
    out.line();
    out.line(`Registration invitation (single use, expires ${invitation.expiresAt}):`);
    out.line(`  ${invitation.url}`);
    out.line();
    out.line(`In ${name}:`);
    platformSteps(lms, invitation.url).forEach((step, i) => out.line(`  ${i + 1}. ${step}`));
    if (!context.prompter) {
      return outcome("pending", [
        ...platformSteps(lms, invitation.url),
        `Then run \`npx launch-educate-os connect ${lms} --issuer <${name} issuer> --context-id <course> --offering-id <off_...>${lms === "canvas" ? " --deployment-id <id>" : ""}\` to approve it.`,
      ]);
    }
    out.line();
    await context.prompter.text(`Press Enter once ${name} shows EducateOS registered`, { default: "" });
  }

  const pending = await choosePending(context, admin, lms);
  if (pending === undefined) {
    const { registrations } = await admin.call<Registrations>("GET", "/api/lti/registrations");
    const approved = registrations.find((entry) => (context.flags.issuer ? entry.issuer === context.flags.issuer : entry.provider === lms));
    if (approved) return verify(context, admin, lms, approved.issuer, approved.clientId, checks);
    return outcome("pending", [`${name} hasn't registered yet. The invitation is single-use and expires in an hour: run \`npx launch-educate-os connect ${lms}\` again for a new one.`]);
  }
  out.line();
  out.line(`${name} registered: issuer ${pending.issuer}, client ${pending.clientId}${pending.deploymentId ? `, deployment ${pending.deploymentId}` : ""}.`);

  out.line();
  out.line(`Plan: trust ${pending.issuer} as an LMS issuer, and approve the registration for one course.`);
  out.line("Approval maps an LMS course to an EducateOS offering (off_...); launches from unmapped courses are refused.");
  const contextId = await askValue(context, context.flags.contextId, "LMS course context ID", contextHelp(lms));
  const offeringId = await askValue(context, context.flags.offeringId, "EducateOS offering ID (off_...)", "The offering's ID is in the district admin console under the course's offering.");
  const deploymentId = pending.deploymentId ?? await askValue(context, context.flags.deploymentId, "Deployment ID", `${name} shows it when the app is installed; it returned none at registration.`);
  if (!contextId || !offeringId || (!pending.deploymentId && !deploymentId)) {
    return outcome("pending", [
      `Approve the pending registration ${pending.id} with a course mapping: re-run with --issuer ${pending.issuer} --context-id <course> --offering-id <off_...>${pending.deploymentId ? "" : " --deployment-id <id>"}.`,
    ]);
  }
  if (!context.yes && context.prompter && !(await context.prompter.confirm(`Trust ${pending.issuer} and approve?`, true))) {
    return outcome("skipped", ["Nothing was approved; the registration stays pending."]);
  }
  if (!context.yes && !context.prompter) {
    out.line("Not approving: pass --yes to approve without a terminal to confirm on.");
    return outcome("pending", [`Re-run with --yes to trust ${pending.issuer} and approve.`]);
  }
  await admin.call("POST", "/api/lti/trusted-issuers", { issuer: pending.issuer });
  out.line(`  Trusted ${pending.issuer}.`);
  await admin.call("POST", `/api/lti/pending/${encodeURIComponent(pending.id)}/approve`, {
    provider: lms,
    offerings: [{ contextId, offeringId }],
    ...(pending.deploymentId ? {} : { deploymentIds: [deploymentId] }),
  });
  out.line(`  Approved for ${offeringId}.`);
  return verify(context, admin, lms, pending.issuer, pending.clientId, checks);
}

async function verify(context: ConnectContext, admin: DistrictAdmin, lms: DynamicRegistrationLms, issuer: string, clientId: string, checks: Check[]): Promise<ConnectOutcome> {
  const { registrations } = await admin.call<Registrations>("GET", "/api/lti/registrations");
  const found = registrations.find((entry) => entry.issuer === issuer && entry.clientId === clientId);
  const check: Check = found
    ? { name: "lti-registration", ok: true, detail: `${issuer} is approved: ${found.deploymentIds.length} deployment(s), ${found.offerings.length} course(s) mapped` }
    : { name: "lti-registration", ok: false, detail: `no approved registration for ${issuer} (client ${clientId})` };
  checks.push(check);
  context.out.line();
  printCheck(context.out, check);
  if (!check.ok) return { integration: lms, status: "failed", checks, nextSteps: [check.detail] };
  return { integration: lms, status: "connected", checks, nextSteps: teacherSteps(lms, context.district.origin) };
}
