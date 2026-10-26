# Canvas LTI 1.3 Tool run (labnuc)

- Status: Passed, 2026-10-26 (04:15–04:50 UTC). Not a 1EdTech conformance or certification run.
- Issue: SCHO-177 (umbrella SCHO-198). Canvas instance: SCHO-219.
- Tool: the production district Worker, `https://district.schoolos.gmac.io`, deployment
  `37eddfe8-43f6-4fcb-a55f-c62a5fdc278b` (commit `dbb60aa`, PR #132; durable tool keys in #129).
- Platform: current Canvas (canvas-lms `prod` @ `44bfdc264d`, stable/2026-04-22) at
  `https://canvas.mackie.house`, issuer `https://canvas.mackie.house`, root account **EducateOS
  Demo** (account 3). The PlayTrek Dev account was not used.

## Setup

| | |
| --- | --- |
| Canvas course | 2, "EducateOS LTI Demo" (context `61f3600b24f01a51af8076f1fd9c04d5be7541ab`) |
| Canvas users | teacher 4 `teacher@demo.educateos.io`, student 5 `student@demo.educateos.io` |
| Developer key | client ID `10000000000003`, created by Dynamic Registration, scopes AGS (4) and NRPS |
| Deployment | `2:61f3600b24f01a51af8076f1fd9c04d5be7541ab` (tool installed in course 2) |
| EducateOS offering | `off_7f4d561f-3c9f-43aa-8d5f-6bde0e7614af`, Earth Science, Tuesday mornings (demo co-op district) |
| Identity links | Canvas `sub` `5754c5b7-…` to Terry Teacher, `99015608-…` to Sam Student, approved through `/api/admin/identity-requests` |
| Access | bypass app `6afc08c5-508a-4d37-9cfd-07bf160ae363` for exactly `/lti/{login,launch,jwks,deep-link,register}`; `/api/lti/*` and everything else stays behind the district's Access app |

## Results

Request IDs are Cloudflare `cf-ray` IDs on the district Worker, or Canvas request IDs (UUIDs) from
its `production.log`.

| Service | Result | Evidence |
| --- | --- | --- |
| Dynamic Registration | Passed | The tool fetched Canvas's OpenID configuration and registered at `POST /api/lti/registrations` (cf-ray `a506aaf22ffe73db`); Canvas created key `10000000000003` with the requested scopes and no deployment, so the approval named the course deployment. See the notes on the registration token. |
| Registration approval | Passed | Refused (409) until the admin trusted the issuer (cf-ray `a506affb0e79b6f8`); a teacher could not trust it (403, `a506b0019fc2e7f9`); approved with the offering mapping (`a506b00aa935ab95`). |
| OIDC launch, teacher | Passed | Canvas → `/lti/login` → `authorize_redirect` → `/lti/launch`: "Signed in to EducateOS as Terry Teacher (staff), in Earth Science, Tuesday mornings", AGS and NRPS offered. [Screenshot](canvas-lti/01-teacher-launch.png). |
| OIDC launch, student | Passed | From the Canvas assignment page, in Canvas's iframe: "Signed in to EducateOS as Sam Student (student)", opening the deep-linked activity. Before linking, the same launch showed the admin its unlinked `sub`. [Unlinked](canvas-lti/03-student-unlinked-in-canvas.png), [linked](canvas-lti/04-student-launch-in-canvas.png). |
| Deep Linking | Passed, with the placement step noted | `assignment_selection` opens the EducateOS picker in Canvas's "Link Resource from External Tool" dialog ([screenshot](canvas-lti/02-deep-linking-picker-in-canvas.png)). The tool's signed `LtiDeepLinkingResponse` was accepted by Canvas (Canvas request `b3f6a7c6-454e-4a80-a46d-aca81c512241`, nonce checked, `deep_linking_response` rendered), and the tool recorded the activity link `dl-VBelYaspSV0aQrUwfWQr9bI0`. Canvas assignment 2 carries that content item (`educateos_link`), and the student's launch from it resolved to the activity. |
| NRPS | Passed | `POST /api/lti/roster` (cf-ray `a506ccc69ed660ab`): both members, matched to their principals, roles carried as untrusted strings. A teacher was refused (403). |
| AGS line item | Passed | `POST /api/lti/line-items` (cf-ray `a506cd199f1c6164`) created `…/api/lti/courses/2/line_items/3` in the Canvas gradebook. |
| Teacher-approved passback | Passed | Sam's official grade version 1 (5/6, approved by Terry Teacher) published by the teacher (cf-ray `a506cd647a3c9d1c`, `posted`); a retry was `already-posted`; the admin was refused (403), as was a version with no approval (`policy-violation`). Canvas shows 5/6, graded at 04:43:51Z. [Gradebook](canvas-lti/09-canvas-gradebook.png). |
| Replay and spoofing | Passed | With a real Canvas id_token: the genuine launch 200 (`a506d45bbbf0ae77`); its replay 401 "state … already used" (`a506d464adecc4e5`); forged claims under Canvas's signature 401 (`a506d4b80d61111b`); the genuine token in another login 401 "nonce does not match" (`a506d4bd7d18c4e5`); a token signed by an attacker key 401 (`a506d4c15fcf89e0`); `alg: none` 401 (`a506d4c74c6b78af`); no state cookie 401 "did not start in this browser" (`a506d5057a70e814`); an unregistered client 401 at login. |
| Tool key rotation | Passed | `POST /api/lti/tool-keys/rotate` (cf-ray `a506d551baf5eac7`): signing key `pPjF7oHkVP4Chrb8AZL8sn`, `eFTVIHMMT5CnmAGluJ42lJ` retired and still published. Canvas then fetched the tool JWKS and issued a service token for an assertion signed by the new key (Canvas request `73de1e20-4510-4bfc-a184-bb171db64d08`, 200), and NRPS answered (`e02fe8f6-…`, 200). A teacher (403) and a cross-site form post (400) could not rotate. |

## Notes and deviations

- **The registration token.** On this single-domain open-source Canvas, every account resolves to
  the default root account (PlayTrek Dev), and the `registration_token` action fails over to Site
  Admin for any other root account, so it refuses the EducateOS Demo admin. The run minted the same
  token that action mints (same claims and one-hour expiry, the Demo admin as `user_id`,
  `registration_url` the invitation) with a Rails runner, and passed it as the admin UI's iframe
  would. Everything after that was Canvas's own Dynamic Registration. For the same reason the key
  was turned on with Canvas's `Lti::AccountBindingService`, as the account's Apps page does. On a
  multi-domain Canvas (Canvas Cloud) the admin UI does both.
- **Canvas returns no deployment ID at registration** unless its in-development
  `lti_registrations_next` flag is on, and puts one at the top level when it does. PR #132 makes the
  deployment optional at registration and lets the approval supply it.
- **Placing the deep-linked item.** The automation browser could not click inside Canvas's
  cross-origin modal iframe, so the deep linking response was completed in a top-level launch of the
  same placement, which Canvas verified, and the assignment was created through Canvas's assignments
  API with the content item's URL and `custom` parameters, which is what the assignment editor saves
  from the dialog. The student then launched it through the Canvas UI.
- **Canvas instance fix.** Canvas marks its session cookie `SameSite=None; Secure` only under
  `force_ssl`, which this instance (behind cloudflared) had off, so browsers dropped the cookie on a
  tool's cross-site Deep Linking return and Canvas answered with its login page. `production-local.rb`
  now sets `force_ssl` with `redirect: false, hsts: false` (backup: `production-local.rb.pre-scho177`
  on labnuc); see the labnuc runbook.
- **Browser sign-in.** Canvas users of account 3 were signed in with one-time `SessionToken`s
  minted for their own pseudonyms; masquerade is evaluated against the default root account and is
  refused there. Canvas's Access was passed with the email PIN flow as a test identity.
- **Not tested here:** the platform-storage cookie fallback with cookies blocked, `editor_button`
  and `link_selection` placements (Canvas mapped `link_selection` to a resource link launch because
  the registration's resource link message names no placements), course navigation, and NRPS
  paging. The service paging guard is still origin-only.
