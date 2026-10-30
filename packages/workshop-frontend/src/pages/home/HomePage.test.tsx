// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchoolManifest, ShellRole } from '@educateos/shell'
import { DistrictFrame, type DistrictPrincipal } from '../../features/district-frame/districtFrame'
import { clearPendingSchoolContext } from '../../features/school-context/schoolContext'
import { HomePage } from './HomePage'

const state = vi.hoisted(() => ({
  api: { listModels: async () => [], newGadget: vi.fn<() => never>() },
  navigate: vi.fn<(options: unknown) => void>(),
  addToast: vi.fn<(toast: unknown) => void>(),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => state.navigate,
  useRouterState: () => '/ai/',
}))
vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: state.addToast }),
}))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: state.api, currentUser: { id: 'u', name: 'Ava' } }),
}))
vi.mock('../../ServerConfigContext', () => ({ useServerConfig: () => undefined }))
vi.mock('../../features/chat/composer/ChatComposer', () => ({
  ChatComposer: ({ seedText }: { seedText?: string }) => <textarea aria-label="Prompt" value={seedText ?? ''} readOnly />,
}))
vi.mock('../../features/deployment-updates/UpdateAvailableNotice', () => ({ UpdateAvailableNotice: () => null }))
vi.mock('../../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))
vi.mock('./MeshBackground', () => ({ default: () => null }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SCHOOL: SchoolManifest = {
  v: 1, name: 'Northfield', origin: 'https://northfield.educateos.io', brand: {}, signIn: [],
  features: { ai: true, mobile: true, family: true },
}

let root: Root | undefined
let container: HTMLDivElement

beforeEach(() => {
  clearPendingSchoolContext()
  window.history.replaceState(null, '', '/ai/')
})

afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  vi.clearAllMocks()
})

const render = async (principal?: Promise<DistrictPrincipal | undefined>, prompt?: string) => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  const home = <HomePage prompt={prompt} />
  await act(async () => root!.render(principal
    ? <DistrictFrame manifest={SCHOOL} loadPrincipal={() => principal}>{home}</DistrictFrame>
    : home))
}

describe('school AI home', () => {
  it.each<{ role: ShellRole; title: string; starter: string }>([
    { role: 'student', title: 'What are you curious about?', starter: 'Understand a topic' },
    { role: 'teacher', title: 'Make room for your next great lesson.', starter: 'Plan a lesson' },
    { role: 'guardian', title: 'Support their next step.', starter: 'Support homework' },
    { role: 'school-admin', title: 'Good ideas start with a conversation.', starter: 'Plan a school initiative' },
  ])('offers relevant starting points for a $role', async ({ role, title, starter }) => {
    await render(Promise.resolve({ role, name: 'Ava Chen' }))
    expect(container.querySelector('h1')?.textContent).toBe(title)
    expect(container.textContent).toContain('Northfield')
    expect(container.textContent).toContain('Welcome, Ava Chen')
    const starters = container.querySelector('section[aria-labelledby="school-starters-heading"]')!
    expect(starters.querySelectorAll('button')).toHaveLength(4)
    expect(starters.textContent).toContain(starter)
    expect(container.textContent).not.toContain('direct report')
    expect(state.api.newGadget).not.toHaveBeenCalled()
  })

  it('puts a learning prompt in the draft without creating or sending a conversation', async () => {
    await render(Promise.resolve({ role: 'student', name: 'Ava' }))
    const practice = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Practice step by step'))!
    act(() => practice.click())
    expect(container.querySelector('textarea')?.value).toContain('Let me try before offering a hint')
    expect(state.api.newGadget).not.toHaveBeenCalled()
    expect(state.navigate).not.toHaveBeenCalled()
  })

  it('keeps a draft when the district role arrives after the neutral learning fallback', async () => {
    let resolve!: (principal: DistrictPrincipal) => void
    await render(new Promise((done) => { resolve = done }), 'Keep this project idea.')
    expect(container.querySelector('h1')?.textContent).toBe('Your next idea starts here.')
    await act(async () => resolve({ role: 'teacher', name: 'Ms. Rivera' }))
    expect(container.querySelector('h1')?.textContent).toBe('Make room for your next great lesson.')
    expect(container.textContent).toContain('Plan a lesson')
    expect(container.querySelector('textarea')?.value).toBe('Keep this project idea.')
    expect(state.api.newGadget).not.toHaveBeenCalled()
  })

  it('uses neutral learning examples when the district cannot resolve a role', async () => {
    await render(Promise.resolve(undefined))
    expect(container.querySelector('h1')?.textContent).toBe('Your next idea starts here.')
    expect(container.textContent).toContain('Build a learning tool')
    expect(container.textContent).not.toContain('Welcome,')
  })

  it('keeps the general-purpose Workshop home outside a district', async () => {
    await render()
    expect(container.querySelector('h1')?.textContent).toBe('What are we working on?')
    expect(container.querySelector('section[aria-label="Example tasks"] button')).not.toBeNull()
    expect(container.querySelector('#school-starters-heading')).toBeNull()
  })
})
