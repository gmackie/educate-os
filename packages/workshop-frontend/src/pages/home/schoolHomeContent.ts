import type { ShellRole } from '@educateos/shell'
import {
  BookOpen,
  ChatsCircle,
  Compass,
  Lightbulb,
  ListChecks,
  PencilLine,
  Presentation,
  PuzzlePiece,
  type Icon,
} from '@phosphor-icons/react'

export type SchoolTaskSuggestion = {
  label: string
  description: string
  prompt: string
  icon: Icon
}

type SchoolHomeContent = {
  label: string
  title: string
  description: string
  suggestions: SchoolTaskSuggestion[]
}

const LEARNING_TOOL: SchoolTaskSuggestion = {
  label: 'Build a learning tool',
  description: 'Bring an idea to life with a quiz, explorer, or small app.',
  icon: PuzzlePiece,
  prompt: 'Help me build an interactive learning tool. Ask me what topic it should explore and who will use it, then help me create it.',
}

const STUDENT: SchoolHomeContent = {
  label: 'Learning companion',
  title: 'What are you curious about?',
  description: 'Explore a question, practice a skill, or turn an idea into something you can share.',
  suggestions: [
    {
      label: 'Understand a topic',
      description: 'Find a fresh explanation and connect the dots.',
      icon: Lightbulb,
      prompt: 'Help me understand a topic I am learning. Ask me what it is and what I already know, then explain it with an example and check my understanding.',
    },
    {
      label: 'Practice step by step',
      description: 'Try a question, get a hint, and build confidence.',
      icon: PencilLine,
      prompt: 'Help me practice a skill. Ask me what I am working on, then give me one question at a time. Let me try before offering a hint or explaining the answer.',
    },
    {
      label: 'Plan a project',
      description: 'Turn a big assignment into manageable next steps.',
      icon: ListChecks,
      prompt: 'Help me make a plan for a school project. Ask about the assignment, what I have done so far, and when it is due. Help me choose a manageable next step.',
    },
    LEARNING_TOOL,
  ],
}

const TEACHER: SchoolHomeContent = {
  label: 'Teaching companion',
  title: 'Make room for your next great lesson.',
  description: 'Plan learning experiences, adapt materials, and bring your classroom ideas to life.',
  suggestions: [
    {
      label: 'Plan a lesson',
      description: 'Start with a learning goal and shape the experience.',
      icon: BookOpen,
      prompt: 'Help me plan a lesson. Ask about the subject, grade level, learning goal, and time available. Include an opening, an activity, and a way to check understanding.',
    },
    {
      label: 'Create practice questions',
      description: 'Give learners another way to apply what they know.',
      icon: PencilLine,
      prompt: 'Help me create practice questions. Ask about the topic, grade level, and learning goal, then draft a mix of questions with explanations for the answers.',
    },
    {
      label: 'Adapt an activity',
      description: 'Offer different paths toward the same learning goal.',
      icon: PuzzlePiece,
      prompt: 'Help me adapt a learning activity. Ask me to describe the activity and the support learners need, then suggest scaffolds and extensions that preserve the learning goal.',
    },
    {
      label: 'Draft a family update',
      description: 'Share classroom learning in clear, welcoming language.',
      icon: ChatsCircle,
      prompt: 'Help me draft a family update about our classroom learning. Ask about the topic, key dates, and how families can take part. Create a welcoming draft for me to review.',
    },
  ],
}

const GUARDIAN: SchoolHomeContent = {
  label: 'Family learning',
  title: 'Support their next step.',
  description: 'Make sense of schoolwork, build a learning routine, or explore an interest together.',
  suggestions: [
    {
      label: 'Support homework',
      description: 'Find helpful questions and explanations to use together.',
      icon: BookOpen,
      prompt: 'Help me support my child with their homework. Ask about the topic and where they are stuck, then suggest questions and explanations that help them do their own thinking.',
    },
    {
      label: 'Build a learning routine',
      description: 'Make a practical plan that fits your family.',
      icon: ListChecks,
      prompt: 'Help me plan a manageable learning routine with my child. Ask about their goals, interests, and our available time, then suggest a flexible weekly plan.',
    },
    {
      label: 'Prepare for a teacher conversation',
      description: 'Organize your questions and what you want to share.',
      icon: ChatsCircle,
      prompt: 'Help me prepare for a conversation with my child\'s teacher. Ask what I want to discuss, then help me organize my observations and a few useful questions.',
    },
    {
      label: 'Explore an interest',
      description: 'Discover a hands-on activity to try together.',
      icon: Compass,
      prompt: 'Help me find a learning activity to do with my child. Ask about their interests, age range, and the time and materials we have, then suggest something we can explore together.',
    },
  ],
}

const ADMIN: SchoolHomeContent = {
  label: 'School planning',
  title: 'Good ideas start with a conversation.',
  description: 'Think through your next initiative, support your staff, and create resources for your school.',
  suggestions: [
    {
      label: 'Plan a school initiative',
      description: 'Connect a shared goal to practical next steps.',
      icon: ListChecks,
      prompt: 'Help me plan a school initiative. Ask about the goal, who needs to be involved, and the timeline. Draft milestones, open questions, and a way to evaluate progress.',
    },
    {
      label: 'Prepare for a staff meeting',
      description: 'Make room for discussion, decisions, and follow-through.',
      icon: Presentation,
      prompt: 'Help me prepare a school staff meeting. Ask about the purpose, audience, and time available, then draft an agenda with discussion questions and clear next steps.',
    },
    {
      label: 'Draft a school update',
      description: 'Help your community understand what comes next.',
      icon: ChatsCircle,
      prompt: 'Help me draft a school community update. Ask about the message, audience, and key dates. Create a clear and welcoming draft for me to review.',
    },
    LEARNING_TOOL,
  ],
}

const GENERAL: SchoolHomeContent = {
  label: 'Learn & create',
  title: 'Your next idea starts here.',
  description: 'Ask a question, explore a topic, or create something for your school day.',
  suggestions: [STUDENT.suggestions[0], STUDENT.suggestions[1], TEACHER.suggestions[0], LEARNING_TOOL],
}

const BY_ROLE: Record<ShellRole, SchoolHomeContent> = {
  student: STUDENT,
  teacher: TEACHER,
  guardian: GUARDIAN,
  'school-admin': ADMIN,
}

export const schoolHomeContent = (role: ShellRole | undefined): SchoolHomeContent =>
  role === undefined ? GENERAL : BY_ROLE[role]
