# Runbook: Access `sub` stability under email reassignment

- Status: Ready to run. Not yet run against a live organization.
- Issue: SCHO-37. Decision it feeds: [ADR-0003](../adr/0003-principal-identity.md), "Caveat".
- Tool: `packages/schoolos-identity/scripts/compare-access-jwts.ts`
- Who runs it: someone with Super Administrator on a **test** Cloudflare account and admin rights in
  a **test** identity provider. About 45 minutes.

## Why

ADR-0003 makes a person's identity `(district, issuer, subject)`. For Cloudflare Access, the
subject is the Access JWT's `sub`. The ADR's caveat says that if the IdP gives a departed person's
address to someone new and the old Access user is never removed, the new holder may get the same
`sub`, and so the same principal. This runbook settles that against a live organization.

Cloudflare's documentation already points that way. The application token page says of `sub`:
"The ID of the user. This value is unique to an email address per account. The user would get a
different `sub` if they are removed and re-added to your Zero Trust organization, or if they log
into a different organization."
(<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/>,
read 2026-10-21). Two things are still undocumented, and they are what this test is for:

1. What happens when the IdP renames an address in place, or gives it to a new IdP account.
2. What "removed" means. The seat management page says "You cannot delete or archive a user
   record. You can remove a user from a seat, but their user record will remain in your Zero Trust
   Organization."
   (<https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/>).
   But the API has `DELETE /accounts/{account_id}/access/users/{user_id}`
   (<https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/users/methods/delete/>).
   The two pages contradict each other.

The test also records the upstream IdP's own subject, so that ADR-0003 can switch to it if Access
`sub` proves unsafe.

## Never do this in a district's organization

Use a Cloudflare account and an IdP tenant made for this test, with synthetic people. Step 4 hands a
person's address to someone else, which in a real organization would give a stranger that person's
work.

## Prerequisites

1. **A test Cloudflare account** with a Zero Trust organization (the Free plan is enough). Write
   its team domain down: `https://<team>.cloudflareaccess.com`.
2. **A test OIDC identity provider** where you can create users, rename a user's email address, and
   give an address to a different user. Any OIDC tenant you control works, such as a developer
   tenant of Okta or Entra ID. Add it in Zero Trust as a generic OIDC provider
   (<https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/generic-oidc/>).
   Under **OIDC Claims**, add `sub`. Then use **Test** to check that `sub` appears in
   `oidc_fields`. Without this claim, the upstream comparisons in the report read `not-recorded`.
   A SAML IdP also works, but the NameID is not guaranteed to appear in get-identity.
3. **An Access self-hosted application** on any hostname in the test account, with an Allow
   policy for the test IdP's email domain. Its origin can be anything that answers, for example a
   Worker that returns "ok".
4. **Two test IdP users.** Person A holds `pilot-teacher@<test domain>` at the start. Person B
   doesn't exist yet; you create B in step 4.
5. **A separate browser profile or private window per sign-in**, so no Access cookie carries over.
6. **The recording file**, `recording.json`, kept **outside the repository**. It will hold live
   tokens. Start it as:

   ```json
   { "observations": [] }
   ```

## Capturing one observation

Do this every time a step says "capture".

1. Open a fresh private window and sign in to the application through the test IdP.
2. **The token.** In developer tools, under Application, then Cookies, for the application's
   hostname, copy the value of `CF_Authorization`.
3. **The identity.** In the same window, open
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/get-identity` and copy the JSON
   (<https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/>).
4. **The user record.** In the Zero Trust dashboard, open Team & Resources, then Users, find the
   address, and note the user's ID. Or call
   `GET /accounts/{account_id}/access/users?email=<address>` and note `id`.
5. Add an entry to `recording.json`:

   ```json
   { "step": "s1-baseline", "person": "a", "jwt": "<CF_Authorization value>",
     "identity": { "...": "the get-identity JSON" },
     "note": "Access user id <id>; 14:02 UTC" }
   ```

6. Close the window.

Between steps, end the previous session, or the next sign-in may reuse it. Revoke the user's
session in Users, then **Revoke session**, or with
`POST /accounts/{account_id}/access/organizations/revoke_user` and the user's email
(<https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/revoke_users/>).
Then wait at least a minute: a revoked user "will not be able to log in again for up to 1 minute"
(<https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/>).

## Steps

| Step | Change made just before | Who signs in | Capture as |
| --- | --- | --- | --- |
| 1 | Nothing. A has never signed in to Access. | A | `s1-baseline`, person `a` |
| 2 | Revoke A's session. Nothing else changes. This is the control. | A | `s2-repeat`, person `a` |
| 3 | In the IdP, rename A's email to `pilot-teacher-renamed@<test domain>`. It is the same IdP account. Revoke sessions. | A | `s3-rename`, person `a` |
| 4 | In the IdP, create person B with the original address `pilot-teacher@<test domain>`. B is a new IdP account. Do **not** touch Access. | B | `s4-reassigned`, person `b` |
| 5 | Delete the Access user record for `pilot-teacher@<test domain>`: first try `DELETE /accounts/{account_id}/access/users/{user_id}`. If that is refused, use **Remove** in the dashboard's Users page. Note which one worked. Revoke sessions. | B | `s5-after-delete`, person `b` |

Before step 5, also record what the Users page shows for the original address: one user record, or
two.

## Comparing

```sh
node packages/schoolos-identity/scripts/compare-access-jwts.ts /path/outside/repo/recording.json
```

It decodes each token's payload without verifying the signature. The tokens are your own, from a
test organization, and only their claims are compared. It reads `iss`, `sub` and get-identity's
`oidc_fields.sub`, and ignores the rest. It prints a report with no tokens and no addresses, and
exits non-zero for an invalid run. The report's fields are:

| Field | Compares | Means |
| --- | --- | --- |
| `repeatSub` | Access `sub`, step 1 against step 2 | Control. Anything but `same` makes the run `invalid-run`. |
| `renameSub` | Access `sub`, 1 against 3 | `different`: a rename splits one person into two principals. |
| `reassignedSub` | Access `sub`, 1 against 4 | `same`: a reassigned address merges two people into one principal. |
| `afterDeleteSubVsBaseline` | Access `sub`, 1 against 5 | `different`: deleting the Access user ends the inheritance. |
| `upstreamSubjectReassigned` | IdP `sub`, 1 against 4 | Should be `different`: the IdP tells A and B apart. |
| `upstreamSubjectRename` | IdP `sub`, 1 against 3 | Should be `same`: the IdP keeps A as A. |

### Expected observations

From Cloudflare's wording ("unique to an email address per account"), expect:

- `repeatSub: same`
- `renameSub: different`
- `reassignedSub: same`
- `afterDeleteSubVsBaseline: different`, if the deletion in step 5 really removes the record. If only
  **Remove** was available, it may come back `same`.
- `upstreamSubjectReassigned: different` and `upstreamSubjectRename: same`.

That is the outcome `sub-keyed-by-email-delete-resets`. Any other outcome is a finding in its own
right, so record it exactly as observed.

## Outcomes, and what ADR-0003 should say for each

| Outcome | Observed | ADR-0003 should say |
| --- | --- | --- |
| `sub-follows-idp-account` | A keeps `sub` across the rename. B gets a new one. | Access `sub` is a stable per-person subject in this organization. Remove the caveat. Keep `sub` as the subject. |
| `sub-keyed-by-email-delete-resets` | B inherits A's `sub` until the Access user is deleted. A's rename gives A a new `sub`. | Access `sub` is keyed by email. Keep it as the subject only together with two obligations. First, offboarding **must delete** the departing person's Access user record, by the mechanism step 5 showed works, before their address can be reused. Second, an address rename needs an administrator relink: the new `sub` arrives as an unknown identity, and the existing pending-link flow handles it. Record which deletion mechanism works. Add a follow-up to resolve to the upstream IdP subject (below). |
| `sub-keyed-by-email-sticky` | B inherits A's `sub` even after step 5. | Access `sub` is not a safe subject. Supersede the Access part of ADR-0003: the subject becomes the upstream IdP's `sub`, read from get-identity's `oidc_fields.sub`. The issuer becomes the IdP's own issuer, not the team domain, so it can never collide with Access subjects. This needs a kernel change: the sign-in seam must call get-identity, which only works for OIDC IdPs configured to pass `sub` through. Until it lands, a district may not reuse addresses. |
| `sub-splits-on-rename` | B gets a new `sub`, but A's rename gives A a new one too. | Access `sub` never merges two people, so the caveat about merging goes. A rename creates a new identity, which an administrator links to the existing principal through the pending-link flow. Document that in the offboarding runbook as a rename step. |
| `invalid-run` | The control failed, or a step is missing, duplicated or recorded for the wrong person. | Nothing. Fix what the report's `problems` lists, and run again. |

Whatever the outcome, if `upstreamSubjectReassigned` is `different` and `upstreamSubjectRename`
is `same`, say so in the ADR. It means the upstream subject is a usable fallback with this IdP.

## Recording the results

1. Run the comparison and keep its JSON output. It contains no tokens.
2. Post a comment on SCHO-37 with:
   - the date;
   - the IdP product and protocol (OIDC or SAML);
   - which deletion mechanism step 5 used;
   - how many Users-page records the original address had before step 5;
   - the report JSON.
3. Update ADR-0003's "Caveat" bullet with the outcome's text from the table above, and link the
   SCHO-37 comment. If the outcome is `sub-keyed-by-email-sticky`, write a new ADR that supersedes
   the Access part of ADR-0003, instead of editing it.
4. Write the offboarding step into the district offboarding runbook. That runbook doesn't exist yet,
   so create `docs/schoolos/runbooks/offboarding.md` with it.
5. **Delete `recording.json`.** It holds live tokens for the test organization. Then delete
   person B, and person A if you no longer need them.
