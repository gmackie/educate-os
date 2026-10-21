// The district policy floor in plain language, and which edits loosen it. Loosening is judged by
// the contract's own orderings, so the console asks for confirmation exactly where the district's
// plan will require a district administrator's approval.
import { POLICY_ORDERINGS, type OrderedPolicyKey, type PolicySettings } from "@schoolos/contracts";

/** One choice of an enumerated setting, as an administrator reads it. */
export interface PolicyChoice<V extends string = string> {
  /** The stored value. */
  value: V;
  /** The choice's name. */
  label: string;
  /** What choosing it means for students and staff. */
  explanation: string;
}

/** An enumerated setting, as an administrator reads it. */
export interface EnumeratedPolicy<K extends OrderedPolicyKey = OrderedPolicyKey> {
  /** The setting. */
  key: K;
  /** Its name. */
  label: string;
  /** What it governs. */
  explanation: string;
  /** Every choice, strictest first. */
  choices: PolicyChoice<(typeof POLICY_ORDERINGS)[K][number]>[];
}

/** Every enumerated district setting, in the order the Policies screen lists them. */
export const ENUMERATED_POLICIES: readonly EnumeratedPolicy[] = [
  {
    key: "aiSpending",
    label: "AI spending",
    explanation: "Whether students and staff can use AI that the district pays for.",
    choices: [
      { value: "disabled", label: "Off", explanation: "No one can use district-funded AI." },
      { value: "capped", label: "Capped", explanation: "AI can be used, up to each person's monthly cap and the funding the district sets aside." },
    ],
  },
  {
    key: "promptsInGatewayLogs",
    label: "Prompt logging",
    explanation: "Whether the text people send to AI may be kept in the district's AI request logs.",
    choices: [
      { value: "prohibited", label: "Not logged", explanation: "Only counts and costs are recorded, never what anyone wrote." },
      { value: "permitted", label: "Logged", explanation: "What people send to AI may be kept in the request logs, where district staff with log access can read it." },
    ],
  },
  {
    key: "studentPersonalConversations",
    label: "Personal conversation privacy",
    explanation: "Who can read the AI conversations students have in their own personal space.",
    choices: [
      { value: "private", label: "Private", explanation: "Only the student can read their personal conversations." },
      { value: "shared-by-student", label: "Shared when the student chooses", explanation: "A student may choose to share a personal conversation with a teacher." },
    ],
  },
  {
    key: "teacherObservation",
    label: "Teacher observation",
    explanation: "What teachers can see of their students' work.",
    choices: [
      { value: "assigned-work-only", label: "Assigned work only", explanation: "Teachers see the work students do for the teacher's own assignments." },
      {
        value: "assigned-work-and-shared-conversations",
        label: "Assigned work and shared conversations",
        explanation: "Teachers also see conversations their students have shared with them.",
      },
    ],
  },
  {
    key: "automatedSelProfiling",
    label: "Social-emotional profiling",
    explanation: "Whether software may build social-emotional learning profiles of students automatically.",
    choices: [
      { value: "prohibited", label: "Not allowed", explanation: "No automated social-emotional profiles are made." },
      {
        value: "permitted-with-review",
        label: "Allowed with review",
        explanation: "Automated profiles may be made, and each one must be reviewed by a person before anyone acts on it.",
      },
    ],
  },
];

/** The per-person AI cap, as an administrator reads it. */
export const MONTHLY_CAP = {
  label: "Monthly AI cap per person",
  explanation: "The most the district spends on one person's AI use in a month. Raising it lets each person use more AI.",
} as const;

/** A setting an edit makes less strict, for the loosening confirmation. */
export interface LoosenedSetting {
  /** The setting. */
  key: keyof PolicySettings;
  /** Its name. */
  label: string;
  /** The value now, as the administrator reads it. */
  from: string;
  /** The value after the edit. */
  to: string;
}

/** A cap in cents, as dollars. */
export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function choiceLabel(key: OrderedPolicyKey, value: string): string {
  return ENUMERATED_POLICIES.find((p) => p.key === key)?.choices.find((c) => c.value === value)?.label ?? value;
}

/**
 * The settings `next` makes less strict than `current`. The contract orders each setting loosest
 * first; a higher cap is looser.
 */
export function loosenedSettings(current: PolicySettings, next: PolicySettings): LoosenedSetting[] {
  const loosened: LoosenedSetting[] = [];
  for (const { key, label } of ENUMERATED_POLICIES) {
    const order: readonly string[] = POLICY_ORDERINGS[key];
    if (order.indexOf(next[key]) < order.indexOf(current[key])) {
      loosened.push({ key, label, from: choiceLabel(key, current[key]), to: choiceLabel(key, next[key]) });
    }
  }
  if (next.aiMonthlyCapCentsPerPrincipal > current.aiMonthlyCapCentsPerPrincipal) {
    loosened.push({
      key: "aiMonthlyCapCentsPerPrincipal",
      label: MONTHLY_CAP.label,
      from: formatCents(current.aiMonthlyCapCentsPerPrincipal),
      to: formatCents(next.aiMonthlyCapCentsPerPrincipal),
    });
  }
  return loosened;
}
