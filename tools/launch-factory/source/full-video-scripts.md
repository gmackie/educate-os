# EducateOS — Full production scripts for V01–V09

**Production draft v1.0 · 30 October 2026 · Nine finished video scripts**

**Read before recording.** The narration in every scene is written to be spoken, not a bullet outline. Scene times are editorial targets, not a requirement to accelerate speech. Record clean narration at a natural pace, then adjust pauses and edit points to match a live capture. Each scene includes specific UI actions, title/overlay text and an evidence gate. Never silently replace a failed live demo with a mockup.

**Demo continuity.** Use one consistent fictional Grade 7 water-quality lesson for the teacher/student stories. Use the synthetic **Northfield** profile for Canvas/OneRoster; **Cedar Valley** for Clever + Classroom *simulation*; **Lakeshore** for ClassLink + Schoology *simulation*; **Prairie** for the small-school/manual-roster storyline. These are fictional teaching/demo districts, **not customers**. The repository's existing fixture names, course names and UI are authoritative: if an invented label does not exist, seed it transparently or change the spoken script. Every demo clip carries the unobtrusive watermark **SYNTHETIC DISTRICT DEMO**; external-lab clips carry **LAB TEST / DATE / VERSION**.

**Claim language.** Tested in a code harness is not the same as tested with a live Clever/ClassLink/OneRoster district; a Canvas/Moodle lab run is not a 1EdTech certification; a prototype installer is not a finished self-service deployment; a proposed foundation/Clever master agreement is not signed. Verify every scene against the current source, test evidence and UI before distribution. See the claim ledger and production checklist at the end of this document.

---

# V01 — A Monday with EducateOS

**Runtime:** 1:30. **Primary viewer:** Teacher, superintendent, initial referral. **Objective:** Elicit “show me the working demo.” **CTA:** Request a 20-minute preview or founding educator conversation. **Location:** Northfield synthetic Grade 7 science class. **Tone:** Warm, purposeful, not futuristic.

### 00:00–00:10 — Familiar Monday morning

**SPOKEN SCRIPT:** “It’s Monday morning. A teacher has a lesson to prepare, students who need her attention, and no time to learn another complicated system.”

**SCREEN / ACTION:** Open directly into a pre-seeded teacher workspace, not a blank chat. Show course title, the coming lesson and the task the teacher needs to prepare. Start with two seconds of natural cursor motion, no stock footage of children.

**ON-SCREEN:** `MONDAY, 7:42 A.M.   •   GRADE 7 SCIENCE` and the persistent `SYNTHETIC DISTRICT DEMO` bug.

**EDIT / EVIDENCE:** A subtle bell-like sound under the first second only; no claim about measured time savings.

### 00:10–00:25 — Curriculum and approved content

**SPOKEN SCRIPT:** “She starts with an approved resource, chooses what students should learn, and builds a water-quality investigation. Students won't see material that hasn't gone through the school's review process.”

**SCREEN / ACTION:** Select sample learning objective → open approved resource with provenance/approval state → create or preview an investigation. Cut out idle time but show the meaningful approval checkpoint; do not morph a draft magically into a published class activity.

**ON-SCREEN:** `APPROVED SOURCE  →  TEACHER-DESIGNED ACTIVITY`.

**EDIT / EVIDENCE:** If current UI requires seeded content rather than an end-to-end creation flow, label this scene `ILLUSTRATIVE FLOW FROM SYNTHETIC FIXTURES`.

### 00:25–00:40 — Student experience

**SPOKEN SCRIPT:** “A student opens the activity, studies the evidence, and works through an answer. Where AI help is enabled, it follows boundaries chosen by the school—not whatever a chatbot decides on its own.”

**SCREEN / ACTION:** Switch to the synthetic student profile and show assignment directions, data table and draft explanation. If an AI conversation is not live on the pinned build, use only the assignment/workspace view and let the sentence about AI play over a clearly labeled policy diagram.

**ON-SCREEN:** `STUDENT WORKSPACE` / `SCHOOL-DEFINED AI ACCESS`.

**EDIT / EVIDENCE:** Use synthetic artifacts only. A policy test alone is not proof that every student chat route is protected end to end.

### 00:40–00:58 — Teacher's final say

**SPOKEN SCRIPT:** “When the assignment comes back, EducateOS can help organize feedback and propose a score. But a suggestion isn't a grade. The teacher reviews, changes, rejects, or approves what becomes official.”

**SCREEN / ACTION:** Teacher submission view → suggested feedback → teacher edits → separate approval control → approved state. Prefer a fresh, repeatable capture; otherwise record the genuine tested service behavior with a `SYNTHETIC TEST` tag.

**ON-SCREEN:** `SUGGESTION ≠ OFFICIAL GRADE`.

**EDIT / EVIDENCE:** Do not show AI autopublishing. Hold two seconds on the human approval.

### 00:58–01:13 — School control

**SPOKEN SCRIPT:** “District leaders set the permissions, manage AI spending, and decide which connections are allowed. The classroom gets useful tools; the school keeps the guardrails.”

**SCREEN / ACTION:** Admin policy or budget view → integration health or configured capability → back to teacher view. Use only actual UI fields demonstrated on this build; an annotated synthetic evidence screenshot is acceptable if labeled.

**ON-SCREEN:** `ADMIN-CONTROLLED PERMISSIONS` / `VISIBLE BUDGETS`.

**EDIT / EVIDENCE:** Never claim FERPA certification or completed accessibility validation from this shot.

### 01:13–01:23 — Ownership, not dependence

**SPOKEN SCRIPT:** “And EducateOS is open source. A school organization can run it in its own cloud account, with its own data and its own operating decisions.”

**SCREEN / ACTION:** Clean diagram: boundary around `SCHOOL CLOUD ACCOUNT` containing runtime/data; separate `OPTIONAL FOUNDATION SUPPORT` outside the boundary. Do not show Clever as a signed foundation partner.

**ON-SCREEN:** `YOUR ACCOUNT. YOUR DATA. YOUR DECISIONS.`

**EDIT / EVIDENCE:** Cloudflare/provider fees still exist; “open source” means no mandatory EducateOS software license.

### 01:23–01:30 — One invitation

**SPOKEN SCRIPT:** “We're inviting educators and technology leaders to shape the first pilots. See what we've built. Tell us what your school really needs.”

**SCREEN / ACTION:** Return to actual lesson thumbnail, then product lockup, short readable URL and QR to one preview-request page. Hold end card at least two seconds.

**ON-SCREEN:** `REQUEST AN EDUCATEOS PREVIEW`.

**EDIT / EVIDENCE:** Do not suggest pilots are already operating with real student data.

**Recording pickups:** Get isolated 3–5-second cursor-free shots of the approved resource, student submission, teacher approval, budget card and ownership graphic for 15/30-second edits. Record two final sentences: `Join the Educator Advisory Council` (teacher channel) and `Request a technical review` (IT channel), but use only one per published cut.

---

# V02 — From standard to classroom activity

**Runtime:** 4:45. **Primary viewer:** Teacher, instructional coach, curriculum director. **Objective:** Prove a coherent pedagogy-first journey from standard to teacher-reviewed result. **CTA:** Join the founding educator design discussions. **Location:** Northfield synthetic science class. **Tone:** Calm screen-share lesson, with pedagogical specifics.

### 00:00–00:25 — The lesson problem

**SPOKEN SCRIPT:** “Imagine you teach seventh-grade science. Tomorrow, students will investigate why a stream’s water quality changed after a storm. You have learning standards to meet, a reading your school has approved, and students who need different kinds of help. Usually those ingredients live in different places. Let's see what it takes to turn them into one useful activity here.”

**SCREEN / ACTION:** Open teacher workspace in the synthetic class. The lesson banner reads `Water Quality: Claims and Evidence`; show objective summary. Never start from an empty generalized agent chat.

**ON-SCREEN:** `GRADE 7 SCIENCE • DEMONSTRATION LESSON`.

**EDIT / EVIDENCE:** Use a genuinely populated sample class. Any standards ID on screen must be verified against the catalog; otherwise show a descriptive learning objective without a code.

### 00:25–00:55 — Instructional goal first

**SPOKEN SCRIPT:** “First I pick the instructional target. Notice the order: we are not asking an AI system to invent our curriculum. The objective comes from the school's selected framework. Here, I want students to compare measurements, make a claim, and explain what evidence supports it. I can then select the resources approved for that goal, with their provenance and version visible.”

**SCREEN / ACTION:** Open curriculum catalog → inspect a standards/competency record → choose an approved resource → pause over source/provenance/version. Use two close-up inserts so the text is readable.

**ON-SCREEN:** `CURRICULUM FIRST` / `SOURCE + VERSION VISIBLE`.

**EDIT / EVIDENCE:** Don't say a specific state agency certified this content or granted blanket reuse rights unless documented.

### 00:55–01:30 — The content checkpoint

**SPOKEN SCRIPT:** “Now say I bring in a worksheet or an article that isn't in the catalog yet. That material should not become trusted classroom content just because I pasted a link. EducateOS has a review step. I inspect the source, check that we're allowed to use it, and decide whether it belongs in this activity. Only the approved release becomes material students can encounter. That checkpoint is part of teaching responsibly with AI.”

**SCREEN / ACTION:** Import a benign sample document → show quarantined/review status → open review → approve an immutable resource version. If capturing separate takes, label crossfade `Time compressed`.

**ON-SCREEN:** `IMPORT → REVIEW → APPROVE`.

**EDIT / EVIDENCE:** A reviewer can still make a bad decision; don't promise the review catches every malicious document or rights problem.

### 01:30–02:05 — Teacher designs the task

**SPOKEN SCRIPT:** “Next I use the investigation template. Students will look at upstream and downstream measurements, identify the strongest evidence, and explain what else they would want to know before reaching a conclusion. I can preview the student instructions and revise the success criteria. If AI suggests language for a rubric, I still choose what counts as strong reasoning. The assignment is mine to teach.”

**SCREEN / ACTION:** Choose science-investigation template → edit title/questions → show a small synthetic measurement table → preview student experience → adjust criteria. If rubric editor isn't live, put `ILLUSTRATIVE RUBRIC PREVIEW` on the insert.

**ON-SCREEN:** `TEACHER-DEFINED TASK` / `PREVIEW THE STUDENT VIEW`.

**EDIT / EVIDENCE:** No blanket claim of accommodations, screen-reader compliance or fully automated standard alignment.

### 02:05–02:40 — Watch a student reason

**SPOKEN SCRIPT:** “Let's switch to a fictional student. They see the task in their own course workspace, not an administrator's screen. They read the measurements, write a claim, and attach the evidence they chose. If the school has enabled AI help for the class, a useful response is one that helps the student think: What pattern do you notice? What measurement might change your conclusion? It should not simply write their answer for them.”

**SCREEN / ACTION:** Sign in as student → open assigned activity → enter a short original response → save a draft and submit. If a tested assistant is available, show one thoughtful question and response; otherwise use static policy explainer over real work view.

**ON-SCREEN:** `STUDENT THINKING REMAINS VISIBLE`.

**EDIT / EVIDENCE:** AI pedagogical quality is a design goal, not a guaranteed outcome.

### 02:40–03:20 — Feedback has an owner

**SPOKEN SCRIPT:** “Back in the teacher account, I can inspect what the student submitted. A feedback draft might call out one strong argument and one gap in the evidence. I can edit that comment, reject a suggestion I disagree with, or decide no score is appropriate yet. If an official grade is going to be recorded, it goes through a distinct teacher decision. This protects teacher judgment without discarding useful assistance.”

**SCREEN / ACTION:** Open submission → inspect possible feedback proposal → manually change a sentence → approve or reject in a separate action. Record a real persisted status. Capture a second version where the teacher chooses `Not ready` or a genuine equivalent.

**ON-SCREEN:** `DRAFT FEEDBACK → HUMAN REVIEW → OFFICIAL DECISION`.

**EDIT / EVIDENCE:** The domain grading gate and the precise current teacher UI must both be checked; don't fabricate button labels.

### 03:20–03:55 — The familiar gradebook

**SPOKEN SCRIPT:** “If the school already uses Canvas, this does not need to be an LMS replacement project. The approved result can use the district's configured LTI connection and appear in the Canvas gradebook. We've exercised that handoff in a real Canvas test environment. Other platforms need their own connector validation; we don't pretend one test automatically covers every LMS.”

**SCREEN / ACTION:** Show genuine Canvas lab launch → approved test grade in EducateOS → resulting Canvas test gradebook. If current lab isn't accessible, use a diagram labeled `Canvas lab-tested Oct 2026`, never a recreated vendor screen shown as live.

**ON-SCREEN:** `CANVAS: TESTED LTI GRADE PASSBACK` / `NO CERTIFICATION CLAIM`.

**EDIT / EVIDENCE:** LMS tool-side LTI Advantage features are externally lab-tested; 1EdTech certification has not been obtained.

### 03:55–04:25 — Same practice, local choices

**SPOKEN SCRIPT:** “A Michigan district, a Texas district, and a small independent school may have very different standards, course structures, and learning platforms. They don't need identical curricula to benefit from the same flow: an approved objective, a trusted resource, an activity students can understand, and a teacher accountable for the result. The technology should adapt to a school's practice—not the other way around.”

**SCREEN / ACTION:** Three synthetic configuration cards for different school types, then return to the shared workflow. Show only configuration features already implemented or clearly annotate as illustrative.

**ON-SCREEN:** `LOCAL CURRICULA • COMMON SAFEGUARDS`.

**EDIT / EVIDENCE:** No real Michigan or Texas district is being portrayed as a customer.

### 04:25–04:45 — Ask for educator critique

**SPOKEN SCRIPT:** “Where would you want one less click? Where should a teacher have more control? And what would make this genuinely useful on a busy Tuesday? We're assembling a founding educator advisory group to answer exactly those questions. We'd love to show you the working demo and hear your objections.”

**SCREEN / ACTION:** End on student preview and teacher edit state. Fade to a single link for educator advisory requests.

**ON-SCREEN:** `HELP DESIGN THE CLASSROOM WORKFLOW`.

**EDIT / EVIDENCE:** Invite advice, not endorsement or purchase commitment.

**Recording pickups:** Capture one no-VO sequence that follows the exact click path from curriculum selection to assignment; an additional take with large cursor/keyboard focus indicators for accessibility feedback; a reject-feedback alternate to prove the teacher can disagree.

---

# V03 — Your district. Your cloud account.

**Runtime:** 5:30. **Primary viewer:** CTO, IT director, privacy/security reviewer, procurement counsel. **Objective:** Earn a technical architecture review. **CTA:** Request a 45-minute security/architecture session. **Location:** District test account and the repo's synthetic harness. **Tone:** Specific, candid, test-oriented.

### 00:00–00:25 — Who owns the system?

**SPOKEN SCRIPT:** “Before we look at an AI feature, let's answer the first technical question: whose system is this? EducateOS is open-source software designed to run in the school organization's own Cloudflare account. The foundation's proposed role is to coordinate shared standards, integrations, and support—not to own the district's student records or decide its instructional policy.”

**SCREEN / ACTION:** Simple trust-boundary diagram. One enclosed district account contains runtime/storage/admins. External IdP/SIS/LMS and proposed foundation broker sit outside. Highlight arrows by data category, not cartoon server icons.

**ON-SCREEN:** `DISTRICT-OWNED ACCOUNT • APACHE-2.0 CODE`.

**EDIT / EVIDENCE:** Show this as the architectural model, not as proof the first district deployment has passed full production acceptance.

### 00:25–01:00 — What the school actually controls

**SPOKEN SCRIPT:** “In a test installation, we can inspect the resources running in that account, the administrators allowed to operate them, and the integrations configured for its identity and courses. The optional foundation control plane should not sit in the middle of an ordinary student's assignment. But every centrally operated connector still needs a defined failure mode, a security owner, and an exit plan. Those details belong in the district agreement.”

**SCREEN / ACTION:** Open demo Cloudflare project with account and token details redacted → highlight the district worker and storage namespace → show simplified request path. If the account is the developer-owned demo tenant, clearly call it `PROJECT-OWNED TEST ACCOUNT`, not a school-owned production account.

**ON-SCREEN:** `OPTIONAL CONTROL PLANE ≠ DISTRICT DATA PATH`.

**EDIT / EVIDENCE:** No assertion that a foundation Clever broker is operational or contracted.

### 01:00–01:35 — Identity is more than email

**SPOKEN SCRIPT:** “School identity gets complicated fast. People change schools. Teachers teach across buildings. Two providers may report different identifiers, and an email address can be reused. EducateOS links a verified provider identity to a principal inside a particular district. The effective key is district, issuer, and subject. Then local authorization determines what that person can access. We want a repeated name in two districts to stay two separate identities.”

**SCREEN / ACTION:** Diagram `(district, issuer, subject) → principal`. Show the synthetic same-name / cross-district fixture and its denied request result; distinguish policy tests from live production boundaries.

**ON-SCREEN:** `DISTRICT + ISSUER + SUBJECT`.

**EDIT / EVIDENCE:** Do not claim unimplemented private-chat API routes passed end-to-end isolation tests.

### 01:35–02:10 — Dangerous roster changes are held

**SPOKEN SCRIPT:** “Now rosters. A bad synchronization should not erase a school's history or treat a broken upstream feed as a mass withdrawal. In the synthetic roster test, an unexpectedly large removal is held for administrator review. It gives staff time to investigate the feed before applying the change. That's the behavior we want whether the source is a CSV, OneRoster service, or an authorized commercial integration.”

**SCREEN / ACTION:** Open synthetic roster import/diff; execute a real test producing `removal-held` → show the exact confirmation step if available. If the console lacks a hold UI, show the test output with `HARNESS TEST` banner instead of constructing a fake console.

**ON-SCREEN:** `LARGE REMOVAL → HUMAN CHECKPOINT`.

**EDIT / EVIDENCE:** As of repo maturity dated Oct 26, Clever full roster permissions were not available live and ClassLink remained provider-fake-tested. Do not show those flows as production.

### 02:10–02:50 — AI budgets and consequential actions

**SPOKEN SCRIPT:** “Governance also has to be operational. The district needs to decide who may use an AI capability, what it can cost, and which actions require a person's approval. In our test paths, spending limits and approval policies are enforced by code rather than left as a paragraph in an acceptable-use policy. But a domain-level test doesn't automatically mean the full administrator interface has passed every acceptance test.”

**SCREEN / ACTION:** Budget configuration; permitted and refused synthetic calls; a teacher-approved grade path. Overlay small labels `CODE TEST` or `LIVE UI` on each clip. Pause on the actual refusal and on the actual approval.

**ON-SCREEN:** `WHO CAN ACT?  HOW MUCH CAN IT SPEND?  WHO APPROVES?`.

**EDIT / EVIDENCE:** G1 synthetic pilot gate still contains open end-to-end criteria; call them out in companion handout.

### 02:50–03:30 — LMS proof and its limits

**SPOKEN SCRIPT:** “We have exercised EducateOS as an LTI 1.3 tool against actual Canvas and Moodle environments. Those lab runs included authenticated launches, course membership reads, Deep Linking responses, and teacher-approved grades passed to the external gradebook. That is meaningful interoperability evidence. It is not formal 1EdTech certification, and it does not mean every vendor combination has completed integration testing.”

**SCREEN / ACTION:** Use real test captures with date/version bug. Show Canvas or Moodle test course launching the tool and the resulting grade change. For Deep Linking, distinguish verified response from an end-user picker interaction if the latter was not captured live.

**ON-SCREEN:** `CANVAS & MOODLE: LIVE LAB TESTS` / `NOT 1EDTECH CERTIFIED`.

**EDIT / EVIDENCE:** Never use a certification emblem or vendor logo as an implied endorsement.

### 03:30–04:10 — Day-two operations

**SPOKEN SCRIPT:** “Then comes day two. Who notices a failed sync? Who rotates credentials? Can we revoke someone's access after a roster change? Who restores a lost environment? Who gets called if a foundation-operated service is down? We have a pilot gate that records the tests we can run and the tests still missing. Accessibility, some production integrations, and a real recovery rehearsal must be settled before a school depends on the full system.”

**SCREEN / ACTION:** Show test/status matrix `MET / OPEN` with source links. Rotate through integration health, logged test result, restore checklist. Do not create a fake 24/7 status page.

**ON-SCREEN:** `OPERATIONAL READINESS IS A TEST, NOT A SLOGAN`.

**EDIT / EVIDENCE:** Show a few real unresolved items, not a misleading green wall of checkmarks.

### 04:10–04:50 — Portability and the foundation boundary

**SPOKEN SCRIPT:** “A school should not have to surrender its data or take on a mandatory EducateOS license to use the software. The foundation model is designed around shared maintenance and optional services, while the school pays its own infrastructure costs. We also need to spell out what happens if a district stops using a foundation-operated connection: which data can be exported, which credentials are revoked, and what continues working locally.”

**SCREEN / ACTION:** Show license file and district-owned infrastructure box. A contract-boundary diagram identifies proposed foundation services and optional support order. If export is not end-to-end validated on current build, display an `EXIT PLAN UNDER VALIDATION` callout.

**ON-SCREEN:** `FREE SOFTWARE LICENSE • DISTRICT CLOUD COSTS • OPTIONAL SERVICES`.

**EDIT / EVIDENCE:** Don't imply Clever has approved the proposed umbrella contract, delegated credentials or foundation pricing.

### 04:50–05:15 — Invite adversarial review

**SPOKEN SCRIPT:** “We welcome the hard questions. Try a stale roster. Rotate a key. Bring an identity collision. Ask us to demonstrate a denied access request, a vendor outage, and an actual restore. What we can't prove yet should become a test plan—not a marketing claim. That's how we want the first districts to help us build a system they can trust.”

**SCREEN / ACTION:** Fast grid of concrete test cases with `PROVEN IN LAB`, `SYNTHETIC TEST`, or `OPEN` labels, one per case. Display link to current maturity matrix.

**ON-SCREEN:** `TEST THE BOUNDARIES WITH US`.

**EDIT / EVIDENCE:** Use a consistent source date and commit reference in a lower-third or end appendix.

### 05:15–05:30 — One technical invitation

**SPOKEN SCRIPT:** “If you lead school technology, we'd like forty-five minutes to show you the code, the running system, and the unfinished gates. Help us decide what truly needs to be ready for the first district pilot.”

**SCREEN / ACTION:** Product lockup and a single technical-review link; visual preview of architecture/evidence packet; no student information requested on the form.

**ON-SCREEN:** `REQUEST A TECHNICAL REVIEW`.

**EDIT / EVIDENCE:** Advisory involvement is not a vendor endorsement.

**Recording pickups:** Redacted cloud resource list; identity-key diagram; roster hold test output; teacher approval in LMS lab; three examples of open pilot gates. Make a 60-second cut from those five shots.

---
# V04 — Fits your existing LMS

**Runtime:** 3:45. **Primary viewer:** LMS administrator, instructional technologist, curriculum director. **Objective:** Prove EducateOS supplements existing LMS without overselling coverage. **CTA:** Book an LMS/interoperability review. **Location:** Real Canvas test course and separately labeled synthetic providers.

### 00:00–00:20 — Defuse the replacement fear

**SPOKEN SCRIPT:** “You already have a learning management system. Teachers know where their courses live, students know where assignments appear, and your district has invested years making it work. EducateOS should fit that environment—not demand that you replace it.”

**SCREEN / ACTION:** Begin in a real Canvas sandbox course. Show EducateOS as an installed external tool within the course. Do not open with an EducateOS admin screen.

**ON-SCREEN:** `KEEP YOUR LMS. ADD CONTROLLED AI WORKFLOWS.`

**EDIT / EVIDENCE:** Label `CANVAS TEST ENVIRONMENT`; it is not an actual district customer's account.

### 00:20–00:45 — Authorized course launch

**SPOKEN SCRIPT:** “Let's start with a teacher launching the tool from Canvas. The launch tells EducateOS which platform and course this request came from. EducateOS validates the signed context and maps it to the district's existing course and person. It doesn't assume a name or email address is enough to grant access.”

**SCREEN / ACTION:** Click a tested Canvas course-navigation placement → show launch → briefly zoom on educator's assigned course. Insert small animation `LTI SIGNED LAUNCH → DISTRICT PRINCIPAL`, not a simulated credential window.

**ON-SCREEN:** `LTI 1.3 LAUNCH • VERIFIED COURSE CONTEXT`.

**EDIT / EVIDENCE:** LTI tool-side launch passed live Canvas/Moodle tests. Capture current repeatable run.

### 00:45–01:15 — Make content available inside Canvas

**SPOKEN SCRIPT:** “Now suppose the teacher has built our water-quality investigation. Instead of sending students to hunt for a separate link, the district can use LTI Deep Linking to associate that activity with its LMS course. The teacher chooses the content, the platform returns a link, and students can encounter the activity in the place they already work.”

**SCREEN / ACTION:** Show activity picker/configuration in EducateOS → capture the verified Deep Linking response, then show the resulting test assignment placed through the documented Canvas lab method. Label `RETURN RESPONSE VERIFIED; PLACEMENT CAPTURED VIA LAB API` if the interactive picker could not be clicked end-to-end.

**ON-SCREEN:** `SELECT ACTIVITY → RETURN COURSE LINK`.

**EDIT / EVIDENCE:** Oct 26 evidence did not include successful automated clicking inside Canvas Deep Linking dialog; do not edit separate takes into a fake single seamless click.

### 01:15–01:45 — Student works; teacher reviews

**SPOKEN SCRIPT:** “The student opens the linked activity in its course context and submits work. The teacher can review it within EducateOS, use whatever feedback assistance is enabled, and approve the consequential result. That review step is important: the AI's proposal is not automatically the score that travels into the school record.”

**SCREEN / ACTION:** Use synthetic student and teacher test accounts. Show actual essay submission → feedback/review → teacher approval. If LMS lab accounts differ from seeded district personas, use a clearly labeled cut rather than implying it's one session.

**ON-SCREEN:** `TEACHER REVIEW BEFORE OFFICIAL PASSBACK`.

**EDIT / EVIDENCE:** No implied direct AI grading without human approval.

### 01:45–02:20 — Close the gradebook loop

**SPOKEN SCRIPT:** “Here's the part an LMS administrator wants to see. After the teacher approves a grade and the district has configured Canvas as the authority for that course, EducateOS uses the LTI Assignment and Grade Services connection. In our live lab, the result made it into the Canvas gradebook. We also tested the underlying LTI Advantage service path with Moodle. That's a real integration milestone, with a defined test scope.”

**SCREEN / ACTION:** Split-screen test approval and resulting gradebook entry with controlled time match. Brief overlay of `AGS` and `NRPS` as service labels, not broad product badges. Show a lab request ID or source evidence link at bottom for technical audiences.

**ON-SCREEN:** `TEACHER-APPROVED GRADE → CANVAS GRADEBOOK` / `LAB TEST: OCT 2026`.

**EDIT / EVIDENCE:** No formal 1EdTech certification; don't extrapolate to all Canvas tenants or Schoology.

### 02:20–02:55 — Explain the other connectors accurately

**SPOKEN SCRIPT:** “Not every school uses Canvas. The architecture also includes a Schoology-oriented LTI configuration and separate Google Classroom API work. Google Classroom isn't simply another standard LTI launch. We've exercised a small live Classroom coursework-and-grade flow, but not a district-wide production roster. Clever and ClassLink have separate identity and rostering paths, which still need fuller live validation.”

**SCREEN / ACTION:** Four labeled panels: `Canvas – live lab`, `Moodle – live lab`, `Google Classroom – limited one-course live smoke test`, `Clever/ClassLink – synthetic integration tests`. Present capabilities separately; no generic green checks.

**ON-SCREEN:** `DIFFERENT PROVIDERS • DIFFERENT VALIDATION LEVELS`.

**EDIT / EVIDENCE:** The Schoology-flavored test platform is synthetic; no verified live Schoology claim without new evidence.

### 02:55–03:25 — Clarify system of record

**SPOKEN SCRIPT:** “The key district decision is authority. Which system owns enrollment? Which one is allowed to issue an official grade? Does a student sign in through Google, Clever, ClassLink, or a district identity provider? EducateOS treats those as separate configuration questions. That's deliberate, because one school can have several of these products at the same time.”

**SCREEN / ACTION:** Show editable or diagrammed matrix `Identity / Roster / Course / Grade of record` for one fictional school, with actual configured example values. Animate arrows individually; avoid showing passwords and OAuth client secrets.

**ON-SCREEN:** `IDENTITY ≠ ROSTER ≠ LMS ≠ GRADE AUTHORITY`.

**EDIT / EVIDENCE:** This is an architectural separation, not evidence every provider combination is supported in production.

### 03:25–03:45 — Invite the integration administrator

**SPOKEN SCRIPT:** “If you're responsible for Canvas, Schoology, Google Classroom, or the district roster, we'd like to review your current workflow with you. Bring the configuration you actually use. We'll show the tested path, identify the gaps, and decide whether EducateOS fits without disrupting your teachers.”

**SCREEN / ACTION:** Show the integration matrix with one row per platform, then end on `Request an interoperability review` and a simple vendor-neutral workflow diagram.

**ON-SCREEN:** `REQUEST AN LMS & ROSTERING REVIEW`.

**EDIT / EVIDENCE:** Technical discussion only, not a request for production student credentials or data.

**Recording pickups:** Capture clean Canvas launch and gradebook proof independently; capture one calm explainer animation for NRPS/AGS; create four 20-second platform-specific cutdowns with the correct maturity label.

---

# V05 — What AI is allowed to do

**Runtime:** 2:45. **Primary viewer:** Principals, privacy officers, school boards, student-safety reviewers. **Objective:** Show concrete governance boundaries without promising perfect safety. **CTA:** Request a responsible-AI policy demonstration. **Location:** Synthetic student/teacher/admin roles and test-evidence screen.

### 00:00–00:20 — Lead with the uncomfortable question

**SPOKEN SCRIPT:** “A school shouldn't have to choose between useful AI and control over student work. The important question isn't only what an AI model can generate. It's what the system lets it see, what it's allowed to change, and who can intervene when something goes wrong.”

**SCREEN / ACTION:** Start on a student's sample assignment; zoom out to a simple permission boundary between student, teacher, administrator and assistant. Avoid ominous stock images of students under surveillance.

**ON-SCREEN:** `WHO CAN SEE?  WHO CAN ACT?  WHO CAN OVERRIDE?`.

**EDIT / EVIDENCE:** Do not claim the software makes all model outputs safe or correct.

### 00:20–00:45 — Roles and boundaries

**SPOKEN SCRIPT:** “Take two students in the same class. They may see the same instructions, but that doesn't give one student permission to open the other's private draft. A teacher should see assigned work that needs review—not a blanket window into everything a student thinks or types. Access follows the verified person and the task they're authorized to perform.”

**SCREEN / ACTION:** Show synthetic requests for class activity and another student's artifact. Capture a tested API refusal for the artifact. If private AI chat protection is shown, label it `POLICY-LEVEL TEST ONLY` unless the specific live route has since passed.

**ON-SCREEN:** `CLASS ACCESS IS NOT PRIVATE-WORK ACCESS`.

**EDIT / EVIDENCE:** The October pilot gate still marks private-chat API route coverage incomplete; don't show it as production-proven.

### 00:45–01:15 — An agent can't make a secret grade decision

**SPOKEN SCRIPT:** “Now imagine an AI assistant suggests a score or feedback. That recommendation may help a teacher, but it does not grant the assistant authority to publish an official grade. In the tested assessment path, consequential grade writes are separated from the proposal and routed through teacher approval. The point is accountability: a person owns the educational decision.”

**SCREEN / ACTION:** Synthetic grading flow with a proposed score → teacher changes it → official-grade approval. If only domain test path exists, label `ASSESSMENT SERVICE TEST` and avoid manufacturing a teacher console interaction.

**ON-SCREEN:** `PROPOSED SCORE ≠ APPROVED GRADE`.

**EDIT / EVIDENCE:** Some end-to-end pilot grade-gate routes remain open; be precise about tested layer.

### 01:15–01:45 — Spending and scoped capabilities

**SPOKEN SCRIPT:** “Permissions also include money and capabilities. A school may decide which classes receive a particular AI tool, what its budget is, and how it should behave when that budget is exhausted. EducateOS is being built so these choices are enforceable and visible to the people responsible for them—not buried in a vendor setting nobody checks.”

**SCREEN / ACTION:** Show synthetic course budget and test a budget-denied AI request. Then show policy revision/approval only if the user-facing path is working; otherwise display `tested policy service` overlay.

**ON-SCREEN:** `SCOPE IT • LIMIT IT • AUDIT THE DECISION`.

**EDIT / EVIDENCE:** Cost figures shown are demo seeds, not district estimates or guaranteed billing limits across all providers.

### 01:45–02:15 — Response when something fails

**SPOKEN SCRIPT:** “Governance also means admitting that systems fail. A provider might be unavailable, a roster might be wrong, or an imported document might contain instructions it should never have carried. The right behavior is to surface the problem, preserve an audit trail where appropriate, and stop unsafe changes until a person can review them. That is the standard we want schools to test with us.”

**SCREEN / ACTION:** Sequence: provider health error from synthetic harness → held large roster removal → imported-resource review flag. Do not add a fictitious safety incident or show real student discussions as training fodder.

**ON-SCREEN:** `HOLD • REVIEW • RECOVER`.

**EDIT / EVIDENCE:** Hall Monitor deployment and exact incident workflows need separate product evidence; do not imply comprehensive student surveillance.

### 02:15–02:45 — Honest safety conclusion

**SPOKEN SCRIPT:** “No responsible vendor should ask a district to accept a promise of perfect AI safety. We can show the boundaries we've tested, the gaps still on the pilot checklist, and the choices each school controls. We're inviting school leaders to challenge those assumptions in a supervised demo, before any real student records enter the picture.”

**SCREEN / ACTION:** Short evidence ledger: `Verified lab / Synthetic test / Open gate`. Finish with one CTA and a very small privacy/safety FAQ link on the landing page, not a second on-video CTA.

**ON-SCREEN:** `REQUEST A RESPONSIBLE-AI DEMO`.

**EDIT / EVIDENCE:** No 'FERPA certified', 'COPPA certified', 'zero risk', or blanket zero-retention claim.

**Recording pickups:** A clear denial state, a grade approval state, a budget-exhaustion result, and a resource quarantine state. Keep each as a modular 6–10-second clip for board presentations.

---

# V06 — Small school, small IT burden

**Runtime:** 2:15. **Primary viewer:** Private-school head, charter operator, small-school technology coordinator. **Objective:** Make the standalone deployment path approachable without hiding ongoing work. **CTA:** Request a small-school walkthrough. **Location:** Synthetic Prairie Co-op with local accounts/manual rosters; optional Harbor Google Workspace variant.

### 00:00–00:20 — Acknowledge the tiny team

**SPOKEN SCRIPT:** “If you're running technology for a small school, you probably don't have a department for every system. You may be the person managing Chromebooks, accounts, the gradebook, classroom apps—and the Wi-Fi. A new tool that arrives with six integration projects isn't helping.”

**SCREEN / ACTION:** Start with a fictional school administrator dashboard and an unobtrusive line `One technology coordinator. Many jobs.` No stock images of overworked children or teachers.

**ON-SCREEN:** `BUILT WITH SMALL SCHOOL TEAMS IN MIND`.

**EDIT / EVIDENCE:** No claim of fully automated no-code install unless the path passes a fresh-account test.

### 00:20–00:50 — The simplest school profile

**SPOKEN SCRIPT:** “In our synthetic small-school example, there is no expensive SIS contract to integrate. The school can start with a local directory or a roster it controls, define a few classes, and decide where official grades will live. It doesn't need to buy Clever just to try the EducateOS classroom model. If the school already runs Google Workspace, that's another configuration we can evaluate.”

**SCREEN / ACTION:** Show Prairie synthetic school selection; local/manual roster with synthetic names; one class and configured grade authority. Optional cut to Harbor Google profile explicitly labeled as a separate test scenario.

**ON-SCREEN:** `LOCAL ROSTER OPTION • OPTIONAL PROVIDER CONNECTIONS`.

**EDIT / EVIDENCE:** Manual roster sync and local auth behavior must be freshly checked in running UI; never imply every small school can avoid paid infra.

### 00:50–01:20 — Walk through intended setup

**SPOKEN SCRIPT:** “A school administrator would choose its cloud account, confirm its domain, select a sign-in method, and review the initial permissions. Then it connects—or imports—the class directory and establishes an AI budget. We want that to be a guided process with understandable warnings. Where a step still needs engineering or vendor approval, it should say so rather than send someone into a maze.”

**SCREEN / ACTION:** Guided installer or setup preview. For unvalidated steps, use explanatory cards labeled `INSTALLER PREVIEW`, not a seamless fake install. Show permission preview, domain, roster, budget in sequence; avoid untested `one-click` language.

**ON-SCREEN:** `ACCOUNT → IDENTITY → ROSTER → BUDGET → CHECKS`.

**EDIT / EVIDENCE:** Current code includes guided-install work but production self-service acceptance is not finished.

### 01:20–01:45 — A normal school day

**SPOKEN SCRIPT:** “After setup, the teacher shouldn't become a cloud operator. They open their class, choose an approved resource, and teach. The school maintains the account and its policies. If it needs someone to handle initial configuration, training, or a difficult integration, those services can be purchased separately rather than being bundled into a mandatory software subscription.”

**SCREEN / ACTION:** Teacher lesson creation → student view → compact cost/ownership card. Only show actual optional-services offering as a proposal; don't show a fictitious checkout receipt.

**ON-SCREEN:** `FREE OPEN-SOURCE SOFTWARE • OPTIONAL HELP`.

**EDIT / EVIDENCE:** District/provider usage charges and operational responsibility remain. Exact optional support pricing is proposed, not published contract pricing.

### 01:45–02:15 — Invite a right-sized pilot

**SPOKEN SCRIPT:** “The result we're aiming for is simple: a small school can make its own decisions without hiring a cloud engineering team for every change. We still need small-school administrators to pressure-test the setup and the support plan. If that's your world, we'd love to walk through it together and find out where it feels too complicated.”

**SCREEN / ACTION:** Show one-page `small-school deployment checklist` and one preview-request URL. End on the actual synthetic school home.

**ON-SCREEN:** `SMALL-SCHOOL DESIGN PARTNERS WANTED`.

**EDIT / EVIDENCE:** Never promise a self-hosted system needs zero maintenance.

**Recording pickups:** Record a 45-second version for diocesan school offices and independent-school associations, replacing technical phrases with a single 'what the school owns' visual.

---
# V07 — The foundation model in plain English

**Runtime:** 1:30 (allow 5–10 seconds editorial flexibility). **Primary viewer:** Superintendent, board member, CFO, foundation/diocesan leader. **Objective:** Explain who owns the software, who pays for what, and why the proposed foundation exists. **CTA:** Request a governance and funding briefing. **Location:** Clean, vendor-neutral diagrams; no invented invoices or signed partner badges.

### 00:00–00:15 — The ownership question

**SPOKEN SCRIPT:** “Most school software works the same way: you subscribe, use someone else's system, and hope the product keeps serving your school. EducateOS begins with a different assumption: the school should be able to own and operate its own instance.”

**SCREEN / ACTION:** Side-by-side: `Conventional hosted app` (school arrows into vendor tenant) versus `District-owned EducateOS` (school boundary around runtime and data). No specific competitor logo.

**ON-SCREEN:** `THE SOFTWARE RUNS IN YOUR SCHOOL'S ACCOUNT`.

**EDIT / EVIDENCE:** No assertion that a vendor literally owns student records under every SaaS agreement; focus on hosting/control model.

### 00:15–00:35 — What the school gets

**SPOKEN SCRIPT:** “The EducateOS code is open source. A district or independent school can deploy it in an account it controls, make local policy choices, and keep the student data under its own administration. The school still pays its cloud, AI, and any outside provider costs. Open source does not mean running technology is free.”

**SCREEN / ACTION:** Show `Open-source license: $0` card, then a distinct `District cloud and AI usage: district pays provider` card. Use unpriced arrows rather than invented monthly estimates.

**ON-SCREEN:** `NO MANDATORY EDUCATEOS SOFTWARE LICENSE`.

**EDIT / EVIDENCE:** District-owned Cloudflare costs may be variable; do not imply all third-party integrations are free.

### 00:35–00:55 — What the foundation coordinates

**SPOKEN SCRIPT:** “The proposed EducateOS Foundation would help maintain shared software, interoperability standards, releases, documentation, and relationships with providers. Instead of every district reinventing the same integrations, participating schools could benefit from shared coordination while retaining control of their own deployment.”

**SCREEN / ACTION:** Draw foundation as a ring around shared engineering, knowledge base, integration review, and policy templates; district installations remain separate. Lines are support or authorization, not centralized student-data pipelines.

**ON-SCREEN:** `SHARED STEWARDSHIP • INDEPENDENT DEPLOYMENTS`.

**EDIT / EVIDENCE:** Foundation legal status and agreements are proposed, not finalized.

### 00:55–01:15 — Costs and Clever caveat

**SPOKEN SCRIPT:** “A school could choose optional setup, training, or support services under a separate agreement. Shared integration costs need sustainable funding. In particular, a proposed umbrella Clever partnership still requires Clever's written approval, both for independently hosted schools and for how those costs would be covered.”

**SCREEN / ACTION:** Three non-overlapping columns: `Free code`, `District provider usage`, `Optional human services`; footer box `Clever master partnership: negotiation required`. Don't label a fee 'Clever surcharge'.

**ON-SCREEN:** `CLEVER AGREEMENT: PROPOSED, NOT EXECUTED`.

**EDIT / EVIDENCE:** No claim of nonprofit tax-exempt approval, Clever certification, or vendor-specific fee authority.

### 01:15–01:30 — Leadership invitation

**SPOKEN SCRIPT:** “We're asking school leaders to help make that model practical and sustainable. If district control and shared public-interest infrastructure sound worth exploring, we'd welcome a governance and funding conversation.”

**SCREEN / ACTION:** End on district-owned diagram with a single board/foundation briefing URL; no overlapping CTA to buy or donate.

**ON-SCREEN:** `DISCUSS THE FOUNDATION MODEL`.

**EDIT / EVIDENCE:** Explicitly distinguish participation interest from committed funding.

**Recording pickups:** A silent cost-flow animation, independent account diagram, and 15-second vertical version emphasizing `No license fee / Your costs / Optional support / Contract still under negotiation`.

---

# V08 — Complete product tour with anticipated Q&A

**Runtime:** 15:30. **Primary viewer:** Design partners, curriculum and IT leadership together, foundation advisers. **Objective:** Earn structured co-design and a scoped, authorized sandbox evaluation. **CTA:** Join a guided evaluation session. **Format:** Presenter-led recorded demo with on-screen *anticipated questions*; not a fabricated customer interview. **Location:** Northfield synthetic class, actual tested integrations, documented test outputs.

### 00:00–00:50 — Welcome and the two questions

**PRESENTER SCRIPT:** “Welcome to EducateOS. This is a full demonstration of a platform we're building so schools can use powerful AI without losing control of their curriculum, students' records, or infrastructure. We're going to follow one lesson through a teacher's day, switch to a student, look at what an administrator can control, then step into the technology underneath. I'll also answer the questions educators and CTOs tend to ask first. Everything you see is from a test environment; where we use synthetic providers or a lab integration, I'll call that out. Our goal isn't to convince you that the pilot work is finished. It's to show what's real, and invite you to help shape what comes next.”

**SCREEN / ACTION:** Title slate with `Recorded demo • October 2026 release under review`; show agenda with five tiles: Teacher, Student, Admin, Infrastructure, Q&A. Open synthetic course and keep a small banner `SYNTHETIC DISTRICT DEMO`.

**ON-SCREEN:** `A COMPLETE CLASSROOM STORY + A TECHNICAL REVIEW`.

**EDIT / EVIDENCE:** Record source commit/date in internal end slate. Remove any phrase suggesting councils or real schools are already participating.

### 00:50–01:35 — The six example school configurations

**PRESENTER SCRIPT:** “Schools rarely arrive with the same technology stack. Our synthetic test environments reflect that. One public-school example uses OneRoster and Canvas. Another uses Clever identities and Google Classroom. Another uses a ClassLink-style roster and Schoology-style LTI service. A small-school example starts with a local directory rather than a big SIS. Those are separate test scenarios, not four customer deployments. The reason for them is simple: sign-in, the roster, coursework, and the official gradebook are different choices. EducateOS shouldn't hard-code a single vendor into all four decisions.”

**SCREEN / ACTION:** Show four rows from actual fixture profiles: Northfield, Cedar Valley, Lakeshore and Prairie. Add status chips: `Real Canvas lab exists`, `Clever fake`, `ClassLink fake`, `Local fixture`. Highlight that vendor-fake test is not a contractual integration.

**ON-SCREEN:** `IDENTITY / ROSTER / COURSE / GRADE OF RECORD`.

**EDIT / EVIDENCE:** Do not call these organizations deployed Michigan/Texas school districts.

### 01:35–02:30 — Teacher starts with curriculum

**PRESENTER SCRIPT:** “Let's use our seventh-grade science class. The teacher's goal is to help students explain why measurements from a stream changed after a heavy storm. The important thing is what comes first. We start with the learning objective, not a blank chatbot prompt. The catalog contains structured curriculum frameworks and resources, and the district decides what is approved and appropriate. Here I select the objective about evidence-based environmental reasoning, inspect the source, and choose the material students will work from. If the teacher changes this activity next year, we want to know which version of the material was actually used. That makes the workflow reviewable and more useful than an anonymous generated worksheet.”

**SCREEN / ACTION:** Teacher home → course → curriculum catalog → competency → approved resource metadata. Hover on `approved`/release/provenance as available. Show actual data. Do not scroll at narration speed; two slow zooms for readers.

**ON-SCREEN:** `LEARNING GOAL BEFORE AI PROMPT`.

**EDIT / EVIDENCE:** Specific learning standard codes shown only when checked against the catalog; no assertion that all state frameworks are licensed for every use.

### 02:30–03:30 — Content Studio and approval

**PRESENTER SCRIPT:** “Teachers also need a way to use something beyond the catalog. Let's imagine I found a short reading that I have permission to share. The intuitive approach would be paste the link, press Generate, and hope. But a web page can change. A PDF can contain misleading instructions. Rights can differ. So this material enters a review flow. The teacher—or whoever the school has designated—looks at it, verifies that it belongs in the class and that the reuse conditions make sense, and publishes an approved version. The version can then be referenced by activities without silently changing when the source website does. Notice the separation here: the assistant may help organize content, but content isn't allowed to turn itself into trusted school policy. The reviewer decides.”

**SCREEN / ACTION:** Import a benign fixture PDF/URL → visible quarantine → open review → change/reject/approve action → immutable release record. If taking multiple recording passes, show `Elapsed time condensed` marker. Then show an intentionally suspicious source flagged in a TEST ONLY window without exposing attack details to students.

**ON-SCREEN:** `UNTRUSTED INPUT → REVIEW QUEUE → APPROVED VERSION`.

**EDIT / EVIDENCE:** Do not claim the review solves every prompt-injection, copyright or content accuracy problem; no '100% safe' language.

### 03:30–04:30 — Build and preview the activity

**PRESENTER SCRIPT:** “Now we'll make the actual activity. Students will compare upstream and downstream measurements, choose the best evidence for a claim, and say what additional information would help them be more confident. Here is the investigation template. The teacher can work with a structured task rather than starting a new document from scratch. I choose the approved resource, fill in the question, and define what a good response should demonstrate. I can inspect the student preview and adjust the instructions if they're confusing. That is the value I want teachers to react to: fewer moving parts in the workflow, and clearer boundaries between classroom content and the AI assistant. We aren't measuring time saved yet; that is exactly what a real pilot needs to test.”

**SCREEN / ACTION:** Curriculum activity builder → source selection → questions/rubric → student preview. Demonstrate actual edits live. If a UI form doesn't expose rubric controls, use test evidence with `ILLUSTRATIVE CONFIGURATION` callout and state it as such on screen.

**ON-SCREEN:** `TEACHER CREATES • TEACHER PREVIEWS • TEACHER PUBLISHES`.

**EDIT / EVIDENCE:** Do not claim the entire UI has passed the accessibility gate until a current audit is complete.

### 04:30–05:25 — Switch to student view

**PRESENTER SCRIPT:** “Let's sign in as a fictional student. This is a different role and a different view of the same course. The student can read the task, explore the provided evidence, write their explanation, and submit it. The personal workspace should remain separate from other students' private work. If AI assistance is enabled, the educator can design help around reasoning rather than answer generation: ask which measurement supports a claim, prompt the student to check an assumption, or help organize their own ideas. We'll show an example interaction from the test environment, and I'll be explicit that evaluating pedagogical quality and the full access boundaries is part of the pilot program, not something any demonstration can certify.”

**SCREEN / ACTION:** Log in with synthetic student account → activity → data → draft response → optionally tested AI prompt and reply → submit. Never show student real names or account emails. Pause 3 seconds on the final student's original explanation.

**ON-SCREEN:** `STUDENT WORK • OWN CLASS CONTEXT`.

**EDIT / EVIDENCE:** Don't pretend artificial guidance guarantees correct or age-appropriate answers. Label scene if AI response generated from fixture.

### 05:25–06:20 — The teacher's review

**PRESENTER SCRIPT:** “Now the teacher sees a submission, not a secret window into the student's whole life. We can inspect the writing, the evidence, and any suggested feedback. Suppose the model says the student made a strong inference but missed a contradictory measurement. That's useful only if the teacher can challenge it. Here I change the wording. I can reject a suggestion that doesn't fit the lesson. If a score is appropriate, the assessment path distinguishes a proposal from an official grade. The decision to publish belongs to the authorized teacher. We tested this principle at the service level and in the LMS lab; for a school pilot we also need the complete user-facing sequence to pass acceptance tests. That is how we keep the demo honest.”

**SCREEN / ACTION:** Teacher submission list → specific work → proposed comment → edit → explicit approval → official state. Inset `Service test / Live UI` status for the source of each clip. Capture persistence with refresh if feasible.

**ON-SCREEN:** `THE TEACHER OWNS THE DECISION`.

**EDIT / EVIDENCE:** Do not imply educators have unlimited visibility of personal student AI chats; relevant API work was still on open gate.

### 06:20–07:15 — Administrator sets boundaries

**PRESENTER SCRIPT:** “Now let's change hats and become the district administrator. Schools need more than a list of toggles. They need to know what each capability gives a student or staff member access to, which classes are included, and how spending is tracked. In the synthetic environment we can inspect configured capabilities, usage budgets, and approval paths. Watch what happens when a request exceeds a test budget: it is refused instead of quietly increasing the bill. That's the intended control behavior. The team still has additional integration and user-interface tests to pass before real districts depend on it, and those tests are recorded in the public pilot gate.”

**SCREEN / ACTION:** Admin capability list → class scope → synthetic budget → make controlled request that should fail → show refusal in test interface. Briefly show revisions/rollback if current UI supports it; otherwise cover in technical architecture segment.

**ON-SCREEN:** `ADMINISTRATOR SETS SCOPE + BUDGET`.

**EDIT / EVIDENCE:** Demo budget figures are not forecasted school costs; show units and test-only badge.

### 07:15–08:10 — Identity and roster integrations

**PRESENTER SCRIPT:** “School integration has a lot of edge cases that disappear in glossy demos. We separate identity from enrollment. A user can arrive through an identity provider, but their role and class membership still need to be checked against the district's authoritative directory. A student who drops a class shouldn't keep the same access forever, and a bad feed shouldn't erase their history. Here is the test that holds a large, unexpected roster removal until an administrator investigates. We have synthetic test providers for Clever, ClassLink, OneRoster and Classroom flows. Those are useful for engineering, but they are not all live production integrations. We would choose the real district's sources during the technical evaluation.”

**SCREEN / ACTION:** Graph `identity → principal / roster → enrollment` → synthetic roster preview → held removal result. Show labels against provider matrix; no unsupported Clever or ClassLink account screenshots.

**ON-SCREEN:** `SSO IS NOT THE ROSTER • TEST SOURCES ARE LABELED`.

**EDIT / EVIDENCE:** Explicitly note the Clever Data API test was denied full roster scopes; no full live roster sync claim.

### 08:10–09:05 — LMS handoff

**PRESENTER SCRIPT:** “Let's return to Canvas, this time from the LMS administrator's point of view. The tool launch carries a signed course context. EducateOS maps it to a district course and an identity already understood by local policy. Deep Linking can hand an activity back to the LMS. Names and Role Provisioning provides class membership context, and Assignment and Grade Services can receive a teacher-approved result. In October lab runs we exercised the principal flows with real Canvas and Moodle systems, including grade passback. We're proud of that evidence, but it is not the same as being certified by 1EdTech. Other systems, including Schoology and Google Classroom, have their own validation scope. The school chooses its official grade authority.”

**SCREEN / ACTION:** Real lab Canvas launch → Deep Linking response evidence → teacher grade approval → Canvas gradebook. On right show a modest flow chart with NRPS/AGS. Bring up small status legend `LAB VALIDATED / SYNTHETIC / OPEN`.

**ON-SCREEN:** `TESTED WITH CANVAS + MOODLE • NO CERTIFICATION CLAIM`.

**EDIT / EVIDENCE:** No fake smooth Deep Linking UI picker capture if the verified path used the Canvas assignment API.

### 09:05–09:50 — District deployment and independence

**PRESENTER SCRIPT:** “Let's look underneath. In the EducateOS model, each district runs in a cloud account it controls. That's where its application runtime, roles, data and provider configuration belong. The installation tools and optional control plane help with setup and shared releases, but the design is specifically intended to avoid putting ordinary school work through a central foundation-owned application server. Some installer and full-service recovery steps still need fresh production-account validation. We're going to do that with technical advisers, not hide the remaining work behind a 'one-click install' graphic.”

**SCREEN / ACTION:** Account boundary graphic → real demo/test cloud resources (all tenant IDs redacted) → optional install preview. Show the same diagram as V03 for reuse.

**ON-SCREEN:** `DISTRICT ACCOUNT IS THE CONTROL BOUNDARY`.

**EDIT / EVIDENCE:** No implication that school staff need no operational support or vendor billing.

### 09:50–10:40 — What the foundation does—and doesn't do

**PRESENTER SCRIPT:** “This is where the foundation comes in. The code stays open source. The school pays the providers it actually uses—cloud resources, inference and any separately contracted service. The proposed foundation helps steward the shared releases, documentation, interoperability work and a network of optional implementation and support partners. We are also exploring a master integration agreement for Clever that could work across independently hosted schools. That's a negotiation goal, not an agreement already signed. And we don't want to make a district pay for annual helpdesk service just to keep the right to run its copy of EducateOS.”

**SCREEN / ACTION:** Three-column cost graphic `Free code / Provider usage / Optional service orders`; separate `Proposed Clever agreement—approval needed`. Show no undisclosed prices. Highlight exit right.

**ON-SCREEN:** `SHARED STEWARDSHIP, LOCAL CONTROL`.

**EDIT / EVIDENCE:** Tax-exempt status and Clever contract terms unconfirmed.

### 10:40–11:35 — FAQ: “We already have an LMS”

**PRESENTER SCRIPT:** “A question we expect is, 'We already pay for Canvas or Google Classroom. Why do we need this?' The answer is that we are not trying to sell a replacement gradebook. EducateOS adds a district-controlled environment for AI-supported work, curriculum resources, learning activities and governance. Where an existing LMS can remain the place teachers distribute assignments and track grades, we want to honor that. The practical choice depends on the school's setup. With Canvas, we have real LTI lab evidence. With Classroom, we have a narrower API smoke test and important district-wide integration work left. The right question for a pilot is: Which single teacher workflow could this improve without disrupting what's already working?”

**SCREEN / ACTION:** On-screen title `ANTICIPATED QUESTION` → LMS matrix with documented status → return to a course with activity. Distinguish value added from existing LMS, no vendor-bashing.

**ON-SCREEN:** `Q: DOES THIS REPLACE OUR LMS?  A: NOT REQUIRED.`

**EDIT / EVIDENCE:** Read as anticipated question, never impersonate a customer quote.

### 11:35–12:25 — FAQ: “Who can see student information?”

**PRESENTER SCRIPT:** “Another question is, 'Who can see what a student writes, and where does it go?' We would answer with a data-flow and permissions review, not a vague privacy promise. The school controls its account and decides which services it authorizes. A classroom teacher should receive course-related submissions appropriate to their role, not an unlimited view of private student conversations. Student access and agent tools are constrained by the local policy design. Some protections are already exercised in tests; some user-facing and recovery checks are still open. Before using real student data, the district must approve the intended data processing, provider scopes, retention, security responsibilities and incident plan.”

**SCREEN / ACTION:** Data flow chart with policy boundaries and explicit open acceptance flags. Show `No student data in this demo` prominently and avoid a generic compliance shield animation.

**ON-SCREEN:** `Q: WHO CAN SEE IT?  A: VERIFY THE ACTUAL ACCESS BOUNDARY.`

**EDIT / EVIDENCE:** Do not claim universal zero retention, formal FERPA/COPPA certification or fully proven chat isolation.

### 12:25–13:15 — FAQ: “Who pays, and who supports it?”

**PRESENTER SCRIPT:** “The next question is almost always: 'What does it cost, and who answers the phone?' The software license is free. The school still pays its cloud and AI providers. Setup, training and enhanced support could be optional, separately scoped services. We want teachers to call their local school team for ordinary account and classroom issues, with standardized documentation and escalation to foundation engineers for shared defects or incidents in foundation-operated services. That is the target support model, not a 24/7 promise we have staffed today. Our pilots should measure actual setup hours, support tickets and resource usage before we publish confident cost estimates.”

**SCREEN / ACTION:** Cost decomposition + support tiers `Teacher → School support → Technical escalation`. Insert real support playbook outline. Avoid posting fees as settled public prices.

**ON-SCREEN:** `NO SOFTWARE LICENSE FEE ≠ ZERO OPERATING COST`.

**EDIT / EVIDENCE:** Foundation funding, support SLAs and Clever pricing must be agreed before binding district service commitments.

### 13:15–14:05 — FAQ: “Are we ready for real students?”

**PRESENTER SCRIPT:** “And perhaps the most important question: 'Can we put this in front of students tomorrow?' Not on the basis of a good video. Before a district enrolls real students, it should see a documented acceptance gate: identity and access behavior, the exact roster source, accessibility of student and teacher paths, provider outage handling, restore and export procedures, incident contacts, and legal approval. We have substantial implementation and testing already, including live LMS lab runs. We also have specific remaining gates. We'll treat an approved sandbox demonstration, an authorized staff-only evaluation, and a real student pilot as three different milestones.”

**SCREEN / ACTION:** Three-stage card `Synthetic demonstration → Approved staff sandbox → Authorized student pilot`; show matching test ledger open flags. Do not show student footage here.

**ON-SCREEN:** `PROGRESS IS GATED BY EVIDENCE`.

**EDIT / EVIDENCE:** This video is not a production readiness certificate or a solicitation for real student exports.

### 14:05–14:55 — Ask the viewer to become a critic

**PRESENTER SCRIPT:** “Here's the feedback we would love from you. If you're a teacher, which step wastes time, and where would you want more control? If you're a curriculum leader, which standards and review processes are nonnegotiable? If you're a technology director, what failure mode do you think we have missed? And if you're a small-school administrator, would this actually fit your staffing reality? We are creating educator and technical advisory councils precisely so we can make those questions part of our engineering process. Membership isn't a purchase obligation, and a school doesn't have to join an advisory council to become a design partner.”

**SCREEN / ACTION:** Four stakeholder cards; a question per card. Show a lightweight feedback artifact `Issue → Evidence → Decision → Owner`, then return to real interface.

**ON-SCREEN:** `HELP US FIND THE REAL PROBLEMS`.

**EDIT / EVIDENCE:** This is recruitment for advisory discussions, not a claim of public institutional endorsement.

### 14:55–15:30 — A clear next step

**PRESENTER SCRIPT:** “If you'd like to help, the next step is a guided evaluation conversation. We'll ask what systems your school uses, show the matching demo path, and agree on a small set of success criteria. We'll be equally interested in reasons not to adopt EducateOS yet. We'd rather discover an operational problem in a test district than discover it in a real classroom. Thanks for spending the time with us. We look forward to seeing what educators and school technology teams can build together.”

**SCREEN / ACTION:** Return to the lesson's student preview and teacher-approved feedback, then clean end card with one URL to `Request a guided evaluation`. Include small `Source/test evidence available on request` footer, not a second CTA.

**ON-SCREEN:** `REQUEST A GUIDED EVALUATION`.

**EDIT / EVIDENCE:** End on a complete recorded flow; do not use a hypothetical testimonial.

**Recording pickups:** Record two standalone openings (educator-heavy vs CTO-heavy). Capture a clean 2-minute classroom reel, 90-second integration proof, 60-second governance reel and a 45-second foundation explainer from the same master session. For Q&A, render each question explicitly as `Anticipated question` so it cannot be mistaken for a real quotation or customer interview.

---
# V09 — Installation and support clinic

**Runtime:** 11:30. **Primary viewer:** District IT administrator, implementer, school technology coordinator, technical advisory member. **Objective:** Prove that setup and day-two operations can become a repeatable, supportable process. **CTA:** Request a supervised installation clinic with test accounts. **Location:** Fresh disposable Cloudflare test account if successfully validated; otherwise documented installer preview plus real test resources. **Tone:** Trainer-on-screen, honest and repeatable; no claims of a fully unattended production install until it passes.

**Pre-recording hard gate:** Run the full install, configure auth, import a safe roster, complete an LMS test, and exercise rollback in a fresh account using the pinned release. If any of these is not working end to end, show a clearly marked **PREVIEW / LAB TEST** for that chapter and retain the explanation in the public recording. Never splice a successful scene from one account into another as if it were one uninterrupted deployment. Never expose access tokens, client secrets, student data, real account IDs or unrestricted policy settings.

### 00:00–00:45 — What this clinic actually covers

**PRESENTER SCRIPT:** “Welcome to the EducateOS installation and support clinic. This is a technical walkthrough intended for school IT staff and the consultants who help them. We're using a disposable test environment and synthetic school data. I'll show the proposed deployment sequence: account permissions, domain, first administrator, identity, roster, optional LMS, AI budgets, and the health checks we want before a school uses the system. I'll also show what happens when something fails and when to escalate. One important distinction: parts of the installer have been exercised against real cloud resources, but that is not yet the same as a finished, fully validated school deployment. We'll label each step according to the evidence behind it.”

**SCREEN / ACTION:** Show title, synthetic account label, pinned release/version, compact agenda and evidence legend. Presenter points to a `SAFE DEMO ACCOUNT` marker. Open official runbook or reproducible internal install plan.

**ON-SCREEN:** `TRAINING ENVIRONMENT • NO LIVE STUDENT DATA`.

**EDIT / EVIDENCE:** This is a clinic, not a blanket claim that self-service production installation is available to anyone.

### 00:45–01:35 — Prepare the owning account and domain

**PRESENTER SCRIPT:** “First, decide who owns the account. For a district deployment, it should be a district-controlled account with institutional recovery and appropriate administrator access. Choose a domain that the district also controls; that makes identity, certificates and exit planning easier to reason about. Before clicking Install, confirm who can approve DNS changes, who is authorized to deploy Workers, and where the billing alerts go. We want a named primary administrator and a backup—not a single staff member's personal login as the school's disaster-recovery plan. In this test, I'll use our synthetic organization's account and domain, which are not a real school's resources.”

**SCREEN / ACTION:** Show account-selection screen with IDs blurred; display domain validation/preflight status; pop up a simple check card `Owner / DNS / Billing / Backup admin`. Do not open real personal billing pages.

**ON-SCREEN:** `OWNERSHIP → DOMAIN → ADMINISTRATIVE RECOVERY`.

**EDIT / EVIDENCE:** If using a project-owned demo account, do not label it district-owned production infrastructure.

### 01:35–02:30 — Review authorization before granting it

**PRESENTER SCRIPT:** “Next are installation permissions. This is where many systems ask for far more access than they need. The installer should present what resources it intends to create or change. We need to understand whether a token can deploy Workers, modify routes, access storage, or update DNS. Here I review the plan before authorizing it. I also check that the credentials are scoped, that there's a route to revoke them, and that the production runtime won't rely on an installation credential staying active forever. If I revoke installer authorization midway through an upgrade, the safe outcome is to stop making new changes and preserve the running school system—not to continue with a partially trusted session.”

**SCREEN / ACTION:** Show real permission manifest and dry-run/plan diff → scope approval UI or equivalent evidence → a synthetic revoked-token test. Redact all secrets. Zoom on permission names, not token values.

**ON-SCREEN:** `REVIEW THE PLAN • LIMIT PERMISSIONS • REVOKE SAFELY`.

**EDIT / EVIDENCE:** The revoked-installer-credential safety path is exercised in tests; live cloud permissions still require their own runbook validation.

### 02:30–03:30 — Apply, validate, and record what changed

**PRESENTER SCRIPT:** “Now we apply the installation. Watch the resource plan: it should say what it creates and whether anything existing will be changed. We record the release identifier, the account, the application hostname, and the person who approved the change. Once the platform reports success, don't immediately onboard teachers. First check that the health endpoint responds, that the expected runtime and storage exist, and that an unauthenticated visitor cannot simply open a private district API. We also need to verify the public endpoints an LMS legitimately requires, such as its LTI key discovery path. This is the stage where a good installer either produces evidence or produces a concrete error we can fix.”

**SCREEN / ACTION:** Record genuine installer output / deploy summary and health probe. Redact tokens, account IDs and secret environment variables. Show a private API denied to an anonymous browser and a public JWKS endpoint permitted if the current deployment supports it. If install doesn't pass from a fresh account, use `GUIDED-INSTALL PREVIEW; LIVE VALIDATION PENDING` slate and stop rather than simulate success.

**ON-SCREEN:** `DEPLOYMENT RECEIPT • HEALTH • AUTH BOUNDARIES`.

**EDIT / EVIDENCE:** An HTTP 200 health response is not a security or readiness certification.

### 03:30–04:20 — Set the initial administrator

**PRESENTER SCRIPT:** “The first human account needs special care. Before any roster goes in, the organization designates its initial administrator and confirms that person's verified sign-in method. We also identify an emergency recovery contact under local policy. That administrator should be able to view the district's configuration, grant appropriate staff responsibilities and inspect integration health. A classroom teacher shouldn't accidentally inherit these permissions because they happen to use the same email address at another school. The first sign-in is a test: a valid administrator reaches the console, and someone with the wrong identity or role does not.”

**SCREEN / ACTION:** Use safe staged administrator bootstrap process if UI not yet verified; show actual successful admin login and refused nonadmin session in the same test tenant. Reveal neither one-time PIN nor recovery link.

**ON-SCREEN:** `BOOTSTRAP ADMIN → VERIFY IDENTITY → TEST DENIAL`.

**EDIT / EVIDENCE:** Do not invent a finished emergency break-glass feature or bypass. Follow tested bootstrap mechanism for the current release.

### 04:20–05:10 — Configure school sign-in

**PRESENTER SCRIPT:** “Now choose the sign-in provider. A school might use Google Workspace, Microsoft, a district identity provider, Clever or ClassLink. Those are not interchangeable checkboxes. Each has different claims, callback rules and contractual conditions. In our integration tests, the core requirement is to accept a verified issuer and subject and match it inside the intended school organization. We'll test an authorized teacher and student, then a person from another district who should not receive access here. If the school wants Clever, we need to confirm whether the intended connection is an ordinary portal link, a full OAuth integration, or a production roster authorization; the proposed foundation umbrella contract is not yet a substitute for vendor approval.”

**SCREEN / ACTION:** Provider selection/config page → authorized OIDC test → incorrect-subject test → status matrix. Use provider fake with badge if that is the environment; do not imply ClassLink live sandbox validation.

**ON-SCREEN:** `SIGN-IN CLAIMS MUST MATCH THE RIGHT DISTRICT`.

**EDIT / EVIDENCE:** Clever OIDC-through-Access live sign-in remained unproven on the documented demo as of Oct 26; keep accurate labels.

### 05:10–06:05 — Establish the authoritative roster

**PRESENTER SCRIPT:** “Sign-in doesn't tell us which class someone belongs to. That's the roster's job. The school chooses its authoritative source: a local roster, OneRoster feed, authorized SIS path, or another approved integration. Before the first real synchronization, we preview how school IDs, courses, sections and enrollments will map. We check for duplicates, missing identities and unexpected removals. Here's an intentionally broken synthetic feed that tries to remove too many students at once. The system holds that change and asks an administrator to review it. We never want a midnight sync failure to look like a district-wide withdrawal the next morning.”

**SCREEN / ACTION:** Select roster authority → import synthetic OneRoster sample → preview mapping → run intentional large-removal case → show actual test hold outcome. If admin UI for hold is unavailable, capture the service test result with `HARNESS EVIDENCE` badge.

**ON-SCREEN:** `ROSTER PREVIEW • LARGE-CHANGE HOLD • ADMIN REVIEW`.

**EDIT / EVIDENCE:** OneRoster live-provider validation and fully deployed sync scheduling need distinct proof; do not show real student rosters.

### 06:05–07:00 — Connect only the learning systems needed

**PRESENTER SCRIPT:** “An LMS is optional for a standalone small school, but many districts already have one. If Canvas is the grade authority, register the EducateOS LTI tool in the district's test Canvas environment and map its deployment to the appropriate courses. Test a teacher launch, a student launch, and a grade passback after teacher approval. Our Canvas and Moodle lab evidence is a useful starting point. It does not guarantee that a particular tenant is configured correctly. If the district uses Google Classroom, the integration path is different: it uses Classroom APIs and has its own account and authorization requirements. We should validate one actual school workflow before enabling any broad sync.”

**SCREEN / ACTION:** LMS authority selector → safe Canvas test course tool registration → sample teacher launch and approved grade → technical clip of test result. Add a separate card `Google Classroom API path; limited live validation`. Redact client IDs if they are sensitive in context.

**ON-SCREEN:** `CONFIGURE GRADE AUTHORITY • TEST THE HANDOFF`.

**EDIT / EVIDENCE:** No generic 'one switch supports every LMS' claim; no certification mark.

### 07:00–07:50 — Set budgets and policy scopes

**PRESENTER SCRIPT:** “Before inviting staff, set AI access and spending rules. Decide which grade bands, courses and roles can use which capabilities. Make the initial budget intentionally small for a pilot, so a mistake doesn't become an unexpected bill. Then try a request that should work and one that should be denied. The response and audit trail need to match what the administrator intended. Remember: a configured budget in EducateOS is one control among several. The district still needs provider billing alerts and an agreed process to respond if costs or behavior move outside the expected range.”

**SCREEN / ACTION:** Configure synthetic budget and policy → success and refusal using test fixtures → show usage status. Do not use real credit cards or paid tenant spending screens.

**ON-SCREEN:** `START SMALL • ENFORCE POLICY • MONITOR PROVIDER BILLING`.

**EDIT / EVIDENCE:** Avoid guarantee of hard dollar caps across all upstream providers without proven integration and accounting reconciliation.

### 07:50–08:40 — The mandatory smoke-test checklist

**PRESENTER SCRIPT:** “We're not finished when the install reports green. A minimal acceptance pass should verify the right people get in, the wrong people stay out, the roster represents the school's actual policy, the grade destination is correct, and the recovery owner knows what to do. For the full product, we also need accessible student, teacher and administrative workflows, a successful data-export test, and a tested recovery procedure. The repository's pilot gate records what has been exercised and what remains open. Until the gates required for this district's use case are met, this remains a sandbox or staff-only evaluation.”

**SCREEN / ACTION:** On-screen table `Authentication / Access denial / Roster / Grade route / AI budget / Accessibility / Restore / Incident contact`, each `PASS`, `OPEN` or `N/A with reason`. Use live test receipts where available and red open items where not.

**ON-SCREEN:** `GREEN INSTALL ≠ AUTHORIZED STUDENT PILOT`.

**EDIT / EVIDENCE:** Don't flip open items to green just for the footage.

### 08:40–09:25 — Troubleshoot one ordinary failure

**PRESENTER SCRIPT:** “Let's deliberately break something. Here the roster provider returns an authorization error. The right response isn't to wipe the directory or quietly guess what changed. We check the provider status, the connector's configured scopes, and the last known successful sync. We record the error without exposing credentials, keep the current safe roster state, and escalate if the school cannot correct the authorization. That is the kind of routine failure a school should be able to understand from documentation before opening a support ticket.”

**SCREEN / ACTION:** Trigger auth failure against synthetic provider → inspect provider health and last successful run → show troubleshooting decision tree. If error UI missing, use genuine test output plus a card `UI work remaining`.

**ON-SCREEN:** `FAILED SYNC → HOLD LAST GOOD STATE → INVESTIGATE`.

**EDIT / EVIDENCE:** Only claim last-good-state behavior for paths actually tested; no guarantee all providers do this yet.

### 09:25–10:10 — Support responsibility and security escalation

**PRESENTER SCRIPT:** “Who owns the ticket matters as much as how the software works. A teacher's forgotten sign-in or an ordinary class membership question begins with the school team. Provider authentication or roster issues go to the district integration owner. A reproducible EducateOS software defect can be escalated to maintainers. A problem in a foundation-operated broker has a separate incident owner, because that service is the foundation's responsibility. Optional paid consulting is for scoped configuration and training; it shouldn't be the only way a district receives security advisories about the software it runs.”

**SCREEN / ACTION:** Escalation map `Teacher → Local helpdesk → District integration owner → Foundation code/shared-service owner`. Show mock ticket with synthetic error ID and documented checklist, not fake support SLA countdown.

**ON-SCREEN:** `LOCAL L1 • TECHNICAL ESCALATION • SHARED-SERVICE INCIDENT OWNER`.

**EDIT / EVIDENCE:** Do not promise a staffed 24/7 line or guaranteed response times before contracts and coverage exist.

### 10:10–10:50 — Upgrade, rollback and exit

**PRESENTER SCRIPT:** “Finally, make a change safely. Before an upgrade, identify the signed release, capture the configuration and current serving deployment, and check whether the plan changes data or permissions. Practice backing out a bad deployment in the test account. For a real school, that rehearsal must include restoring its actual data stores and proving the old version can still serve the necessary classroom workflows. A district should also understand how to export eligible records and revoke any optional foundation connection if it leaves.”

**SCREEN / ACTION:** Show version/upgrade receipt and current deployed version; demo documented rollback only if tested in environment. On graphic, mark real storage restore and district export rehearsal `OPEN` until run end-to-end.

**ON-SCREEN:** `VERSION → BACKUP → CHANGE → VERIFY → ROLLBACK IF NEEDED`.

**EDIT / EVIDENCE:** A deploy rollback is not equivalent to a disaster recovery rehearsal, and export may not be complete.

### 10:50–11:30 — Closing checklist and next step

**PRESENTER SCRIPT:** “That's the installation story we want to make boring—in the best way. Each step has an owner. Each integration has an authority and a test. Each failure has a documented first action and escalation route. And a school can make an informed decision about what it will operate itself and what help it wants to buy. If you manage school technology, we're looking for people to run this clinic with us using a disposable account and synthetic data. Bring your deployment checklist and tell us where our instructions fall short. The first real pilot should be the result of that evidence, not the starting assumption.”

**SCREEN / ACTION:** Show completed `Sandbox readiness` receipt with real pass/open rows. End with one link: `Request supervised installation clinic`. No production student data intake form.

**ON-SCREEN:** `BOOK A SUPERVISED INSTALLATION CLINIC`.

**EDIT / EVIDENCE:** This video can be offered privately before all gates close if every simulated or unvalidated step is prominently identified.

**Recording pickups:** A 2-minute `installer preflight` clip, a 3-minute `SSO + roster troubleshooting` clip and a `How to read the pilot gate` support explainer. Keep a separate internal version including debugging logs and a public version with secrets/account IDs removed.

---

# Production appendix A — Evidence and claim ledger

This ledger is a *recording checklist* based on the EducateOS repository documentation reviewed 30 October 2026, including `docs/educateos/maturity.md`, `docs/educateos/pilot-gate.md`, `docs/educateos/lti.md`, `docs/educateos/integrations/google-classroom.md`, `docs/educateos/control-plane.md`, and the demo-district/production runbooks. Re-run before recording. Repository evidence can become stale as code changes.

| Claim or shot | Evidence as documented | Approved public wording | Never show or say without further proof |
|---|---|---|---|
| Open-source, district-hosted architecture | Apache-2.0 license; district-own-account ADRs and deployment code | “Designed to run in the school's own Cloudflare account.” | “Zero operating cost” or “all schools are already running it” |
| Six district fixtures | Synthetic harness and provider fakes | “Synthetic configurations representing different school technology stacks.” | “Six partner districts” |
| LTI Tool with Canvas and Moodle | Live lab runs Oct 26 for core/Advantage flows | “Tested in real Canvas and Moodle lab environments.” | “1EdTech certified” or “works with all LMS providers” |
| Teacher-approved grade passback | Live lab + service tests | “An approved grade passed to Canvas/Moodle in lab.” | “The model automatically publishes grades” |
| Deep Linking | Live response validation; automation did not click some LMS picker dialogs | “Deep Linking response validated in the LMS lab.” | A manufactured uninterrupted picker-to-assignment screen capture |
| Google Classroom | Single-course live smoke run, broad rostering fake-only | “Limited one-course API flow tested live.” | “District-wide Google Classroom integration production-ready” |
| Clever roster API | Local fake tests; live sandbox lacked full Data API scopes | “A Clever adapter is in synthetic testing.” | “We currently sync full Clever rosters for districts” |
| Clever SSO via Access | Fakes/tests; live district sign-in not completed Oct 26 | “Clever sign-in flow under integration validation.” | “Clever-certified production SSO” |
| ClassLink SSO/OneRoster | Own fakes tested; no external sandbox yet as documented | “ClassLink integration logic is tested against synthetic providers.” | “Validated against live ClassLink tenants” |
| OneRoster | Import and safety tests; live provider validation pending | “OneRoster import and removal safeguards have test coverage.” | “Interoperates with all SIS feeds live today” |
| Content Studio | Implemented review/quarantine and tests | “Imported content goes through a review and approval model.” | “Catches every harmful document or copyright problem” |
| District student/teacher/admin UI | Features under active review; G1 accessibility gate open | “Available to demonstrate in the pinned synthetic environment where verified.” | “WCAG 2.2 AA certified” or universal accessibility claims |
| AI budgets, policy and approvals | Domain/harness tests and some runtime paths | “Configurable budget and approval controls with documented test coverage.” | “Every control end-to-end production verified” |
| Private chat isolation | Policy tests but relevant API routes still open | “Private access boundaries are being verified across the full stack.” | “No teacher or peer can ever access any private chat, proven end-to-end” |
| Installer | Fake Cloudflare API tests plus limited real-account runs; fresh-install gates open | “Guided installation and real-cloud validation in progress.” | “No-code one-click production install for every district” |
| Restore, portability, export | Pilot acceptance criteria contain open end-to-end tasks | “Portability and recovery are explicit release gates.” | “Fully proven disaster recovery and complete export” |
| Clever foundation agreement | Draft term sheet, no accepted agreement | “Proposed umbrella Clever arrangement requires vendor approval.” | Clever logo presented as partner or fee exemption |
| Foundation setup/support payments | Draft service catalog only | “Optional services and funding model under development.” | Definitive price, staffed SLA or executed support agreement |
| FERPA/COPPA, certification, retention | Compliance responsibilities and assessments planned | “We provide a data-flow and security review for the district.” | “FERPA-certified,” “COPPA-certified,” or blanket zero retention |

# Production appendix B — Shoot-day checklist and editorial rules

**Freeze the environment.** Record git commit SHA, release label, browser, fixture, login role, provider mode (real lab, synthetic fake, preview), test result, and intended audience on a take sheet. If a clip changes commits, slate the difference; do not hide it through a jump cut.

**Synthetic-data discipline.** Use synthetic student names, scores and materials only. Never include real student accounts, grades, protected data, personal inboxes or client secrets. Scrub URLs, Access tokens, Cloudflare account identifiers and OpenID configuration secrets from every frame, including browser autofill and toast notifications.

**UI legibility.** Capture at 1920 × 1080 or 3840 × 2160, landscape master, 30 fps unless capture requires 60. Use a clean cursor path, high-contrast focus states, 2–3 seconds after consequential actions, and large readable crop inserts. Provide captions, a human-readable transcript, and alt text for any associated stills. Avoid tiny source code as decorative motion footage.

**Evidence styling.** Persistent lower-third in all product shots: `SYNTHETIC DEMO`, `LIVE LMS LAB`, `TEST HARNESS`, or `ILLUSTRATIVE PREVIEW`, never ambiguous green check marks. Written certification and vendor-partnership claims require separate written evidence. The same clip can be used in multiple videos only if its tag remains visible.

**Audio and pacing.** Record a neutral, confident voice at natural speed (~120–140 spoken words/minute for narrative, ~110–125 for technical walkthroughs). The edit should wait for a real UI state rather than requiring unnatural speed-reading; adjust runtimes after table reads and authentication pauses. Target −16 LUFS stereo for online delivery, dialogue clearly audible, and no music masking instructional details.

**Call-to-action discipline.** One action per published video. Tracking links may differ by channel but must not collect student data. The landing page should clearly distinguish preview/advisory interest from a production deployment request and avoid implying institutional endorsement.

**Approval gate.** A feature owner signs off the literal narrated claims; one educator reviews clarity and classroom validity; one technical reviewer checks state transitions and trust boundaries; one privacy/legal reviewer checks data and vendor language. Archive evidence links, dated source commit, subtitle transcript, and final approved export.

**Cut list.** Export a 16:9 master of each V01–V09, a caption file *generated after timing the final edit*, a clean narration WAV, a no-music dialogue mix, and labeled screenshots. Recommended derivatives: V01 30s teaser, V02 25s lesson flow, V03 60s CTO, V04 20s platform-specific proof, V05 30s governance, V06 45s small school, V07 15s foundation, V08 2-min overview, V09 2-min setup preflight. These are edit plans, not additional independently scripted videos.

# Production appendix C — Source-of-truth references

- Repository: https://github.com/gmackie/educate-os
- Capability maturity: https://github.com/gmackie/educate-os/blob/main/docs/educateos/maturity.md
- Pilot acceptance gate: https://github.com/gmackie/educate-os/blob/main/docs/educateos/pilot-gate.md
- District architecture and modules: https://github.com/gmackie/educate-os/blob/main/docs/educateos/README.md
- LTI tool wiring and evidence pointers: https://github.com/gmackie/educate-os/blob/main/docs/educateos/lti.md
- Google Classroom integration: https://github.com/gmackie/educate-os/blob/main/docs/educateos/integrations/google-classroom.md
- Demo district runbook: https://github.com/gmackie/educate-os/blob/main/docs/educateos/runbooks/demo-districts.md
- Public control plane and installer: https://github.com/gmackie/educate-os/blob/main/docs/educateos/control-plane.md
- Earlier production brief: `EducateOS_Demo_and_Video_Production_Briefs_v1.docx` (the V01–V09 naming/lengths source).

*These URLs document current design and test status. They are not evidence of Clever or 1EdTech endorsement, and the source should be reopened and the claims revalidated before publication.*
