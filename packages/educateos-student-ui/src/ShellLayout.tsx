// The Learning Home's frame on the district origin (SCHO-260): the shared SchoolShell, with the
// navigation for whoever signed in. The student UI is served at the origin's root, so teachers and
// administrators land here too for the pages every role shares (Your devices, Connect phone), and
// get their own role's navigation while they do.
import type { ReactNode } from "react";
import { Link } from "@cloudflare/kumo";
import { GearIcon } from "@phosphor-icons/react";
import { useRouterState } from "@tanstack/react-router";
import type { RouteResponse } from "@educateos/api-client";
import { SchoolShell, navigationFor, shellRoleOf, type NavGroup, type ShellFeatures, type ShellRole } from "@educateos/shell";
import { useAnnounce, useEmbedding } from "./AppContext.tsx";
import { NotificationsLink } from "./communication/NotificationsLink.tsx";
import type { Audience } from "./Layout.tsx";
import { AppLink, FAMILY_SETTINGS_PATH, isFamilyPath } from "./router.tsx";
import type { DistrictShell } from "./shell.tsx";
import { SignOut } from "./SignOut.tsx";

type Me = RouteResponse<"me.get">;

/**
 * A guardian's places. The Learning Home takes a guardian from every other path to the family view
 * (ADR-0012), so the role's Calendar and Inbox would only bounce back there: they are left out until
 * the family view has its own.
 */
export const guardianNavigation = (features: ShellFeatures): NavGroup[] =>
  navigationFor("guardian", features)
    .map((group) => ({ ...group, items: group.items.filter((item) => isFamilyPath(item.href) || item.id === "ai") }))
    .filter((group) => group.items.length > 0);

/** The shell role for whoever is signed in. */
const roleOf = (me: Me | undefined): ShellRole | undefined => (me === undefined ? undefined : shellRoleOf(me));

export const ShellLayout = ({ shell, me, audience, children }: { shell: DistrictShell; me: Me | undefined; audience: Audience | undefined; children: ReactNode }) => {
  const announce = useAnnounce();
  const embedded = useEmbedding() !== undefined;
  // The location the rendered screen belongs to, so the current entry follows the router.
  const pathname = useRouterState({ select: (state) => (state.resolvedLocation ?? state.location).pathname });
  const hash = useRouterState({ select: (state) => (state.resolvedLocation ?? state.location).hash });
  const role = roleOf(me);
  const features: ShellFeatures = { ai: shell.school.features.ai };
  return (
    <SchoolShell
      school={shell.school}
      role={role}
      user={me === undefined ? undefined : { name: me.displayName }}
      features={features}
      {...(role === "guardian" ? { navigation: guardianNavigation(features) } : {})}
      location={{ pathname, hash: hash === "" ? "" : `#${hash}` }}
      account={{ signOut: role === undefined || embedded ? null : <SignOut /> }}
      renderLink={(props) => <AppLink {...props} />}
      onAnnounce={announce}
      headerActions={
        audience === undefined ? undefined : (
          <>
            {audience === "student" ? <NotificationsLink /> : null}
            <Link href={audience === "student" ? "/settings" : FAMILY_SETTINGS_PATH} variant="plain" className="flex items-center py-2" aria-label="Settings">
              <GearIcon aria-hidden size={20} />
            </Link>
          </>
        )
      }
    >
      {children}
    </SchoolShell>
  );
};
