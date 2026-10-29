import { Link } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { SchoolNavigation } from '@educateos/shell'
import {
  ArrowLeft,
  Blueprint,
  Compass,
  GraduationCap,
  Hexagon,
  House,
  MagnifyingGlass,
  SidebarSimple,
  SquaresFour,
  Stack,
} from '@phosphor-icons/react'
import { useSiteName } from '../../ServerConfigContext'
import SiteLogo from '../SiteLogo'
import { useGatekeeperApps } from '../../useGatekeeperApps'
import { openCommandPalette } from './commandPaletteBus'
import SidebarItem from './SidebarItem'
import GatekeeperAppIcon from './GatekeeperAppIcon'
import SidebarGatekeeperAppSection from './SidebarGatekeeperAppSection'
import {
  SidebarWorkspacesProvider,
  SidebarWorkspacesTools,
  SidebarWorkspacesLists,
} from './SidebarWorkspaces'
import SidebarUtilityStrip from './SidebarUtilityStrip'
import { inNativeApp, returnToInstalls } from '../../features/native-app/nativeApp'
import { useDistrictSidebar } from '../../features/district-frame/districtFrame'

/**
 * The persistent left rail. Three pinned regions sandwich a single scrolling region of lists, so
 * the user can always reach Search, primary nav, and the bottom utility strip no matter how many
 * workspaces they have.
 *
 * Layout (top → bottom):
 *   • brand row                            pinned
 *   • search and AI destinations           pinned
 *   • school destinations and app sections SCROLLS
 *   • Favorites / Recent workspaces        SCROLLS
 *   • utility strip (plug, avatar)         pinned
 */
export default function Sidebar({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const workshopName = useSiteName()
  const district = useDistrictSidebar()
  const siteName = district?.school.name ?? workshopName
  const brand = (
    <>
      <SiteLogo size={24} className="shrink-0" srcOverride={district ? district.school.brand.logo ?? null : undefined}>
        {district
          ? <GraduationCap size={24} weight="duotone" className="text-kumo-brand shrink-0" />
          : <Hexagon size={24} weight="bold" className="text-kumo-brand shrink-0" />}
      </SiteLogo>
      {!collapsed && (
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-kumo-default">{siteName}</span>
          {district && <span className="block text-xs text-kumo-subtle">Learning & AI</span>}
        </span>
      )}
    </>
  )
  // Gatekeeper-served management apps the user can reach now (one per gatekeeper that provides a UI
  // and is connected / enabled for everyone). Disabled or not-yet-connected ones aren't returned, so
  // they simply don't appear. The set is fully dynamic — no gatekeeper is hardcoded.
  const gatekeeperApps = useGatekeeperApps()
  // An app that contributes entries gets its own section in the scrolling region; collapsed, where
  // there is no room for labels, it is one icon row like any other app.
  const appSections = collapsed ? [] : gatekeeperApps.filter((app) => app.nav?.length)
  const appRows = gatekeeperApps.filter((app) => !appSections.includes(app))
  // AI home already opens the workspace; keep the school groups focused on school destinations.
  const schoolNavigation = district?.navigation.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.id !== 'ai'),
  }))

  return (
    <aside
      aria-label="Primary"
      className={[
        'flex h-full flex-col border-r border-kumo-line bg-kumo-elevated',
        collapsed ? 'w-[56px]' : 'w-[min(320px,100vw)] md:w-[272px]',
        'shrink-0 transition-[width] duration-200 ease-out',
      ].join(' ')}
    >
      {/* Brand row */}
      <div
        className={[
          'flex h-14 shrink-0 items-center border-b border-kumo-line',
          collapsed ? 'justify-center px-1.5' : 'justify-between gap-2 px-3',
        ].join(' ')}
      >
        {district ? (
          <a href={district.navigation[0]?.items[0]?.href ?? '/'} aria-label={siteName} className="flex min-w-0 items-center gap-2">{brand}</a>
        ) : (
          <Link to="/" aria-label={siteName} className="flex min-w-0 items-center gap-2">{brand}</Link>
        )}
        {!collapsed && (
            <Button
              variant="ghost"
              shape="square"
              type="button"
              onClick={onToggleCollapsed}
              aria-label="Collapse sidebar"
              className="shrink-0"
            >
              <SidebarSimple size={18} aria-hidden="true" />
            </Button>
        )}
      </div>

      {/* Expand affordance when collapsed — placed just under the logo for discoverability. */}
      {collapsed && (
        <Button
          variant="ghost"
          shape="square"
          type="button"
          onClick={onToggleCollapsed}
          aria-label="Expand sidebar"
          className="mx-auto mt-2 shrink-0"
        >
          <SidebarSimple size={18} className="rotate-180" aria-hidden="true" />
        </Button>
      )}

      <SidebarWorkspacesProvider>
        {/* Pinned top stack. shrink-0 keeps it from squishing when the lists below grow. */}
        <div className="flex shrink-0 flex-col gap-3 pt-3">
          {!collapsed && <div className="px-3">
            <Button
              variant="secondary"
              type="button"
              onClick={() => openCommandPalette()}
              aria-label="Search"
              className="h-11 w-full justify-start gap-2 md:h-9"
            >
              <MagnifyingGlass size={16} aria-hidden="true" />
              <span className="flex-1 text-left text-sm">Search workspaces</span>
              <kbd className="text-xs text-kumo-subtle" aria-hidden="true">⌘K</kbd>
            </Button>
          </div>}
          {/* Primary nav */}
          <nav aria-label="AI workspace" className="flex flex-col gap-0.5 px-2">
            {district && !collapsed && <p className="px-2.5 pb-2 text-xs font-medium text-kumo-subtle">Create & explore</p>}
            <SidebarItem
              to="/"
              label={district ? 'AI home' : 'Home'}
              icon={<House size={18} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/workspaces"
              label="Workspaces"
              icon={<SquaresFour size={18} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/blueprints"
              label="Blueprints"
              icon={<Blueprint size={18} weight="regular" />}
              collapsed={collapsed}
            />
            <SidebarItem
              to="/outputs"
              label="Outputs"
              icon={<Stack size={18} weight="regular" />}
              collapsed={collapsed}
            />
            {/* Gatekeeper management apps (e.g. the Context Library), listed dynamically. */}
            {appRows.map((app) => (
              <SidebarItem
                key={app.id}
                to="/gatekeepers/$appId"
                params={{ appId: app.id }}
                label={app.title}
                icon={<GatekeeperAppIcon icon={app.icon} />}
                collapsed={collapsed}
              />
            ))}
            <SidebarItem
              to="/explore"
              label="Explore"
              icon={<Compass size={18} weight="regular" />}
              collapsed={collapsed}
            />
          </nav>

          {/* Workspace tools: search. Pinned so it's always reachable. */}
          <SidebarWorkspacesTools collapsed={collapsed} />
        </div>

        {/* School destinations share the workspace list's scroll area so long role menus cannot
            push the pinned search and account controls out of reach. */}
        <div className="sidebar-scroll mt-1 min-h-0 flex-1 overflow-y-auto">
          {district && (
            <div className="border-b border-kumo-line px-2 py-3 text-sm">
              {!collapsed && <p className="px-2 pb-3 text-xs font-medium text-kumo-subtle">Your school</p>}
              <SchoolNavigation groups={schoolNavigation ?? []} location={district.location} collapsed={collapsed} />
            </div>
          )}
          {appSections.map((app) => (
            <SidebarGatekeeperAppSection key={app.id} app={app} nav={app.nav ?? []} />
          ))}
          <SidebarWorkspacesLists collapsed={collapsed} />
        </div>
      </SidebarWorkspacesProvider>

      <SidebarUtilityStrip collapsed={collapsed} />
      {inNativeApp() && (
        <Button
          variant="ghost"
          type="button"
          onClick={returnToInstalls}
          aria-label="Back to installs"
          className={[
            'flex min-h-11 shrink-0 items-center border-t border-kumo-line py-2 text-sm text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
            collapsed ? 'justify-center px-2' : 'gap-2 px-4',
          ].join(' ')}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {!collapsed && 'Back to installs'}
        </Button>
      )}
    </aside>
  )
}
