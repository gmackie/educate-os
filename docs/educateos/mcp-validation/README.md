# MCP production validation, 2026-11-21

The district MCP server (PRs #443, #444, #447) was validated live on two production districts:

- Northfield (`northfield.educateos.io`), which runs the native LMS-lite.
- Harbor (`harbor.educateos.io`), whose roster and grades come from Google Classroom courses on `gedu.demo.educateos.io`.

All accounts are synthetic. The client was `scripts/demo/mcp-production-demo.ts`, a scripted OAuth client that makes the same calls an MCP client such as Claude Code makes. Sign-in used the `agents.gmac.io` test identities.

| File | What it holds |
| --- | --- |
| `report.html` | The comparison report: native LMS-lite, LMS-lite over Google Classroom, and the Classroom API alone, plus the evidence tables. It is a standalone page, so open it in a browser. |
| `evidence-northfield.jsonl` | Every step as Morgan Lee (Biology I P2), in UTC. Tokens are redacted. |
| `evidence-harbor.jsonl` | Every step as Kwame Asante (Marine Science B1), in UTC. Tokens are redacted. |

## What passed

- **Built-in OAuth 2.1.** Each step worked:
  - discovery (RFC 9728/8414) and dynamic client registration;
  - Access-gated consent, scoped to one class;
  - a PKCE S256 code exchanged for an ES256 access token bound to its delegation;
  - refresh rotation;
  - a refresh replay, which revokes the delegation, after which the live access token gets 403.
- **Reads.** These all worked: profile, my classes (filtered to the delegated class), roster, assignments and gradebook. On Harbor, `get_classroom_grades` returned live Classroom coursework, submission states and grades.
- **Drafts.** `create_module` and `create_quiz` ran immediately.
- **Queued writes.** `create_announcement` and `publish_quiz` queued. The teacher approved them over HTTP, and the students (Lucía Delgado, Nia Fontaine) saw the results.
- **Refusals.**
  - A class outside the delegation answered `not-found`.
  - Admin tools (`create_school`, `get_roster_sync_status`) answered `not-found` for a teacher.
  - Students got 403 at `/oauth/authorize` and on the MCP management API.

## Found and fixed during the run

- **#444:** the district Worker's assets answered `/mcp` and the OAuth metadata with the UI's single-page fallback. `DISTRICT_WORKER_ROUTES` now lists those paths.
- **#447:** the teacher's approval of a queued `publish_quiz` returned 403, because the approved change ran under the client's delegation and `publish` is never delegable. A confirmation now applies under the confirming person's own authority.

## Not covered

- No Claude, ChatGPT or Cursor app has connected yet.
- On Harbor, announcements, quizzes and modules an AI client authors stay in EducateOS and are not posted to Google Classroom.
- Grades go to Classroom only through the passback gate, on coursework EducateOS created.

## Production configuration this relies on

The district runbook covers this: see [production-instance.md](../runbooks/production-instance.md#organization-mcp-endpoint).
