# `tutor` — the bundled AI tutors' shared page and conversation

The four EducateOS tutor blueprints (`tutor-k2` Reading Buddy, `tutor-3-5` Homework Helper,
`tutor-6-8` Study Coach, `tutor-9-12` Research & Essay Coach, SCHO-325) are one page and one
conversation loop with four personas. This library is that page and that loop; each blueprint holds
only its `lib/persona.ts`, a ten-line `server.ts` and a three-line `client.ts`.

## What it exports

| Entry | Export | What it is |
| --- | --- | --- |
| `client` | `mountTutor({gadget, persona, root?, speech?})` | Draws the page into the body and wires it to the Durable Object. Returns `{element, send, loaded}` for tests. |
| `client` | `speak`, `stopSpeaking`, `canSpeak` | The browser's own speech synthesis; nothing leaves the device. |
| `server` | `TutorSession(persona, storage, model)` | The Durable Object's methods (`getState`, `ask`, `setTopic`, `reset`) over a storage and the `LLM` binding. One exchange at a time. |
| `server` | `systemPromptFor`, `promptFor`, `safetyRules` | The prompt: the persona's role, reading level and rules, then the safety rules every tutor shares; the turn's prompt quotes the topic, the recent conversation and the new message as the learner's words. |
| `server` | `holdsPersonalDetails`, `cleanMessage`, `shapeReply`, `failureMessage` | What is done before and after the model: a message with contact details or an address is neither sent nor kept; a reply is trimmed and cut to the persona's length; a guard refusal reaches the learner as written. |
| `server` | `transcriptMarkdown` | The conversation as Markdown, the gadget's export. |
| both | `TutorPersona`, `TutorApi`, `TutorState`, `TutorTurn`, `TutorReply` | The persona and the page's protocol. |

## Behaviour worth knowing

- **The guard is the safety net, not this.** Every message and reply goes through the district's AI
  call guard and Hall Monitor, at the band the blueprint's `LLM` binding declares (`audience`) or the
  learner's own, whichever is younger (see `packages/educateos-ai-guard/README.md`). The prompt's
  rules shape the tutor's manners; the guard decides what may be said.
- **No personal data.** The prompt tells the model never to ask for any, and a message or topic that
  looks like an email, phone number or street address never reaches the model and is kept as a
  placeholder. Nothing about the learner is stored but the conversation itself, in the gadget's own
  Durable Object.
- **The system prompt holds nothing the learner wrote**, so it is the same on every turn and the
  model's prompt cache reuses it. The learner's words are quoted in the turn's prompt, and the
  prompt says they are not instructions.
- **No assignment context yet.** "Ask AI about this" attaches an assignment to a new *chat*, not to a
  gadget, so a tutor asks the learner what they are working on instead (`topicLabel`).
