// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchoolManifest } from '@educateos/shell'
import { ThemeProvider, storedThemeMode } from '@gadgets/ui/theme'

vi.mock('@tanstack/react-router', () => ({ useRouterState: () => '/ai/' }))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ currentUser: { id: 'u', name: 'Workshop Name' } }) }))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => ({ accentColor: '#ff4801' }) }))

import {
  DistrictFrame,
  fallbackDistrictNavigation,
  loadDistrictPrincipal,
  parseDistrictPrincipal,
  resetDistrictFrame,
  startDistrictFrame,
  useDistrictFrame,
  type DistrictPrincipal,
} from './districtFrame'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NORTHFIELD: SchoolManifest = {
  v: 1,
  name: 'Northfield',
  origin: 'https://northfield.educateos.io',
  brand: { accent: '#2458ac' },
  signIn: [],
  features: { ai: true, mobile: false, family: false },
}

const ready = (manifest: SchoolManifest) => async () => ({ status: 'ready' as const, manifest })

function setWide() {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

let mounted: { root: Root; container: HTMLElement } | undefined
const noAnswer = () => {}

function mount(node: React.ReactNode) {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  mounted = { root, container }
  act(() => root.render(node))
  return container
}

beforeEach(() => {
  setWide()
  window.history.replaceState(null, '', '/ai/')
})

afterEach(() => {
  if (mounted !== undefined) {
    act(() => mounted!.root.unmount())
    mounted.container.remove()
    mounted = undefined
  }
  resetDistrictFrame()
  document.documentElement.removeAttribute('style')
})

const State = () => <output>{useDistrictFrame().status}</output>

describe('whether the Workshop is framed', () => {
  it('is never framed at the root of its origin, and asks for no manifest', async () => {
    const load = vi.fn<ReturnType<typeof ready>>(ready(NORTHFIELD))
    const container = mount(<State />)
    await act(async () => startDistrictFrame('/', load))
    expect(load).not.toHaveBeenCalled()
    expect(container.textContent).toBe('off')
  })

  it('waits for the manifest on a district origin, then frames a district with AI', async () => {
    let answer: (value: Awaited<ReturnType<ReturnType<typeof ready>>>) => void = noAnswer
    const container = mount(<State />)
    act(() => startDistrictFrame('/ai/', () => new Promise((resolve) => { answer = resolve })))
    expect(container.textContent).toBe('pending')
    await act(async () => answer({ status: 'ready', manifest: NORTHFIELD }))
    expect(container.textContent).toBe('framed')
  })

  it('is not framed where the district has no AI, or has no usable manifest', async () => {
    const container = mount(<State />)
    await act(async () => startDistrictFrame('/ai/', ready({ ...NORTHFIELD, features: { ...NORTHFIELD.features, ai: false } })))
    expect(container.textContent).toBe('off')
    await act(async () => startDistrictFrame('/ai/', async () => ({
      status: 'fallback', manifest: NORTHFIELD, problem: 'unavailable',
    })))
    expect(container.textContent).toBe('off')
    await act(async () => startDistrictFrame('/ai/', async () => { throw new Error('offline') }))
    expect(container.textContent).toBe('off')
  })
})

describe('who the district says is signed in', () => {
  it('reads the role and name from /api/me', () => {
    expect(parseDistrictPrincipal({ kind: 'student', displayName: ' Ava Chen ', roles: [] }))
      .toEqual({ role: 'student', name: 'Ava Chen' })
    expect(parseDistrictPrincipal({ kind: 'staff', displayName: 'Ms Rivera', roles: [{ role: 'teacher' }] }))
      .toEqual({ role: 'teacher', name: 'Ms Rivera' })
    expect(parseDistrictPrincipal({ kind: 'staff', displayName: 'Dr Okafor', roles: [{ role: 'school-admin' }] }))
      .toEqual({ role: 'school-admin', name: 'Dr Okafor' })
    expect(parseDistrictPrincipal({ kind: 'alien' })).toBeUndefined()
    expect(parseDistrictPrincipal('nope')).toBeUndefined()
  })

  it('asks on this origin with the page’s session, and takes a redirect to sign-in as not knowing', async () => {
    const fetchImpl = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 302, headers: { location: '/cdn-cgi/access/login' } }))
    expect(await loadDistrictPrincipal(fetchImpl)).toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/me', expect.objectContaining({ credentials: 'same-origin', redirect: 'manual' }))
    expect(await loadDistrictPrincipal(async () => { throw new TypeError('offline') })).toBeUndefined()
  })
})

const frame = (loadPrincipal: () => Promise<DistrictPrincipal | undefined>) => mount(
  <ThemeProvider source={storedThemeMode('educateos:theme-mode')}>
    <DistrictFrame manifest={NORTHFIELD} loadPrincipal={loadPrincipal} base="/ai/">
      <main>Workshop threads</main>
    </DistrictFrame>
  </ThemeProvider>,
)

const navLinks = (container: HTMLElement) =>
  [...container.querySelectorAll('nav[aria-label="Main"] a')].map((link) => ({
    label: link.querySelector('span')?.textContent,
    href: link.getAttribute('href'),
    current: link.getAttribute('aria-current'),
  }))

describe('DistrictFrame', () => {
  it("draws the school's frame around the Workshop with the role's navigation, AI workspace current", async () => {
    const container = frame(async () => ({ role: 'student', name: 'Ava Chen' }))
    await act(async () => {})
    expect(container.querySelector('[data-content="fill"]')).not.toBeNull()
    expect(container.textContent).toContain('Northfield')
    expect(container.textContent).toContain('Ava Chen')
    expect(container.textContent).toContain('Workshop threads')
    expect(container.querySelectorAll('main')).toHaveLength(1)
    const links = navLinks(container)
    expect(links.map((link) => link.label)).toEqual(['Home', 'Classes', 'Calendar', 'Inbox', 'Grades', 'AI workspace', 'My Space'])
    expect(links.filter((link) => link.current === 'page').map((link) => link.label)).toEqual(['AI workspace'])
    // The school's accent is in force, not the Workshop's.
    expect(document.documentElement.style.getPropertyValue('--color-kumo-brand')).toContain('#2458ac')
  })

  it("offers the minimal links back to the school when the district can't say who this is", async () => {
    const container = frame(async () => undefined)
    await act(async () => {})
    expect(container.textContent).toContain('Back to Northfield')
    expect(container.textContent).toContain('Workshop Name')
    expect(navLinks(container)).toEqual([
      { label: 'Home', href: '/', current: null },
      { label: 'Classes', href: '/#my-courses', current: null },
      { label: 'Calendar', href: '/calendar', current: null },
      { label: 'Inbox', href: '/notifications', current: null },
      { label: 'AI workspace', href: '/ai/', current: 'page' },
    ])
  })

  it('offers no places while the district is still answering', () => {
    const container = frame(() => new Promise(() => {}))
    expect(navLinks(container)).toEqual([])
    expect(container.textContent).toContain('Workshop threads')
  })
})

describe('fallbackDistrictNavigation', () => {
  it('marks the AI workspace current anywhere under the mount', () => {
    const groups = fallbackDistrictNavigation(NORTHFIELD, '/ai/')
    const ai = groups.flatMap((group) => group.items).find((item) => item.id === 'ai')!
    expect(ai.active({ pathname: '/ai/workspace/abc', hash: '' })).toBe(true)
    expect(ai.active({ pathname: '/ai', hash: '' })).toBe(true)
    expect(ai.active({ pathname: '/aim', hash: '' })).toBe(false)
  })
})
