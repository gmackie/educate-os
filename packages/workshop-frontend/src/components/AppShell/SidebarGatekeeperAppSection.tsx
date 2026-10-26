import { useId } from 'react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import type { GatekeeperAppNavEntry } from '@gadgets/workshop-shared/gatekeeper'
import GatekeeperAppIcon from './GatekeeperAppIcon'
import SidebarItem from './SidebarItem'

// Ungrouped entries first, then each group in the order its first entry appears.
function groupEntries(nav: GatekeeperAppNavEntry[]) {
  const groups = new Map<string | undefined, GatekeeperAppNavEntry[]>([[undefined, []]])
  for (const entry of nav) {
    const entries = groups.get(entry.group) ?? []
    entries.push(entry)
    groups.set(entry.group, entries)
  }
  return [...groups].filter(([, entries]) => entries.length > 0)
}

/**
 * The sidebar section of a gatekeeper app that contributes entries (GatekeeperAppInfo.nav): a
 * heading drawn from the app's title, then the entries, each opening the app's page at its path.
 * Every link is built here from the app's id, so an entry can lead only into its own app.
 */
const SidebarGatekeeperAppSection = ({ app, nav }: {
  app: GatekeeperAppInfo
  nav: GatekeeperAppNavEntry[]
}) => {
  const id = useId()
  return (
    <nav aria-labelledby={`${id}-app`} className="mt-3 flex flex-col px-2">
      <h2
        id={`${id}-app`}
        className="flex h-6 items-center gap-1.5 px-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-kumo-inactive"
      >
        <GatekeeperAppIcon icon={app.icon} />
        <span className="truncate">{app.title}</span>
      </h2>
      {groupEntries(nav).map(([group, entries], index) => (
        <div
          key={group ?? ''}
          role={group === undefined ? undefined : 'group'}
          aria-labelledby={group === undefined ? undefined : `${id}-${index}`}
          className="mt-0.5 flex flex-col gap-0.5"
        >
          {group !== undefined && (
            <h3 id={`${id}-${index}`} className="truncate px-2.5 pt-1.5 text-[12px] leading-4 text-kumo-subtle">
              {group}
            </h3>
          )}
          {entries.map((entry, entryIndex) => (
            <SidebarItem
              // Paths need not be unique, and the list is replaced wholesale when it changes.
              key={entryIndex}
              to="/gatekeepers/$appId"
              params={{ appId: app.id }}
              search={{ path: entry.path }}
              label={entry.label}
              icon={<span aria-hidden className="h-1 w-1 rounded-full bg-current" />}
            />
          ))}
        </div>
      ))}
    </nav>
  )
}

export default SidebarGatekeeperAppSection
