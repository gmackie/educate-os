# Gadget assessment and teacher evidence workflow

This milestone is a local, tested bridge on top of the Assessment SDK MVP. It does not deploy a
district, provide an untrusted-code sandbox, or claim QTI/1EdTech certification.

## Educators

1. Publish and install a class activity with a signed Assessment CI rubric. Before any submission,
   open its assignment in Teacher Studio and find **Gadget assessment**.
2. Obtain a public Workshop assessment JSON export from your configured Workshop using the SDK
   procedure below. Review the Blueprint source and its public instructions. Import it, inspect the
   release commit, and choose **Pin reviewed release to assignment**. The backend requires the
   public rubric reference to match the assignment's verified signed rubric: its ID, integer release
   version represented as `N.0.0`, and signature digest. A pin cannot be replaced on that assignment.
3. Students connect their school accounts and submit their own immutable district artifact revisions
   through the Gadget capability. Workshop approval confirms that submission; it is not teacher
   approval of a score. A changed membership, revoked account, wrong release, or foreign artifact
   causes refusal when the queued submission is applied.
4. In the existing submission review screen, inspect the submitted work, revision/digest, declared
   AI provenance, evaluator findings and cited passages. Run the existing assessment checks, review
   suggestions, and use the existing feedback and grade approval controls. Findings do not become
   official grades automatically. Unmatched excerpts are visibly refused rather than quoted from
   another revision. The screen displays recorded provenance, never invented model reasoning.

An updated or followed Blueprint does not update a class's assessment pin. Install a new assignment
and explicitly review a new export when adopting a new release. Old evidence and reviews remain
attached to the old assignment. Importing a JSON pin checks its structure and assessment digest;
it is a teacher attestation, not cryptographic publisher authentication.

## Gadget and Blueprint developers

Put a strictly valid public SDK `AssessmentDefinition` in `educateos.assessment.json` alongside the
Blueprint's code. This ordinary source file travels through existing publish, `.gadget` export/import,
follow and update mechanisms. Never place student records, answer keys, hidden tests, credentials,
or private evaluator configuration in this file or any other shared Blueprint source.

On a trusted host holding the configured Workshop's `PublicApi`:

```ts
import {
  pinWorkshopAssessmentBlueprint,
  exportWorkshopAssessmentBlueprint,
} from "@educateos/assessment-sdk";

const release = await publicApi.getBlueprintRelease(blueprintId, commitId);
const assessment = await pinWorkshopAssessmentBlueprint(blueprintId, release);
const json = await exportWorkshopAssessmentBlueprint(assessment);
```

`getBlueprintRelease` verifies the actual R2 Git pack and requested commit, enumerates source files,
and hashes sorted path/text pairs with SHA-256. The SDK checks that digest before extracting the
public definition. It never falls forward to the latest release. Missing, corrupt or deleted source
fails closed. Legacy snapshots must be republished as commit-backed releases. Review exports from
the school's configured Workshop: Blueprint IDs alone do not authenticate an origin.

A Gadget with the user-granted `SCHOOL` binding can obtain a capability scoped to one assignment:

```ts
using assessment = await env.SCHOOL.assessment(assignmentId);
const publicView = JSON.parse(await assessment.read());
await assessment.submit([{ artifactId, revisionId }]);
```

Use real immutable artifact/revision IDs previously created through the district artifact service.
The capability accepts no principal, role, class override, release override, model, score or rubric.
It reads the teacher's release pin itself and queues the request in the existing durable action
journal. Reads are observations; writes require the Workshop user's decision and show the exact
assignment/artifact/revision references. Rejected actions never write. Applied action retries use
the journal, while identical current submission revisions reuse AssessmentService's submission.
Dispose the returned RPC stub when finished.

This is a real Gatekeeper RPC path, but it does **not** automatically serialize a running Workshop
Gadget's code or storage into district artifacts, attest which Gadget executable produced evidence,
or add an in-Gadget assignment picker. Those need an authenticated checkpoint/export seam and
explicit content selection. A student must currently create the district artifact through the
existing district workflow. Do not treat the release pin as proof that student code is unchanged.

## Administrators and ownership

The existing `EDUCATEOS_DISTRICT` service binding targets `DistrictSchoolTools`. It alone receives
the principal established by the school account connect flow. The district rereads its persisted
directory, membership and policy on each operation. No client-supplied role becomes authority.
The account principal is reread on each observation and action apply; revocation stops open
capabilities. Assessment methods fail closed if the binding, implementation, or assignment pin is
absent. School-data workspaces continue to refuse collaborators.

The district Durable Object stores assignment pins in SQLite. The first-pin check and ordinary
submission storage are separate transactions: finish configuration before opening submissions;
concurrent ordinary submissions are not transactionally excluded by the setup check. AssessmentService owns submissions,
artifact integrity and grades; AssessmentCi owns execution and report projection. The public SDK
rubric reference must map to the verified local rubric. The public evaluator reference remains
portable authoring metadata; district execution uses the evaluator releases inside that signed
local rubric. This bridge neither installs evaluators nor calls a model. Existing model governance,
hidden-test projections, teacher-only rubric access and human grade approvals stay authoritative.

There is no reverse district-to-Workshop source binding in this milestone. The teacher imports an
export obtained from the verified Workshop API; the district verifies the public definition and
rubric mapping but cannot independently refetch the source commit. An installer-managed origin
binding and publisher verification remain future work. No permission is inferred from a Blueprint,
and no gatekeeper declares itself ambient.

## Validation and maturity

Tests cover actual stored Blueprint packs and archive roundtrips; district installation, pinned
rubrics, owned artifact submission, deterministic CI and teacher review; foreign student/class/
district access; pin tampering; and durable district pins. Workerd separately exercises the actual
Gatekeeper RPC capability, approval queue and account revocation, and the district service binding.
The gatekeeper workerd fixture substitutes the district response; the district suite uses the real
application. These are local harness results, not one deployed browser-to-Workshop-to-district run.

This supports the RFP's teacher control and student vibe-coding goals by allowing student-authored
Gadgets to submit bounded evidence while leaving review and official grading with teachers. It does
not claim execution isolation, anti-cheating attestation, surveillance, automatic AI grading, or
external standards conformance. Existing pilot gates are unchanged; this feature does not turn any
unmet production gate into a met gate.
