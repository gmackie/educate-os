import { useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Plug } from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo'
import { ThemeModeButton } from '@gadgets/ui/theme'
import UserMenu from '../UserMenu'

// The theme control is the shared one (@gadgets/ui/theme), so the Workshop's toggle and the school
// shell's stay in step: one ThemeProvider, one stored choice. It reports the mode it switched to
// here, for this strip's own live region.
function ThemeToggle() {
  const [announcement, setAnnouncement] = useState('')
  return (
    <>
      <ThemeModeButton onAnnounce={setAnnouncement} />
      <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
    </>
  )
}

// Bottom strip on the sidebar: tiny iconography for connections, theme, and the user menu. Mirrors
// the very low-chrome bottom row in the reference design and surfaces Profile / Providers / Admin
// from the user-menu dropdown rather than duplicating them as separate icons.
function StripLink({
  to,
  label,
  children,
}: {
  to: '/gatekeepers'
  label: string
  children: React.ReactNode
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = pathname === to
  return (
    <Tooltip content={label}>
      <Link
        to={to}
        aria-label={label}
        className={[
          'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-kumo-fill text-kumo-brand'
            : 'text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default',
        ].join(' ')}
      >
        {children}
      </Link>
    </Tooltip>
  )
}

export default function SidebarUtilityStrip({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div
      className={[
        // shrink-0 + solid base so the strip is visually pinned above the scrolling rail body
        // and content can't bleed through it. Flat treatment — no top shadow.
        'shrink-0 flex items-center gap-1 border-t border-kumo-line bg-kumo-elevated px-3 py-2',
        collapsed ? 'flex-col justify-center gap-2 px-1.5' : '',
      ].join(' ')}
    >
      <StripLink to="/gatekeepers" label="Gatekeepers">
        <Plug size={15} />
      </StripLink>
      <div className={collapsed ? 'flex flex-col items-center gap-2' : 'ml-auto flex items-center gap-1'}>
        <ThemeToggle />
        <UserMenu />
      </div>
    </div>
  )
}
