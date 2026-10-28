import type { Role, Tab } from './types.ts';

/** Five role-aware tabs (four for families). The calendar is an agenda in Today for students and teachers. */
export const TABS_BY_ROLE: Record<Role, Tab[]> = {
  student: ['today', 'classes', 'ai', 'inbox', 'me'],
  teacher: ['today', 'classes', 'review', 'ai', 'me'],
  guardian: ['family', 'agenda', 'inbox', 'me'],
};

/** The tabs a person sees: AI is hidden when the school's manifest says it has no AI workspace. */
export function tabsFor(role: Role, features?: { ai: boolean } | null): Tab[] {
  return TABS_BY_ROLE[role].filter((tab) => tab !== 'ai' || features?.ai !== false);
}

export function homeTab(role: Role): Tab {
  return TABS_BY_ROLE[role][0]!;
}
