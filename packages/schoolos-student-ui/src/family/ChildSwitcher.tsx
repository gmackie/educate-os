import { Link } from "@cloudflare/kumo";
import type { RouteResponse } from "@schoolos/api-client";
import { childPath } from "../router.tsx";

/** A guardian's child, as the district lists them. */
export type Child = RouteResponse<"guardian.listChildren">[number];

/**
 * Moves between a guardian's children. A list of links, so it works with the keyboard and screen
 * readers as navigation does, with the child on screen marked as the current page. With one child
 * there is nothing to switch, and nothing is shown.
 */
export const ChildSwitcher = ({ family, currentId }: { family: readonly Child[]; currentId: string }) =>
  family.length < 2 ? null : (
    <nav aria-label="Your children">
      <ul className="flex flex-wrap gap-2">
        {family.map((child) => {
          const current = child.studentPrincipalId === currentId;
          return (
            <li key={child.studentPrincipalId}>
              <Link
                href={childPath(child.studentPrincipalId)}
                variant="plain"
                aria-current={current ? "page" : undefined}
                className={`block rounded-full border px-4 py-2 ${current ? "border-kumo-brand bg-kumo-tint font-semibold" : "border-kumo-hairline"}`}
              >
                {child.displayName}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
