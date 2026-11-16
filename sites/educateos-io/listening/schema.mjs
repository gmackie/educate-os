/** Public notice revision stored alongside each listening submission. */
export const NOTICE_VERSION = 'community-listening-2026-11-15-v1';
/** Fixed answer choices: no names, schools, student records or free text. */
export const QUESTIONS = {
  roles: ['Teacher / educator', 'School or district administrator', 'Parent / guardian', 'Homeschool educator', 'Technology / support staff', 'Other adult perspective', 'Prefer not to say'],
  tools: ['MagicSchool', 'ChatGPT', 'Google Gemini', 'Microsoft Copilot', 'Google Classroom / Workspace', 'Microsoft Teams / 365', 'Canvas', 'Schoology', 'Moodle', 'Other tools', 'No current tools', 'Prefer not to say'],
  workflows: ['Lesson planning', 'Finding or adapting materials', 'Assessment and feedback', 'Administrative tasks', 'Family communication', 'Accessibility and accommodations', 'Connecting existing tools', 'No unmet need', 'Unsure / prefer not to say'],
  policy: ['No AI use in education', 'Staff use only', 'Case-by-case with human approval', 'School-approved tools with clear limits', 'Locally decided by educators and families', 'Unsure / prefer not to say'],
  interests: ['Reviewing ideas', 'Educator advisory conversations', 'Technical or privacy review', 'Exploring a future pilot', 'Following public progress', 'No further involvement', 'Unsure / prefer not to say'],
  barriers: ['Privacy and data handling', 'Accuracy and trust', 'Cost or sustainability', 'Time and training', 'Compatibility with current tools', 'Accessibility', 'AI concerns or opposition', 'Existing tools meet my needs', 'No major barrier', 'Unsure / prefer not to say'],
};
/** Independently consented contact choices; never interpreted as marketing permission. */
export const FOLLOW_UP = ['One research conversation', 'Advisory group discussion', 'Technical or privacy review', 'Future pilot readiness discussion'];
const requireTrue = value => { if (value !== true) throw new Error('invalid'); };
/** Strict, bounded validation shared by the API and offline tests. */
export function validateSubmission(input, kind) {
  const common = ['adult', 'participation', 'noticeVersion', 'receipt', 'turnstileToken', 'honeypot'];
  const allowed = [...common, ...(kind === 'survey' ? Object.keys(QUESTIONS) : ['email', 'topic', 'followUpConsent'])];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('invalid');
  requireTrue(input.adult); requireTrue(input.participation);
  if (input.noticeVersion !== NOTICE_VERSION || !/^[a-f0-9]{64}$/.test(input.receipt) ||
      typeof input.turnstileToken !== 'string' || !input.turnstileToken || input.turnstileToken.length > 2048 ||
      typeof input.honeypot !== 'string' || input.honeypot.length > 200) throw new Error('invalid');
  if (kind === 'survey') {
    const result = {};
    for (const [key, options] of Object.entries(QUESTIONS)) {
      const values = input[key];
      if (!Array.isArray(values) || values.length > (key === 'policy' ? 1 : options.length) ||
          new Set(values).size !== values.length || values.some(v => !options.includes(v))) throw new Error('invalid');
      result[key] = values;
    }
    return {kind, noticeVersion: NOTICE_VERSION, adult: true, participation: true, ...result};
  }
  requireTrue(input.followUpConsent);
  if (!FOLLOW_UP.includes(input.topic)) throw new Error('invalid');
  return {kind, noticeVersion: NOTICE_VERSION, adult: true, participation: true, followUpConsent: true, topic: input.topic};
}
