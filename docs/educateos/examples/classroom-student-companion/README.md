# Personal Classroom companion

SCHO-255. A reusable gadget that binds **only** `GoogleClassroomStudentSession`, deployed in
Google connector revision `a5f9a104` (includes PR #203). This source is boundary-tested; a live
EducateOS student OAuth/install/approval/turn-in rehearsal is still required. The earlier real
student submission and returned 18/20 were demonstrated in Google's own Classroom browser.

## Install and publish

1. Sign into a **new student-owned EducateOS workspace**, separately from the teacher workspace.
   Connect the enrolled student's Google identity. Reconnect for `classroom.coursework.me` if needed;
   service-account delegation alone does not grant consent to a Workshop OAuth user.
2. Add the Google **Classroom student course** resource using
   `https://classroom.googleapis.com/student-courses/895811762849` for the Science fixture, or
   the numeric ID of another course in which this student is enrolled. Use binding name
   `GOOGLE_CLASSROOM_STUDENT`. Do not connect the teacher resource `/courses/:courseId`.
3. In a new gadget's Code editor, replace `server.js` and `client.js` with these files, save,
   review the proposal, and accept. No bundling, AI model, extra library, storage or credentials
   are required by the gadget. An authoring conversation must be available for proposing code.
4. Refresh. Check the published assignment and own submission against Google Classroom.
   Prepare any answer/attachment in Classroom first. This API cannot upload files, author answers,
   reclaim work, or display returned grades. It can request turn-in of CREATED/reclaimed work.
5. For a synthetic ungraded rehearsal assignment, check the confirmation box, request turn-in,
   inspect the exact assignment in Approvals, approve, and verify Google reports TURNED_IN.
   Reject a separate request and verify no change. Never reclaim the returned 18/20 exemplar merely
   to exercise the button. Repeated turn-in after confirmed TURNED_IN must be refused.
6. Publish the committed gadget through **Publish as blueprint…**. Give the binding the title
   **My enrolled Classroom course** and explain that it must be connected with the learner's own
   Google account. Omit a specific suggested course URL when publishing beyond the demo class.
   Have each student create their **own instance** from the blueprint and bind their own account.
   Blueprint source does not contain credentials, live connections, storage, or chat history.
7. Verify a fresh second student's copy, non-enrolled account denial, collaborator sharing refusal,
   another course's work ID denial, reconnect/revocation, mobile layout and keyboard use before
   describing this blueprint as live-validated or distributing it to a real class.

The teacher's presentation gadget and its workspace must never be offered as a personal student
instance. Its underlying binding can read rosters and grades even if those fields are hidden.
Likewise, Google file ACLs remain independent: a visible material link is not a file-access grant.

## Verification

From the repository root:

```sh
node docs/educateos/examples/classroom-student-companion/boundary-check.mjs
node docs/educateos/examples/classroom-student-companion/client-check.mjs
```

The server test uses only the three real student-interface method names and refuses unexpected
capability reads. It covers projections, unknown/draft work, submission states, rejection,
post-action readback, repeated/reclaimed turn-in and provider revocation. Client tests use an
explicit fixture, not a provider session. Neither test proves live identity isolation; the
connector's own suite and separate-principal live acceptance supply that evidence.

Connection errors clear the previous assignment content. Approval or network failures never show
turn-in as confirmed. Refresh reads Google before another request. Provider links accept HTTPS
without embedded credentials; text is rendered through `textContent`.
