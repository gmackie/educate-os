# Package validation — 2026-10-29

This validates the meeting kit and its source examples. It does not replace the outstanding
production acceptance in SCHO-255 or live Clever conformance in SCHO-211.

| Check | Result |
|---|---|
| `pnpm lint` | PASS: lint, script types, generated/production configuration checks and workspace build; 174/174 tasks successful. Existing warnings remain. |
| `node --test scripts/teaching-demo.test.ts` | PASS: four script checks covering student server boundaries, student client fixture behavior, meeting deck navigation/assets and inventory drift. |
| Google focused Vitest | PASS: 197 tests across classroom-api, classroom-actions, classroom-provider-fake and resources. |
| Existing teacher Formats Lab boundary script | PASS: published projection, draft/pending refusal and unknown-class refusal; no roster/submission reads. |
| Teacher gadget build | PASS: source bundles into standalone Workshop server/client files; existing PPTX library included. |
| PDF inspection | PASS: both worksheets two pages; Science deck nine pages; Algebra deck seven; expected work ID and fetched timestamp in each. |
| PPTX inspection | PASS: ZIP CRC and slide XML; Science nine slides, Algebra seven. |
| HTML previews | PASS: inline report inspected in light/dark desktop and phone widths; Science presentation gallery inspected at 1100px; no console errors after local favicon handling. |
| Portable ZIP | Built locally with SHA-256 file manifest. No external publication or messages. |

The Google tenant preflight exited **2**, because its three preview eligibility probes returned
404. Other preflight checks passed: rubric list and grading-period settings (200), and delegated
student/add-on scope token minting. This is not a blanket green Google/Plus readiness result.

No new OAuth, live student gadget turn-in, Classroom add-on, Clever token probe or real district
roster apply occurred during package preparation. The evidence ledger separates those open cases
from historical Google UI/provider results, automated checks and current deployment metadata.
