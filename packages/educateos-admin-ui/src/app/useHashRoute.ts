import { useSyncExternalStore } from "react";
import { readHash, subscribeToHash } from "@gadgets/ui/hash-location";

/** The console's screens, in navigation order. */
export const SCREENS = [
  { path: "dashboard", label: "Dashboard" },
  { path: "roster", label: "Roster" },
  { path: "classes", label: "All classes" },
  { path: "classes-people", label: "Manage classes and people" },
  { path: "guardians", label: "Guardians" },
  { path: "modules", label: "Modules and activation" },
  { path: "learning-standards", label: "Learning standards" },
  { path: "policies", label: "Policies" },
  { path: "ai-usage", label: "AI usage" },
  { path: "ai-budgets", label: "AI budgets" },
  { path: "term-rollover", label: "Term rollover" },
] as const;

/** A screen's path. */
export type ScreenPath = (typeof SCREENS)[number]["path"];

const current = (): ScreenPath => {
  const path = readHash().replace(/^#\/?/, "");
  return SCREENS.find((screen) => screen.path === path)?.path ?? "dashboard";
};

/** The screen the location's hash names, so links, history and reloads all work. */
export const useHashRoute = (): ScreenPath => useSyncExternalStore(subscribeToHash, current, () => "dashboard");

const SCHOOL_HASH = /^#\/schools\/([^/]+)\/?$/;

const currentSchool = (): string | undefined => {
  const id = SCHOOL_HASH.exec(readHash())?.[1];
  return id === undefined ? undefined : decodeURIComponent(id);
};

/** Where one school's page lives. */
export const schoolHref = (schoolId: string): string => `#/schools/${encodeURIComponent(schoolId)}`;

/** The school whose page the hash names (SCHO-218), or undefined on any other screen. */
export const useSchoolRoute = (): string | undefined => useSyncExternalStore(subscribeToHash, currentSchool, () => undefined);
