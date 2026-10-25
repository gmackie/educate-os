# Runbook: verify installer permissions on a sandbox account

- Status: Ready to run. Not yet run against any account.
- Issue: SCHO-66 (G2). Verifies: [installer-permissions.md](../installer-permissions.md).
- Tool: `packages/educateos-installer/scripts/verify-account.ts`
- Who runs it: someone with Super Administrator on a **sandbox** Cloudflare account made for this.
  About 30 minutes.

## What it checks

Each probe checks one claim that installer-permissions.md marks **unverified**. Where the installer
has the operation, the probe calls it through the installer's own `CloudflareHttpApi`, so the
installer's request shapes and response parsing are checked too.

| Probe | Kind | Settles |
| --- | --- | --- |
| `read.getAccount` | read | Account Settings: Read. This probe is also the sandbox guard. |
| `read.tokenVerify` | read | Whether the token is user-owned or account-owned. |
| `read.invalidCredentialCodes` | read, with a deliberately invalid token | The status and codes for a bad credential, and whether `errors.ts` treats them as a credential failure. |
| `read.listSubscriptions` | read | Whether Billing: Read is needed, and the account's actual rate plan IDs (the qualifying Workers Paid IDs). |
| `read.findZone`, `read.listDnsRecords` | read (needs `--zone`) | Zone: Read and DNS: Read. |
| `read.listWorkerScripts`, `read.listWorkerDomains` | read | Workers Scripts: Edit. |
| `read.listKvNamespaces`, `read.listR2Buckets`, `read.listD1Databases` | read | KV, R2 and D1 permissions; R2's not-enabled code 10042. |
| `read.getAccessOrganization`, `read.listAccessIdentityProviders`, `read.listAccessPolicies`, `read.listAccessApplications` | read | Both Access permission groups. |
| `read.listAiGateways` | read | AI Gateway permission. |
| `write.kvNamespace`, `write.r2Bucket`, `write.aiGateway` | create, then delete | The Edit permissions; R2 code 10042 on create. |
| `write.d1Database`, `write.d1Batch` | create, then delete | Whether a multi-statement `/query` with `params` runs, and whether a failing statement rolls back the earlier ones (`atomic`). The migration ledger depends on both. |
| `write.workerScript`, `write.workerSecret`, `write.workerVersions` | create, then delete | Upload, secrets, and whether version detail exposes plain-text var values (`plainTextVarsExposed`). Rollback depends on that. |
| `write.workerDomain` | create, then delete (needs `--zone`) | Whether `PUT /workers/domains` accepts the `environment` field, and the zone permission it needs. |
| `write.accessPolicy`, `write.accessApplication` | create, then delete (the app needs `--zone`) | Access: Apps and Policies: Edit. |

Two kinds of item are **not** probed:

- **Quotas.** Probing a quota means filling it.
- **The OAuth scopes.** Those need the public OAuth client from SCHO-67. Re-run the harness with
  an OAuth access token once that client exists. The harness only needs a bearer token.

## Safety rules

- **Only a sandbox account.** Make a Cloudflare account for this, with nothing else in it. Never use
  a district's account, the root's account, or any account with production data.
- The token is read from `EDUCATEOS_SANDBOX_CF_API_TOKEN`, not from the installer's
  `CLOUDFLARE_API_TOKEN`. A shell that already holds a real installer token therefore can't run it
  by accident.
- The first call reads the account. The run stops, having changed nothing, unless the account's
  name equals `--expect-account-name` exactly.
- **Dry run is the default.** Without `--apply`, only read probes run, and the create/delete probes
  are listed as `planned`.
- With `--apply`:
  - Every resource is named `educateos-probe-<runId>`, plus `.<zone>` for hostnames, where `runId`
    is 8 random hex characters.
  - Each resource's deletion is registered as soon as the resource exists.
  - Everything is deleted in reverse order, even when a later probe fails.
  - Anything that couldn't be deleted is listed under `leftovers`, and the tool exits 1.
- The report holds HTTP statuses, Cloudflare's numeric error codes, counts and booleans. It never
  holds the token, a response body, or Cloudflare's free-text messages.

## Prerequisites

1. **A sandbox Cloudflare account**, on Workers Paid (`plan.workers-paid-required`).
2. **R2.** Leave it **disabled** for the first run, so the probes observe code 10042. Enable it for
   the second run.
3. **A Zero Trust organization** with one non-PIN identity provider, so the Access reads have
   something to list.
4. **Optionally, an active zone** in the account, for example `sandbox.<something you own>`. It
   enables the DNS, custom-domain and Access-application probes.
5. **An API token** with exactly the permission set in installer-permissions.md's "API token
   permission" column. That set is under test. Create it under My Profile, then API Tokens, then
   Create Custom Token, or as an account-owned token:
   - Account Settings: Read
   - Billing: Read
   - Workers Scripts: Edit
   - Workers KV Storage: Edit
   - Workers R2 Storage: Edit
   - D1: Edit
   - Access: Organizations, Identity Providers, and Groups: Read
   - Access: Apps and Policies: Edit
   - AI Gateway: Edit
   - For the zone: Zone: Read, DNS: Read and Workers Routes: Edit

   Cloudflare's permission reference is
   <https://developers.cloudflare.com/fundamentals/api/reference/permissions/>.

## Procedure

Run each command from a worktree of this repository.

```sh
export EDUCATEOS_SANDBOX_CF_API_TOKEN=...   # the sandbox token, from a password manager

# 1. Dry run: read probes only.
node packages/educateos-installer/scripts/verify-account.ts \
  --account <sandbox account ID> --expect-account-name "<sandbox account name>" \
  --zone <sandbox zone> --out /tmp/verify-dry.json

# 2. Apply, with R2 still disabled: observes 10042 on create.
node packages/educateos-installer/scripts/verify-account.ts \
  --account <id> --expect-account-name "<name>" --zone <zone> --apply --out /tmp/verify-apply-r2-off.json

# 3. Enable R2 in the dashboard, then apply again.
node packages/educateos-installer/scripts/verify-account.ts \
  --account <id> --expect-account-name "<name>" --zone <zone> --apply --out /tmp/verify-apply.json

# 4. Minimum permissions: remove one permission from the token (start with Billing: Read), re-run
#    step 3, and see which probes turn `denied`. Repeat for each permission you suspect is not needed.

unset EDUCATEOS_SANDBOX_CF_API_TOKEN
```

After each apply run:

- Check that `leftovers` is empty.
- In the dashboard, search Workers, KV, R2, D1, AI Gateway, Access and DNS for `educateos-probe-`.
  Nothing should be found.
- If something is, delete it by hand. The `leftovers` entry names its kind and ID.

## Reading the report

| Field | Meaning |
| --- | --- |
| `result: ok` | The call succeeded with this token. |
| `result: denied` | HTTP 401 or 403, or a credential code. `cloudflareCodes` says which. The permission named in `checks` is missing or wrong. |
| `result: error` | Any other failure. The codes say why, for example 10042 for R2 not enabled. |
| `result: skipped` | Its precondition was missing. `reason` names it, for example `--zone`. |
| `result: planned` | A create/delete probe in a dry run. |
| `observation` | What the probe established: rate plan IDs, `atomic`, `plainTextVarsExposed`, `installerTreatsAsCredentialFailure`, and so on. |

## Recording the results

1. **The permission table.** Edit [installer-permissions.md](../installer-permissions.md). For each
   row a run confirmed, replace **unverified** with "verified <date>, SCHO-66". For each row a run
   contradicted, write the actual permission. Change the page's status line once every row is
   settled.
2. **D1 batching.** If `write.d1Batch` shows `atomic: false`, or `multiStatementWithParamsAccepted:
   false`, the migration ledger's assumption is wrong. Open an issue to apply migrations through the
   D1 batch endpoint, or to make the ledger idempotent, before the first pilot install.
3. **Version detail.** If `plainTextVarsExposed` is `false`, rollback can't find the previous
   release from version detail. Open an issue to record release IDs somewhere rollback can read.
4. **The domain `environment` field.** If `write.workerDomain` fails with a validation code, remove
   the field from `attachWorkerDomain` in `src/cloudflare-http.ts`.
5. **Credential codes.** Update `CREDENTIAL_CODES` in `src/errors.ts` with the codes
   `read.invalidCredentialCodes` observed. Do the same with any `denied` codes a step-4 run showed.
6. **The rate plan IDs** from `read.listSubscriptions` settle preflight's qualifying-plan list.
7. Attach the three report files to a comment on SCHO-66. They contain only the sandbox account ID.
