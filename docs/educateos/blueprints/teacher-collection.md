# Teacher connector blueprint collection

Tracking: SCHO-336 (Week Ahead), SCHO-337 (Research Kit), SCHO-338 (Assignment Companion).
Gallery presentation follows SCHO-233; live Google acceptance belongs with SCHO-255.

## What ships

| Blueprint | Source | Setup | Boundary |
| --- | --- | --- | --- |
| Week Ahead | One Google Calendar | Select a calendar in the blueprint connection picker | Seven local calendar days, without event descriptions or attendees; no writes |
| Research Kit | Public Web Search | Enable Web Search, then ask the Workshop agent to bind it as `WEB_SEARCH` | Search excerpts and links; no AI summaries or Context collection reads |
| Assignment Companion | One teacher Google Classroom course | Select a course in the blueprint connection picker | Only coursework created through this Google connection; no due dates, roster, submissions or grades |

The collection is bundled by the backend's existing blueprint installer. The catalog names are
**Week Ahead**, **Research Kit** and **Assignment Companion**. The stable IDs are
`educateos.teacher-week-ahead`, `educateos.teacher-research-kit` and
`educateos.teacher-assignment-companion`.

Web Search is an account singleton, not a URL-addressed resource. The current blueprint format omits
singleton bindings when publishing. Research Kit therefore documents an explicit agent-assisted setup
step after every installation; its manifest intentionally declares no fictional resource URL. This is
not a one-click configured installation. The source-unavailable view explains the setup and allows a
retry. A recipient must opt into Web Search under their deployment's policy; code never opts in for them.

Each board stores only teacher-authored preparation notes and checklist items in its own Durable
Object. Changes are saved explicitly; concurrent editors use last-save-wins semantics. Live source
records are not cached. Refresh clears previous results before reading, including when permission is
revoked or the provider fails. The initial preparation read must succeed before editing is enabled.
A save failure preserves unsaved edits for retry.

## Rehearsal

1. Open the blueprint in an installation shipping this collection. Create a copy and use the
   connection picker where offered. For Research Kit, enable Web Search and ask the agent:
   “Bind my Web Search connection to this gadget as WEB_SEARCH.”
2. Choose **Try fictional example**. It reads no account and saves no example records. The banner
   explicitly labels the preview. The screenshots on the public gallery show this mode.
3. Choose **Refresh source**. Week Ahead needs a start date; Research Kit needs specific keywords.
   Compare the selected calendar window or app-owned Classroom work with the original provider.
   Search results are unverified excerpts; review the original linked page before using a source.
4. Add preparation notes and tasks, choose **Save preparation**, then reopen the gadget and confirm
   persistence. Use the browser's print command for the board and notes, or Workshop's
   **Preparation (Markdown)** export for saved notes and tasks only.
5. Publish the blueprint, then install it as a second account. Confirm the new installation has
   empty preparation, its own resource selections, and its own Web Search setup where needed.
   The template copies code, not workspace storage. Do not put private data into source files.
6. Revoke the provider grant, refresh and confirm that previous source cards disappear. Reconnect
   through Workshop and confirm recovery. Also exercise a denied course/calendar, an empty source,
   provider outage and calendar DST boundaries.

Workspace collaboration is separate from blueprint sharing and remains subject to each connector's
observer checks. This collection does not request School records or share a School-bound workspace.
No external writes, emails, schedules or model calls are performed.

## Verification and delivery

Automated tests cover source adaptation against the owning connector declarations, calendar DST and
exclusive all-day ends, draft/pending coursework, missing/denied connections, source-link schemes,
untrusted text rendering, per-installation preparation isolation, failed saves and load protection.
The existing backend suite installs and instantiates every bundled blueprint and checks print/export
support. Run:

```sh
pnpm --filter @gadgets/bundled-blueprints test:run
pnpm exec vp run -F @gadgets/workshop-backend build:bundled-blueprints
pnpm --filter @gadgets/workshop-backend exec vitest run __tests__/bundled-blueprints.test.ts
node --test sites/educateos-io/links.test.mjs
node sites/educateos-io/build.mjs --check
pnpm lint
```

Local rendered checks use the compiled gadget client with a synthetic RPC fixture, not real provider
credentials. They do not prove OAuth, live gatekeeper authorization or second-account installation.
Keep SCHO-336–338 open until production evidence records the exact deployed revision, deployment IDs,
health checks, live provider readback and second-account install results. Gallery copy intentionally
labels live verification as in progress. Remove that qualification only after those checks pass.
