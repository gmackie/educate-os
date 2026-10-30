# Clever partner discussion kit

Prepared 2026-10-29 for the upcoming Clever discussion. Meeting time: **3pm** (Eastern assumed from the local timezone). The calendar date and attendee
mix remain unconfirmed; prepare for both partner staff and engineers. Repository: `git.forgegraf.com/gmackie/educate-os`. Tracking: SCHO-255; Clever access
follow-up: SCHO-211. This kit does not mean the full Google delivery is complete.

Open [the presentation](index.html) locally. It contains a 16-section presentation and a 30-minute full-product path: four-persona district
applications, Google proof, all four lesson formats, a detailed provider comparison, an access
request, and pilot acceptance criteria. A shorter Google-focused path is also included.
Use **Present** and the arrow keys to advance; Escape exits. Print shows every section.

- [Full-system demonstration](full-system-demo.md): exact administrator, teacher, learner and family sequence.
- [Google → Clever explorer](google-clever-bridge.html): 12 responsibilities with evidence boundaries.
- [Presenter runbook](presenter.md): accounts, live sequence, fallbacks, boundaries and rehearsal.
- [Copyable prompts](prompts.md): code-mode, direct gadget and blueprint workflows.
- [Capability and access matrix](capability-matrix.md): Google surface, teaching use and Clever role.
- [Evidence manifest](evidence.json): deployed revisions, historical proof and current blockers.
- [Student companion source](../examples/classroom-student-companion/README.md): personal instances.
- [Teacher Formats Lab source](../examples/classroom-formats-lab/README.md): two synthetic classes.
- [Full verification runbook](../runbooks/classroom-verification.md): detailed historical evidence.

Assets are **synthetic snapshots from 2026-10-28**, not a fresh live provider session. The exported
Science and Algebra PDFs and PowerPoints include their original source references/fetch times.
Screenshot crops omit the Workshop conversation sidebar; the student result is Google's own UI.
Source `.js` files, resource declarations, harness evidence and production health are different
evidence categories. Never describe all declared methods as exercised live.

Build a portable local ZIP (no public upload or message to Clever is performed):

```sh
node docs/educateos/clever-partner-demo/build.mjs /tmp/educateos-clever-demo
```

Run `node --test scripts/teaching-demo.test.ts` for the five student/deck/explorer/inventory checks.
Run `pnpm --filter @educateos/demo exec vitest run` for the native district lifecycle and role tests.

This writes a standalone `index.html`, a runnable `district-demo.html`, the provider explorer,
PDFs/PPTX, detailed notes, source and SHA-256 checksums, plus `/tmp/educateos-clever-demo.zip`.
Open `index.html`; no server is required. The builder also executes the actual compiled district
applications with network requests refused: new reflection submission, teacher comment, official
4/5 approval, feedback release, learner/guardian readback and reset.

Optional Chromium rehearsal (requires the repository's installed Playwright browser):

```sh
node docs/educateos/clever-partner-demo/browser-check.mjs /tmp/educateos-clever-demo/district-demo.html /tmp/educateos-demo-screenshots
```

The district demo runs the real EducateOS apps and service over **in-memory synthetic stores**.
A persona selector supplies identities; it performs no real SSO, Google/Clever connection or AI.
Use Switch persona in the same tab to preserve work. Reset/reload creates a fresh district.
The Google-connected Workshop segment uses different synthetic accounts, clearly labeled.
The ZIP is a meeting kit, not a `.gadget` archive and not an automatically published blueprint.
Publish the reviewed gadget through Workshop's existing blueprint UI, then validate a fresh
student-owned instance. No teacher credentials or workspace share link should be distributed.
