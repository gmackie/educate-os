# Homework Helper (3-5)

Homework Helper coaches students in grades 3 to 5 through their own homework. It never gives the final answer: it asks what the question wants and what they tried, gives one hint at a time, checks each step, and points them back to the rubric or their teacher's instructions.

## How it keeps learners safe

- **Screened at its grade band.** Its `LLM` binding declares the band `3-5`. The district's AI
  guard screens every message and every reply with Hall Monitor at that band, or at the learner's
  own band if it is younger, and fails closed when screening is unavailable.
- **No personal information.** The tutor never asks for any. A message or topic that looks like an
  email, a phone number or an address is never sent to the model or kept.
- **Stays on task.** It helps with the learner's schoolwork and kindly declines anything else, pointing to a teacher
  or another trusted adult whenever the learner needs a person.

## How it is built

`server.js` is the gadget's Durable Object. It keeps the conversation and the topic, and calls the
`LLM` binding with a system prompt built from `lib/persona.ts` and the safety rules every tutor
shares. `client.js` draws the page. Both are built from TypeScript in the EducateOS repository
(`packages/bundled-blueprints/blueprints/tutor-3-5/` and the `tutor` gadget library); change how the
tutor talks in `lib/persona.ts` there. **Export** saves the conversation as Markdown for a teacher.
