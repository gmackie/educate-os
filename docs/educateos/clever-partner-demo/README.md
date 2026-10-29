# Clever partner discussion kit

Prepared 2026-10-29 for the upcoming Clever discussion. Meeting time and attendee mix are not yet
confirmed. Repository: `git.forgegraf.com/gmackie/educate-os`. Tracking: SCHO-255; Clever access
follow-up: SCHO-211. This kit does not mean the full Google delivery is complete.

Open [the presentation](index.html) locally. It contains a 20-minute path, audience questions,
Google proof, all four lesson formats, a precise access request, and pilot acceptance criteria.
Use **Present** and the arrow keys to advance; Escape exits. Print shows every section.

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

Run `node --test scripts/teaching-demo.test.ts` for the documented student/deck/inventory checks.

This writes a standalone `index.html` with embedded images, PDFs/PPTX, detailed notes, source and
SHA-256 checksums, plus `/tmp/educateos-clever-demo.zip`. Open `index.html`; no server is required.
The ZIP is a meeting kit, not a `.gadget` archive and not an automatically published blueprint.
Publish the reviewed gadget through Workshop's existing blueprint UI, then validate a fresh
student-owned instance. No teacher credentials or workspace share link should be distributed.
