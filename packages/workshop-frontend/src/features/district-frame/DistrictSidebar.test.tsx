// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { TooltipProvider } from '@cloudflare/kumo'
import { ThemeProvider, storedThemeMode } from '@gadgets/ui/theme'
import type { SchoolManifest } from '@educateos/shell'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppShell from '../../components/AppShell/AppShell'
import { DistrictFrame, type DistrictPrincipal } from './districtFrame'

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ currentUser: { id: 'u', name: 'Workshop Name' }, isAdmin: false }),
}))
vi.mock('../../ServerConfigContext', () => ({
  useServerConfig: () => ({ siteName: 'Workshop' }),
  useSiteName: () => 'Workshop',
}))
vi.mock('../../RpcContext', () => ({ useConnectionLost: () => false }))
vi.mock('../../TopBarNotice', () => ({ default: () => null }))
vi.mock('../../useGatekeeperApps', () => ({ useGatekeeperApps: () => [] }))
vi.mock('../../useAvatar', () => ({ useAvatar: () => undefined }))
vi.mock('../../components/AppShell/CommandPalette', () => ({ default: () => null }))
vi.mock('../../components/AppShell/SidebarWorkspaces', () => ({
  SidebarWorkspacesProvider: ({ children }: { children: ReactNode }) => children,
  SidebarWorkspacesTools: () => null,
  SidebarWorkspacesLists: () => <div>Recent workspace: Algebra project</div>,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SCHOOL: SchoolManifest = {
  v: 1,
  name: 'Northfield',
  origin: 'https://northfield.educateos.io',
  brand: { logo: '/brand/logo.svg' },
  signIn: [],
  features: { ai: true, mobile: true, family: false },
}

let root: Root | undefined
let container: HTMLDivElement

beforeEach(() => {
  localStorage.clear()
  window.scrollTo = vi.fn<() => void>()
  window.history.replaceState(null, '', '/ai/')
  window.matchMedia = ((media: string) => ({
    matches: media.includes('min-width'), media,
    addEventListener: () => {}, removeEventListener: () => {},
    onchange: null, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

const render = async (
  loadPrincipal: () => Promise<DistrictPrincipal | undefined> = async () => ({ role: 'student', name: 'Ava Chen' }),
  school: SchoolManifest = SCHOOL,
) => {
  const rootRoute = createRootRoute({
    component: () => (
      <ThemeProvider source={storedThemeMode('educateos:theme-mode')}>
        <TooltipProvider>
          <DistrictFrame manifest={school} loadPrincipal={loadPrincipal} base="/ai/">
            <AppShell><Outlet /></AppShell>
          </DistrictFrame>
        </TooltipProvider>
      </ThemeProvider>
    ),
  })
  const index = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <p>AI conversation</p> })
  const workspaces = createRoute({ getParentRoute: () => rootRoute, path: '/workspaces', component: () => <p>All workspaces</p> })
  const router = createRouter({
    basepath: '/ai',
    history: createMemoryHistory({ initialEntries: ['/ai/'] }),
    routeTree: rootRoute.addChildren([index, workspaces]),
  })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(<RouterProvider router={router} />))
  return router
}

const button = (name: string) => [...container.querySelectorAll('button')].find((element) => element.getAttribute('aria-label') === name)!
const schoolLinks = (scope: Element) => [...scope.querySelectorAll('nav[aria-label="Main"] a')]

describe('the district AI sidebar', () => {
  it('places school navigation and workspaces in the same sidebar with one brand and theme control', async () => {
    await render()
    const sidebar = container.querySelector('aside[aria-label="Primary"]')!
    expect(schoolLinks(sidebar).map((link) => link.textContent)).toContain('Classes')
    expect(sidebar.textContent).toContain('Algebra project')
    expect(container.querySelectorAll('nav[aria-label="Main"]')).toHaveLength(1)
    expect(container.querySelectorAll('a[aria-label="Northfield"]')).toHaveLength(1)
    expect(container.querySelectorAll('a[aria-label="Northfield"] img')).toHaveLength(1)
    expect(container.querySelectorAll('button[aria-label^="Theme:"]')).toHaveLength(1)
    expect(container.querySelectorAll('main')).toHaveLength(1)
    expect(container.querySelector('main')?.textContent).toBe('AI conversation')
    const skip = container.querySelector<HTMLAnchorElement>('a[href="#workshop-main"]')!
    act(() => skip.click())
    expect(document.activeElement).toBe(container.querySelector('main'))
  })

  it('keeps school destinations named and reachable when the shared sidebar collapses', async () => {
    await render()
    act(() => button('Collapse sidebar').click())
    const sidebar = container.querySelector('aside[aria-label="Primary"]')!
    expect(schoolLinks(sidebar).find((link) => link.getAttribute('href') === '/#my-courses')?.textContent).toContain('Classes')
    expect(button('Expand sidebar')).toBeDefined()
    act(() => button('Expand sidebar').click())
    expect(schoolLinks(sidebar).find((link) => link.getAttribute('aria-current') === 'page')?.textContent).toBe('AI workspace')
  })

  it('uses one mobile drawer for school and AI navigation and closes it on navigation and Escape', async () => {
    const router = await render()
    expect([...container.querySelectorAll('button')].filter((element) => element.getAttribute('aria-label') === 'Open menu')).toHaveLength(1)
    act(() => button('Open menu').click())
    const drawer = container.querySelector('[role="dialog"][aria-label="Primary navigation"]')!
    expect(schoolLinks(drawer).map((link) => link.textContent)).toContain('Classes')
    expect(drawer.textContent).toContain('Workspaces')
    const focusable = [...drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')]
    act(() => {
      focusable[focusable.length - 1].focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(focusable[0])
    await act(async () => { await router.navigate({ to: '/workspaces' }) })
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    act(() => button('Open menu').click())
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('keeps phone and device links in the existing profile menu, with school identity', async () => {
    await render()
    await act(async () => button('Open profile menu').click())
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain('Ava Chen')
    expect(menu.textContent).toContain('Student')
    expect(menu.querySelector('a[href="/devices/connect"]')?.textContent).toBe('Connect phone')
    expect(menu.querySelector('a[href="/devices"]')?.textContent).toBe('Your devices')
    expect(menu.textContent).toContain('Profile')
    expect(menu.textContent).toContain('Providers')
    expect(menu.textContent).toContain('Sign out')
  })

  it('keeps fallback school links in the AI sidebar and hides device actions when mobile is disabled', async () => {
    await render(async () => undefined, { ...SCHOOL, features: { ...SCHOOL.features, mobile: false } })
    const sidebar = container.querySelector('aside[aria-label="Primary"]')!
    expect(schoolLinks(sidebar).map((link) => link.getAttribute('href'))).toEqual([
      '/', '/#my-courses', '/calendar', '/notifications', '/ai/',
    ])
    await act(async () => button('Open profile menu').click())
    expect(document.querySelector('[role="menu"]')?.textContent).toContain('Workshop Name')
    expect(document.querySelector('a[href="/devices/connect"]')).toBeNull()
    expect(document.querySelector('a[href="/devices"]')).toBeNull()
  })
})
