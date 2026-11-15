import { Link } from "@cloudflare/kumo";
import { useRouterState } from "@tanstack/react-router";
import { HOME_PATH, HOME_SETTINGS_PATH, LIBRARY_PATH, PROGRESS_PATH, SHELF_PATH } from "./paths.ts";

const PLACES = [
  { href: HOME_PATH, label: "Today", current: (p: string) => p === HOME_PATH || p.endsWith("/plan") },
  { href: LIBRARY_PATH, label: "Library", current: (p: string) => p === LIBRARY_PATH },
  { href: PROGRESS_PATH, label: "Progress", current: (p: string) => p === PROGRESS_PATH || p.includes("/progress") || p.includes("/sessions/") },
  { href: SHELF_PATH, label: "Shelf", current: (p: string) => p === SHELF_PATH },
  { href: HOME_SETTINGS_PATH, label: "Children and PIN", current: (p: string) => p === HOME_SETTINGS_PATH },
] as const;

/** Home learning's own places, under the family view. */
export const HomeLearningNav = () => {
  const pathname = useRouterState({ select: (state) => (state.resolvedLocation ?? state.location).pathname });
  return (
    <nav aria-label="Home learning" className="flex flex-wrap gap-2 border-b border-kumo-hairline pb-3">
      {PLACES.map((place) => {
        const current = place.current(pathname);
        return (
          <Link
            key={place.href}
            href={place.href}
            variant="plain"
            aria-current={current ? "page" : undefined}
            className={`rounded-full px-4 py-2 ${current ? "bg-kumo-tint font-semibold" : ""}`}
          >
            {place.label}
          </Link>
        );
      })}
    </nav>
  );
};
