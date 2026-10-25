// Verifies the unverified items in docs/educateos/installer-permissions.md against a SANDBOX
// Cloudflare account (SCHO-66). Runbook: docs/educateos/runbooks/installer-sandbox-verification.md.
//
//   EDUCATEOS_SANDBOX_CF_API_TOKEN=... node packages/educateos-installer/scripts/verify-account.ts \
//     --account <sandbox account ID> --expect-account-name "<sandbox account name>" \
//     [--zone <sandbox zone>] [--apply] [--out verify-account-report.json]
//
// Without --apply it is a dry run: read-only probes only, and the create/delete probes are listed
// as planned. With --apply it creates and deletes `educateos-probe-<runId>` resources. Never point
// it at a district's or any production account. The token is read from its own variable, not
// CLOUDFLARE_API_TOKEN, so a shell already holding a real installer token cannot run it by
// accident, and the run stops before any other call unless the account's name matches.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { SandboxGuardError, verifyAccount } from "./verify-account-probes.ts";

/** The environment variable the harness reads its sandbox API token from. */
const TOKEN_ENV = "EDUCATEOS_SANDBOX_CF_API_TOKEN";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    "expect-account-name": { type: "string" },
    zone: { type: "string" },
    apply: { type: "boolean", default: false },
    out: { type: "string", default: "verify-account-report.json" },
  },
});

const token = process.env[TOKEN_ENV];
if (!token || !values.account || !values["expect-account-name"]) {
  console.error(`usage: ${TOKEN_ENV}=<token> node verify-account.ts --account <id> --expect-account-name <name> [--zone <zone>] [--apply] [--out <file>]`);
  process.exit(2);
}

try {
  const report = await verifyAccount({
    token,
    accountId: values.account,
    expectedAccountName: values["expect-account-name"],
    ...(values.zone ? { zone: values.zone } : {}),
    apply: values.apply,
    runId: randomBytes(4).toString("hex"),
  });
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`);
  for (const probe of report.probes) {
    const codes = probe.cloudflareCodes?.length ? ` codes ${probe.cloudflareCodes.join(",")}` : "";
    console.log(`${probe.result.padEnd(8)} ${probe.id}${probe.httpStatus ? ` HTTP ${probe.httpStatus}` : ""}${codes}`);
  }
  console.log(`report written to ${values.out} (run ${report.runId}, ${report.mode})`);
  if (report.leftovers.length > 0) {
    console.error(`NOT CLEANED UP, delete by hand: ${report.leftovers.join(", ")}`);
    process.exit(1);
  }
} catch (error) {
  if (error instanceof SandboxGuardError) {
    console.error(`refused: ${error.message}`);
    process.exit(3);
  }
  throw error;
}
