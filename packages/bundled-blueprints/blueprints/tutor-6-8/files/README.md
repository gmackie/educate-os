# Study Coach (6-8)

Study Coach helps students in grades 6 to 8 with math and writing. In math it asks guiding questions, one at a time, so the student finds each step and checks their own reasoning. On a draft it names one strength and at most two next steps, and never rewrites the student's sentences.

## How it keeps learners safe

- **Screened at its grade band.** Its `LLM` binding declares the band `6-8`. The district's AI
  guard screens every message and every reply with Hall Monitor at that band, or at the learner's
  own band if it is younger, and fails closed when screening is unavailable.
- **No personal information.** The tutor never asks for any. A message or topic that looks like an
  email, a phone number or an address is never sent to the model or kept.
- **Stays on task.** It helps with math and the learner's school writing and kindly declines anything else, pointing to a teacher
  or another trusted adult whenever the learner needs a person.

## How it is built

`server.js` is the gadget's Durable Object. It keeps the conversation and the topic, and calls the
`LLM` binding with a system prompt built from `lib/persona.ts` and the safety rules every tutor
shares. `client.js` draws the page. Both are built from TypeScript in the EducateOS repository
(`packages/bundled-blueprints/blueprints/tutor-6-8/` and the `tutor` gadget library); change how the
tutor talks in `lib/persona.ts` there. **Export** saves the conversation as Markdown for a teacher.
