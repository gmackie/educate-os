// A persona for the library's own tests, so they do not depend on any one blueprint's wording.
import type { TutorPersona } from "../server.ts";

export const PERSONA_FIXTURE: TutorPersona = {
  name: "Test Tutor",
  band: "6-8",
  tagline: "A tutor for tests.",
  avatar: "🧪",
  greeting: "Hello! What are we working on?",
  focus: "the test topic",
  role: "You help with the test topic.",
  readingLevel: "Write plainly.",
  maxReplyWords: 50,
  rules: ["Ask one question at a time.", "Never give the answer."],
  privacyReply: "Let's keep that private.",
  topicLabel: "Topic",
  topicPlaceholder: "Fractions",
  inputPlaceholder: "Type here",
  quickReplies: ["Give me a hint", "I'm done"],
  helpNote: "Ask a trusted adult if something is wrong.",
  readAloud: true,
  theme: { accent: "#123456", onAccent: "#ffffff", background: "#fafafa", fontSize: 18 },
};
