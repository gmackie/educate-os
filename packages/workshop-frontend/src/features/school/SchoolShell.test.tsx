// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SchoolShell } from './SchoolShell'

const state = vi.hoisted(() => ({
  api: { getWorkshopAuthoringCapability: vi.fn<() => Promise<{ allowed: boolean }>>(), amIAdmin: vi.fn<() => Promise<boolean>>(), listGatekeeperApps: vi.fn<() => Promise<GatekeeperAppInfo[]>>() }, pathname: '/',
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: state.api, logout: vi.fn<() => void>() }) }))
vi.mock('@tanstack/react-router', () => ({
  useRouterState: () => state.pathname,
  Link: ({ children, search, onClick, ...props }: any) => <a href={`?path=${search?.path ?? ''}`} onClick={(event) => { event.preventDefault(); onClick?.(event) }} aria-current={props['aria-current']}>{children}</a>,
}))
vi.mock('../../components/AppShell/AppShell', () => ({ default: () => <div>Creator controls</div> }))
vi.mock('../../components/AppShell/SidebarGatekeeperAppSection', () => ({ default: ({ nav }: any) => <nav aria-label="School pages">{nav.map((entry: any) => <span key={entry.path}>{entry.label}</span>)}</nav> }))

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const originalApi = state.api
let root: ReturnType<typeof createRoot> | undefined
let container: HTMLDivElement
const render = async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<SchoolShell><div>School screens</div></SchoolShell>))
}
beforeEach(() => { state.api.getWorkshopAuthoringCapability.mockResolvedValue({ allowed: false }) })
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.resetAllMocks(); state.pathname = '/'; state.api = originalApi })
describe('SchoolShell', () => {
  it('provides onboarding and an accessible disconnected fallback without creator controls', async () => {
    state.api.amIAdmin.mockResolvedValue(false)
    state.api.listGatekeeperApps.mockRejectedValue(new Error('offline'))
    await render()
    expect(container.querySelector('h1')?.textContent).toBe('Welcome to your school')
    expect([...container.querySelectorAll('[role="status"]')].some((status) => status.textContent?.includes('disconnected'))).toBe(true)
    expect(container.querySelector('a[href="#school-content"]')).not.toBeNull()
    expect(container.querySelector('main')?.id).toBe('school-content')
    expect(container.textContent).not.toContain('Advanced Workshop')
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Check connection')!
    await act(async () => retry.click())
    expect(state.api.listGatekeeperApps).toHaveBeenCalledTimes(2)
  })
  it('shows student pages without arbitrary Workshop routes or provider controls', async () => {
    state.api.amIAdmin.mockResolvedValue(false)
    state.api.listGatekeeperApps.mockResolvedValue([{ id: 'educateos', title: 'School', nav: [
      { label: 'Learning Home', path: '/learn' }, { label: 'Math', path: '/learn/courses/math' },
    ] }])
    state.pathname = '/settings'
    await render()
    expect(container.textContent).toContain('Math')
    expect(container.textContent).not.toContain('School screens')
    expect(container.textContent).not.toContain('Creator controls')
    expect(container.querySelector('[aria-current="true"]')?.textContent).toBe('Student')
    state.pathname = '/gatekeepers/educateos'
    await act(async () => root!.render(<SchoolShell><div>School screens</div></SchoolShell>))
    expect(container.textContent).toContain('School screens')
  })
  it('switches only among offered views without granting Workshop creator access', async () => {
    state.api.amIAdmin.mockResolvedValue(false)
    state.api.listGatekeeperApps.mockResolvedValue([{ id: 'educateos', title: 'School', nav: [
      { label: 'Teacher Studio', path: '/teach' }, { label: 'Class roster', path: '/teach/classes/one/roster' },
      { label: 'Administration', path: '/admin' }, { label: 'District school', path: '/schools/one' },
    ] }])
    await render()
    expect(container.textContent).toContain('Class roster')
    expect(container.textContent).not.toContain('District school')
    const admin = [...container.querySelectorAll('a')].find((link) => link.textContent === 'Administrator')!
    await act(async () => admin.click())
    expect(container.textContent).toContain('District school')
    expect(container.textContent).not.toContain('Class roster')
    expect(container.textContent).not.toContain('Advanced Workshop')
  })
  it('opens existing family screens for guardians', async () => {
    state.api.amIAdmin.mockResolvedValue(false)
    state.api.listGatekeeperApps.mockResolvedValue([{ id: 'educateos', title: 'School', nav: [
      { label: 'Family', path: '/learn/family' },
      { label: 'My child', path: '/learn/family/children/one' },
    ] }])
    state.pathname = '/gatekeepers/educateos'
    await render()
    expect(container.querySelector('[aria-current="true"]')?.textContent).toBe('Guardian')
    expect(container.textContent).toContain('My child')
    expect(container.textContent).toContain('School screens')
  })
  it('clears Advanced Workshop across session switches, even for another admin', async () => {
    state.api.amIAdmin.mockResolvedValue(true)
    state.api.listGatekeeperApps.mockResolvedValue([])
    await render()
    const advanced = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Advanced Workshop')!
    await act(async () => advanced.click())
    expect(container.textContent).toContain('Creator controls')
    state.api = { getWorkshopAuthoringCapability: vi.fn<() => Promise<{ allowed: boolean }>>().mockResolvedValue({ allowed: false }), amIAdmin: vi.fn<() => Promise<boolean>>().mockResolvedValue(true), listGatekeeperApps: vi.fn<() => Promise<GatekeeperAppInfo[]>>().mockResolvedValue([]) }
    await act(async () => root!.render(<SchoolShell><div>School screens</div></SchoolShell>))
    expect(container.textContent).not.toContain('Creator controls')
    expect(container.textContent).toContain('Gadget creation and Blueprint adaptation are not available')
  })
  it('keeps policy-approved school authoring conservative without provider controls', async () => {
    state.api.amIAdmin.mockResolvedValue(false)
    state.api.listGatekeeperApps.mockResolvedValue([])
    state.api.getWorkshopAuthoringCapability.mockResolvedValue({ allowed: true })
    await render()
    expect(state.api.getWorkshopAuthoringCapability).toHaveBeenCalledWith({ operation: 'create' })
    expect(container.textContent).toContain('Your district has approved authoring')
    expect(container.textContent).not.toContain('Creator controls')
    expect(container.textContent).not.toContain('Advanced Workshop')
    expect(container.querySelector('textarea')).toBeNull()
  })
  it('ignores a previous session discovery allow after switching to a denied student', async () => {
    let resolve!: (value: { allowed: boolean }) => void
    state.api.amIAdmin.mockResolvedValue(false)
    state.api.listGatekeeperApps.mockResolvedValue([])
    state.api.getWorkshopAuthoringCapability.mockReturnValue(new Promise((done) => { resolve = done }))
    await render()
    state.api = {
      getWorkshopAuthoringCapability: vi.fn<() => Promise<{ allowed: boolean }>>().mockResolvedValue({ allowed: false }),
      amIAdmin: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
      listGatekeeperApps: vi.fn<() => Promise<GatekeeperAppInfo[]>>().mockResolvedValue([]),
    }
    await act(async () => root!.render(<SchoolShell><div>School screens</div></SchoolShell>))
    await act(async () => resolve({ allowed: true }))
    expect(container.textContent).not.toContain('Your district has approved authoring')
    expect(container.textContent).not.toContain('Creator controls')
    expect(container.textContent).not.toContain('Advanced Workshop')
  })
  it('keeps school authoring closed when discovery is unavailable', async () => {
    state.api.amIAdmin.mockResolvedValue(false)
    state.api.listGatekeeperApps.mockResolvedValue([])
    state.api.getWorkshopAuthoringCapability.mockRejectedValue(new Error('offline'))
    await render()
    expect(container.textContent).toContain('Gadget creation and Blueprint adaptation are not available')
    expect(container.textContent).not.toContain('Advanced Workshop')
  })
  it('requires backend creator confirmation to open Advanced Workshop', async () => {
    state.api.amIAdmin.mockResolvedValue(true)
    state.api.listGatekeeperApps.mockResolvedValue([])
    await render()
    const advanced = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Advanced Workshop')!
    await act(async () => advanced.click())
    expect(container.textContent).toContain('Creator controls')
    const back = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Return to School')!
    await act(async () => back.click())
    expect(container.textContent).toContain('Welcome to your school')
  })

})
