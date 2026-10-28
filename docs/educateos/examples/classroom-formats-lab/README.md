# Classroom Assignment Formats Lab

Synthetic customer-demo gadget for SCHO-255. Live saved view:
https://schoolos.gmac.io/workspace/6803f77edf00585d77d65d58c46267e3f09fb0905131571eaf6658e299532c74?w=13

The two course bindings belong to Dana Whitaker's Google account. `SCIENCE` is course
895811762849; `ALGEBRA` is course 896141390025. Assignment IDs are deliberately pinned to the
verified demo fixtures in `server.js`. Replace those IDs and authorize new exact course resources
when adapting the example. Binding authority remains teacher authority; presentation mode does
not make this a student-scoped shared gadget.

Build from the repository root using its installed pnpm dependencies:

```sh
node docs/educateos/examples/classroom-formats-lab/build.mjs /tmp/classroom-formats-lab
```

Copy the output `server.js` and `client.js` into a Workshop gadget through its Code editor,
save the draft, then accept the changes. The build bundles the existing PPTX/ZIP libraries into
one server file; the source package import is not a runtime gadget dependency. Authoring requires
a conversation context; open the saved gadget without `chat=` for the demo. The long SCHO-255
conversation's proposed-code preview produced internal errors, so that recovery path remains open.

Formats:

- Worksheet with live task, success criteria, available rubric and separate response page.
- Live slide deck with previous/next and arrow keys.
- Local practice quiz with accessible radio groups, explanations, reset and an unanswered guard.
  It records no learner responses and performs no Classroom grade passback.
- Discussion agenda, rotating roles, timer controls and expandable teacher notes.

The normal Workshop Export Gadget menu provides a worksheet PDF, deck PDF and real PowerPoint
for each course. Browser PDF uses top-level awaited live fetch and prints all pages. PowerPoint
uses the same live lesson mapping through the bundled renderer. Export references include the
course/work IDs and fetch time. A native Save dialog needs a destination; browsers without the
File System Access API use the platform's blob-download fallback.

Only published, committed coursework is rendered. Draft/pending work is refused before rubric
reads. The server never reads roster or submissions, and projects course/work/rubric fields rather
than returning raw resources. Full collaborator/student authorization acceptance is separate.

Validation on 2026-10-28: both classes' quiz correct/wrong/reset, timer start/pause/reset, teacher
notes, slide controls/keyboard, class switching and saved preferences passed in the real browser.
PowerPoint ZIP CRC and XML checks passed (Science 9 slides, Algebra 7); PDF deck page counts match.
Source boundary scenarios cover published, draft, pending and unknown class. See the verification
runbook for the full evidence and outstanding Classroom/Plus gates.
