# Moodle LTI 1.3 Tool run (labnuc)

- Status: Passed, 2026-10-26 (13:47–14:06 UTC). Not a 1EdTech conformance or certification run.
- Issue: SCHO-240 (follow-up of SCHO-177, umbrella SCHO-198). The second LMS after the
  [Canvas run](canvas-lti.md).
- Tool: the production district Worker, `https://district.schoolos.gmac.io`. Registration,
  approval, the first (unlinked) launch and the identity links ran on deployment
  `0231a83a-fe33-4031-af29-5a12edb8c395` (commit `7a22763`). The Worker moved to
  `1eaf1e7e-bd7b-4950-9393-4fd39fbd869e` (commit `804199b`, PR #135, which added only the
  origin-and-path paging guard) at 13:54:58Z, around the Deep Linking step; the launches of the
  placed activity, the services, replay checks and rotation ran on it. No Tool code changed for
  Moodle.
- Platform: Moodle 4.5.15+ (Build 20261021, `MOODLE_405_STABLE` @ `cae172ee`) on PHP 8.3 at
  `https://moodle.mackie.house`, issuer `https://moodle.mackie.house`, installed for this run on
  labnuc (`/opt/moodle`, `moodle-web.service`, MariaDB 10.11; see the labnuc runbook).

## Setup

| | |
| --- | --- |
| Moodle course | 2, "EducateOS LTI Demo" (`EOS-LTI`); context ID `2` |
| Moodle users | teacher 3 `terry.teacher`, student 4 `sam.student`, local manual accounts |
| Tool | "EducateOS", tool type 1, client ID `x7IjNe4cMM4OBAY`, deployment `1`, created by Dynamic Registration; Deep Linking on, AGS `gradesynchronization=2`, NRPS `memberships=1`, name and email not sent |
| EducateOS offering | `off_7f4d561f-3c9f-43aa-8d5f-6bde0e7614af`, Earth Science, Tuesday mornings (demo co-op district), the same offering the Canvas course maps to |
| Identity links | Moodle `sub` `3` to Terry Teacher, `4` to Sam Student, approved through `/api/admin/identity-requests` |
| Access | Moodle sits behind its own Access app (`8620f2dd-7287-4ca1-a67b-aaa3d53b3c5d`, Canvas's policies). Bypass app `2d5c8a8f-3062-405c-b8cd-dceb377d79ad` covers exactly `/mod/lti/{certs,token,openid-configuration,openid-registration,contentitem_return}.php` and `/mod/lti/services.php/*`, the endpoints the Tool calls server to server plus the Deep Linking return |

## Results

Request IDs are Cloudflare `cf-ray` IDs on the district Worker.

| Service | Result | Evidence |
| --- | --- | --- |
| Dynamic Registration | Passed | The Moodle admin pasted a district invitation into Site administration › Manage tools › "Add LTI Advantage". Moodle opened `/lti/register` with its OpenID configuration and registration token, and the Tool registered and recorded a pending registration (client `x7IjNe4cMM4OBAY`, deployment `1`, product family `moodle`, received 13:47:22Z). Moodle listed the tool as Pending until activated. [Screenshot](moodle-lti/01-registration-pending.png). Unlike current Canvas, Moodle returns the deployment ID at registration. |
| Registration approval | Passed | Refused (409) until the admin trusted the issuer (`a509ea648a5af288`); a teacher could not trust it (403, `a509ea6abc0b15f6`); trusted (`a509ea6f3ab7ab63`) and approved with provider `moodle` and the offering mapping (`a509ea74de27fbcf`). |
| OIDC launch, unlinked | Passed | Terry's first launch, from inside Moodle's dialog, was refused and showed the admin the unlinked `sub` `3`. A teacher could not link it (403, `a509efec1b761d78`). [Screenshot](moodle-lti/02-teacher-unlinked.png). |
| Deep Linking | Passed, with the dialog step noted | "Select content" on a new External tool activity opened the EducateOS picker in Moodle's dialog ([screenshot](moodle-lti/03-deep-linking-picker.png)). Moodle's `contentitem_return.php` verified the Tool's signed `LtiDeepLinkingResponse` ("Successfully fetched tool configuration from the selected content", [screenshot](moodle-lti/04-deep-linking-return-verified.png)) and returned the item: Rock Cycle Investigation, custom `educateos_link=dl-x7oQtPZtkJ260XeQUW-2VMhi`. The activity form was saved through Moodle as course module 2. See the notes on the dialog. |
| OIDC launch, teacher | Passed | The saved activity, in Moodle's frame: "Signed in to EducateOS as Terry Teacher (staff), in Earth Science, Tuesday mornings", the deep-linked activity `act_1b5874cfb9b342d4a113a321e4cedb5a`, AGS and NRPS offered. [Screenshot](moodle-lti/05-teacher-launch.png). |
| OIDC launch, student | Passed | Sam opened the activity from the course page: "Signed in to EducateOS as Sam Student (student)", the same activity. [Screenshot](moodle-lti/06-student-launch.png). |
| NRPS | Passed | `POST /api/lti/roster` (`a509f7c4bce6618a`): both members, `4` and `3`, matched to Sam and Terry, roles carried as untrusted strings (`Learner`, `Instructor`). A teacher was refused (403, `a509f7beabc4a3d4`). Moodle's membership URL is `/mod/lti/services.php/CourseSection/2/bindings/1/memberships`. |
| AGS line item | Passed | Grade route set to `lms:moodle` (`a509f829bde8519e`). `POST /api/lti/line-items` (`a509f978e91109db`) created `…/mod/lti/services.php/2/lineitems/3/lineitem?type_id=1` ("Rock Cycle Check-in (EducateOS official grade)", maximum 3) in the Moodle gradebook. Moodle's line item IDs carry a query string. |
| Teacher-approved passback | Passed | Sam's official grade version 1 (3/3) published by the teacher (`a509f98e9830c176`, `posted`); a retry was `already-posted` (`a509f99229c610d0`); the admin was refused (403, `a509f98928a56185`), as was a version with no approval (`policy-violation`, `a509f98bee6aaac6`). Moodle's grader report shows 3.00. [Gradebook](moodle-lti/07-moodle-gradebook.png). |
| Replay and spoofing | Passed | With genuine Moodle id_tokens (Sam, `kid` `c92e8698202797533243`), following Moodle's own `launch.php` → `/lti/login` → `auth.php` flow: the genuine launch 200 (`a509fcda9835e818`); its replay 401 (`a509fcdcbf981140`), and again with its original state cookie, 401 "state is unknown, expired or already used" (`a509fcdf2a8cec72`); the genuine token in another login 401 "nonce does not match" (`a509fce6ab7b44e4`); `sub` changed to the teacher's under Moodle's signature 401 (`a509fcee590d029d`); `alg: none` 401 (`a509fcf7f96997b9`); a token signed by an attacker key with Moodle's `kid` 401 (`a509fd04dbe971ff`); no state cookie 401 "did not start in this browser" (`a509fd0d286bf2bc`). |
| Tool key rotation | Passed | `POST /api/lti/tool-keys/rotate` (`a509fedcbe4f91e4`): signing key `mFQwDwQCHwr5x9ohYPwXD7`, `pPjF7oHkVP4Chrb8AZL8sn` retired and still published; a teacher could not rotate (403, `a509fed85b2534dc`). Moodle then issued access token 4 at 14:01:55Z, a second after the rotation, for an assertion signed by the new key, and NRPS answered (`a509fee588004563`). Canvas's roster read also still passed after the rotation (`a50a016fdce83e79`). |

The offering's grade route was set back to Canvas afterwards (`a50a0168ac6d329a`).

## Notes and deviations

- **The Deep Linking dialog.** As with Canvas, the automation browser could not click inside Moodle's
  cross-origin "Select content" iframe, though it rendered the picker there. The same request ran
  top level in a second tab of the same Moodle session (`/mod/lti/contentitem.php?id=1&course=2`,
  the URL the dialog loads), where the picker could be clicked, and Moodle's `contentitem_return.php`
  verified the signed response server side. Its verified return data, which Moodle's own script
  hands to the activity form, was passed to that form's `processContentItemReturnData`, and the
  form was saved through Moodle. Nothing was written to Moodle outside its own form.
- **One column per assignment.** The first line item, for "Rock Cycle Investigation", could not be
  bound because that assignment is already bound to its Canvas column; passback refused it as
  unapproved, which is correct. The run used the offering's other assignment, "Rock Cycle Check-in".
  The unbound line item 2 is still in the Moodle gradebook, empty.
- **Moodle sends no name or email** to the Tool (`sendname` and `sendemailaddr` are 0), and the Tool
  never asks for them.
- **Not tested here:** Moodle's platform-side key rotation, NRPS paging (Moodle pages only when the
  Tool sends `limit`), and placements other than the activity chooser.
