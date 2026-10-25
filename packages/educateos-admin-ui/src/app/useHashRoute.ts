import { useSyncExternalStore } from "react";

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

const subscribe = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

const current = (): ScreenPath => {
  const path = window.location.hash.replace(/^#\/?/, "");
  return SCREENS.find((screen) => screen.path === path)?.path ?? "dashboard";
};

/** The screen the location's hash names, so links, history and reloads all work. */
export const useHashRoute = (): ScreenPath => useSyncExternalStore(subscribe, current, () => "dashboard");
