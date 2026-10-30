# EducateOS Launch Factory — video engine

A working, standalone, **internal draft** production engine: import the nine full scripts / 82
shot-list scenes, record isolated synthetic browser fixtures, synthesize speech locally, render
H.264/AAC MP4 with FFmpeg, attach captions, and collect content-bound human reviews. This package
has no publisher, paid API integration, contact database, sender, or deployment command.

The immutable starting scripts and CSV were retrieved from
`gmackie/educate-os`, branch `feat/launch-factory-20261030`, commit
`f66d45d7988a8a2ed76ca763ccfd8974c58ff648`. Their original bytes are preserved under `source/`.
`source/provenance.json` records retrieval; each manifest also fingerprints both source files.
The full prose scripts remain available per video in the manifest; narration uses the matching
CSV `Voiceover` column, with all screen directions, overlays and evidence gates retained.

## Install and make an actual draft

Prerequisites: Node 22+, pnpm 11+, FFmpeg/FFprobe with libx264/AAC and overlay filters, and either
macOS's built-in `say` or Linux `espeak-ng`. No Remotion subscription or text/subtitle FFmpeg filters
are required: permanent overlays are browser-rendered PNGs and captions are a selectable MP4 track.

```sh
cd tools/launch-factory
pnpm install --frozen-lockfile --ignore-workspace
pnpm exec playwright install chromium
# Linux: sudo apt-get install ffmpeg espeak-ng
# Linux first install: pnpm exec playwright install --with-deps chromium
pnpm run lf doctor
pnpm run lf import
pnpm run lf batch --video V01
```

The result is `runs/draft/renders/V01.mp4`, `.srt`, `.vtt`, and a JSON render receipt with the
actual scene timeline, source/media hashes, review states, and measured duration. V01 targets
90 seconds. If speech needs longer, the engine extends the scene; it never speeds up narration
to force the editorial target. The complete nine-video batch can take many minutes and several
GB; rendering is sequential and bounded to two encoding threads per segment.

```sh
# All nine videos, all 82 scenes, real local speech:
pnpm run lf batch
# Fast per-scene one-second previews, explicitly ineligible as final renders:
pnpm run lf batch --video V02 --engine silent --seconds 1
# Or run individual stages / repair one scene:
pnpm run lf capture --scene V01-S01
pnpm run lf narrate --scene V01-S01 --engine local
pnpm run lf render --video V01
pnpm run lf status --video V01
```

`--run PATH` selects an isolated run directory (default `runs/draft`). Paths resolve from the
current directory. Run commands from this package directory. Do not run concurrent writers
against the same run; use a different directory for each operator/CI job. Receipts are atomically
replaced, and incomplete media cannot acquire a matching review. Keep runs on local trusted
storage; hashes detect changed bytes, not an attacker who controls the run directory and rewrites
all receipts. Git ignores runs, private review files, and node_modules.

## What the browser footage proves

**It proves this engine can record a repeatable synthetic storyboard. It does not prove that the
shot-list product behavior exists.** The current bundled adapter performs two harmless preview/
review clicks in a fictional water-quality lesson for each scene. Scene titles and source overlay
copy vary, but these fixtures are intentionally not a reproduction of every requested live UI
workflow. Every scene stays `kind: illustrative`, `verified: false`; every capture says provider
verification `none`. All 82 are draft production slots, not 82 completed feature validations.

The source scripts contain claims about product behavior, live labs, contracts and future support.
They are preserved for editorial review and are **unverified here**. A synthetic Clever/ClassLink
fixture must never be cited as a live provider integration or customer. Existing Canvas/Moodle lab
claims need their own current receipts, scope, date and build. Source prose alone is not evidence.

Every capture contains `SYNTHETIC DISTRICT DEMO` and an illustrative/unverified warning. The renderer
adds its own permanent overlay, even for reviewed scenes: `SYNTHETIC STORYBOARD / NOT ACTUAL PRODUCT FOOTAGE` and `UNVERIFIED CLAIMS · INTERNAL DRAFT`, plus the scene identifier and provider simulation disclaimer. Approval changes
only `UNVERIFIED SCENE` to `REVIEWED ILLUSTRATION`; it cannot remove the warning or upgrade evidence.

Capture uses a fresh nonpersistent browser context per scene, no stored login, no credential input,
no permission grants, no external assets, blocked service workers/downloads/WebSockets, and a strict
request allowlist: GET only, exact origin `https://synthetic.launch-factory.invalid`, generated scene
paths only, no credentials/query/fragment. All allowed documents are fulfilled in memory. Everything
else aborts, including redirects, popups, private IPs and subresources. There is no passthrough
request, external URL option, live Clever/ClassLink connection, real roster or AI chat call.
The browser sandbox is defense in depth, not an OS network firewall: use an egress-denied container
for hostile-input assurance. Do not add arbitrary Playwright scripts or a live-site escape hatch.

## Narration and captions

`--engine local` invokes `say` on macOS or `espeak-ng` on Linux via an argument array, using a local
UTF-8 text file, then normalizes WAV. No shell templates or provider credentials. `--engine silent`
is a deterministic timing draft, clearly recorded in receipts and rejected by review preflight.
Bring an already-produced human or approved TTS recording through the local import hook:

```sh
pnpm run lf narrate --scene V01-S01 --engine import --input /absolute/path/approved-voice.wav
```

Only local WAV is accepted. This command does not call a TTS service. A human must verify that the
recording matches the full script and that voice rights/consent are appropriate. The tool cannot
transcribe or authenticate the speaker. Audio changes invalidate scene approvals.

Captions group words in chunks of 12 and estimate timing proportionally over measured speech duration;
they are **not forced alignment**. Review synchronization, pronunciations, reading speed, line breaks
and accessibility before any use outside internal review. MP4 contains a selectable `mov_text`
English subtitle track; SRT and WebVTT sidecars support editing. These are not burned-in captions.
Short previews deliberately clip narration and are not final videos; full renders retain all speech.

## Human review and fail-closed preflight

Review the recording, speech, captions, exact source claim and `Editorial_and_Evidence_Gate`.
Attach a sanitized Markdown/text/JSON evidence record describing what was actually observed,
the pinned product build if applicable, what remains unsupported, and required wording changes.
Never attach credentials, real student data or raw provider bodies. Review files are private local
records; do not commit them. A review input JSON looks like:

```json
{
  "reviewer": "Named human reviewer",
  "decision": "approved",
  "evidence": "/absolute/path/sanitized-scene-review.md",
  "note": "Approved as an internal illustration only; no product or live provider claim verified.",
  "acknowledgements": {
    "syntheticOnly": true,
    "noLiveProviderClaim": true,
    "noStudentData": true
  }
}
```

```sh
pnpm run lf review --scene V01-S01 --review-file private/review.json
pnpm run lf preflight --video V01 --purpose draft
# After every scene is reviewed, re-render to bind final artifact to current reviews:
pnpm run lf render --video V01
pnpm run lf preflight --video V01 --purpose draft --artifact renders/V01.json
pnpm run lf preflight --video V01 --purpose release --artifact renders/V01.json
```

States are `unverified`, `approved`, `rejected`. Approval binds the source provenance, entire scene,
fixture HTML, recorded video, screenshot, voice text/audio, evidence bytes and acknowledgements.
Changed files, source text, evidence or regenerated media make old approvals stale. Reviewed render
receipts also bind the exact review; a later review decision requires re-rendering. Preview,
missing, incomplete, changed, silent or stale artifacts fail preflight. Draft rendering is allowed
with unverified scenes; **preflight does not silently approve them**.

**Release preflight always exits 2 with `publication-disabled`**, including after every local review.
A local reviewer name is an attestation, not an authenticated approval or permission to publish.
Publication would require a separately reviewed human-authorized boundary and real claim evidence;
this implementation intentionally cannot send, upload or publish anything. `ready` on a draft report
only means its media/review checks passed. `publicationAllowed` is always false.

Exit codes: 0 success (or a status report), 1 execution/input/tool error, 2 preflight not ready.
CLI error output omits raw browser/provider exceptions to avoid leaking URLs/tokens. For recovery,
run `doctor`, inspect the generated preflight codes and per-scene receipts, then recapture/narrate
only affected scenes. A source edit requires `import`, new media and renewed human reviews.

## Tests and CI

```sh
pnpm test
pnpm run test:e2e
# Retain the V01 draft and smoke-test receipts for local inspection:
LAUNCH_FACTORY_E2E_RUN=runs/e2e pnpm run test:e2e
```

Unit tests cover lossless import, RFC4180 edge cases, malformed timing/columns, URL/method
allowlisting, path traversal/symlinks, escaped HTML, captions, CLI boundaries and closed preflight.
The real E2E smoke-checks **all 82 scenes**, captures V01 and renders its full narrated H.264/AAC/caption MP4, exercises
local TTS and WAV import, checks full narration duration, rejects missing safety attestations,
checks approval/rejection and evidence/media tampering, and tests browser network isolation.
Missing browsers/FFmpeg/voice tools fail E2E; there are no silent skips or paid services.

Dedicated `launch-factory.yml` workflows for Forgejo and GitHub install only this standalone locked
package and local tools, run tests, and retain **synthetic internal draft** artifacts for seven days.
They do not deploy or publish. No root workspace, application package, kernel or release config is
changed. Package discovery stays isolated through this directory's own `pnpm-workspace.yaml`.

## Independent launch-operations handoff

`tools/launch-ops/` is a separate tool/branch/PR with no runtime dependency here. Its operator may
reference a video ID, source commit, render SHA-256, local artifact URI and preflight report when
preparing a human review packet. No contacts, campaign state or email templates belong in this
package. The packet must preserve `publicationAllowed: false`; neither a ready CRM draft nor a
local scene approval authorizes distribution of these artifacts.

Future real-product capture must be a separately reviewed synthetic-only adapter with product-build
pinning, deterministic safe seed/reset, read-only navigation, fixture-level data checks and current
claim evidence. It must retain the capture allowlist and visible simulation labels. Add a genuine
external-lab evidence type rather than changing a fixture's `verified` flag. Do not claim the current
storyboard engine performs that product or vendor validation.
