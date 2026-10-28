// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchoolContextResolution } from '@gadgets/workshop-shared/school-context'

const testState = vi.hoisted(() => {
  const newChat = vi.fn<(message: unknown) => Promise<string>>(async () => 'chat-1')
  const overseer = {
    newChat,
    getMetadata: async () => ({ id: 'gadget-1' }),
    [Symbol.dispose]: () => {},
  }
  return {
    addToast: vi.fn<(toast: { title: string; description?: string }) => void>(),
    navigate: vi.fn<(options: unknown) => void>(),
    newChat,
    resolveSchoolContext: vi.fn<(ref: string) => Promise<unknown>>(),
    onSend: undefined as undefined | ((message: string, modelId: string | null) => Promise<void>),
    authenticatedApi: {} as Record<string, unknown>,
    overseer,
  }
})
testState.authenticatedApi = {
  listModels: async () => [],
  newGadget: () => testState.overseer,
  resolveSchoolContext: testState.resolveSchoolContext,
}

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => testState.navigate,
}))
vi.mock('@cloudflare/kumo', () => ({ useKumoToastManager: () => ({ add: testState.addToast }) }))
vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi, currentUser: { id: 'u', name: 'Ava' } }),
}))
vi.mock('../chat/composer/ChatComposer', () => ({
  ChatComposer: ({ onSend }: { onSend: (message: string, modelId: string | null) => Promise<void> }) => {
    testState.onSend = onSend
    return <textarea aria-label="Prompt" />
  },
}))
vi.mock('../../components/MeshBackground', () => ({ default: () => null }))
vi.mock('../../components/AppShell/HomeTaskSuggestions', () => ({ default: () => null }))
vi.mock('../deployment-updates/UpdateAvailableNotice', () => ({ UpdateAvailableNotice: () => null }))
vi.mock('../../useDocumentTitle', () => ({ useDocumentTitle: () => {} }))

import { HomePageContent } from '../../routes/index'
import { clearPendingSchoolContext, pendingSchoolContext, takeSchoolContextFromUrl } from './schoolContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ASSIGNMENT = 'asg_lab-report-1'

beforeEach(() => {
  clearPendingSchoolContext()
  window.history.replaceState(null, '', '/')
})

describe('takeSchoolContextFromUrl', () => {
  it('takes the reference off the URL on a district origin, keeping everything else', () => {
    window.history.replaceState({ key: 'k' }, '', `/ai/?context=assignment:${ASSIGNMENT}&prompt=hi#top`)
    expect(takeSchoolContextFromUrl('/ai/')).toEqual({ kind: 'ref', ref: { kind: 'assignment', id: ASSIGNMENT } })
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/ai/?prompt=hi#top')
    expect(window.history.state).toEqual({ key: 'k' })
    expect(pendingSchoolContext()).toEqual({ kind: 'ref', ref: { kind: 'assignment', id: ASSIGNMENT } })
  })

  it('holds a malformed reference as malformed, and still takes it off the URL', () => {
    window.history.replaceState(null, '', '/ai/?context=assignment:../../admin')
    expect(takeSchoolContextFromUrl('/ai/')).toEqual({ kind: 'malformed' })
    expect(window.location.search).toBe('')
  })

  it('leaves the URL alone at the root of an origin, where there is no district', () => {
    window.history.replaceState(null, '', `/?context=assignment:${ASSIGNMENT}`)
    expect(takeSchoolContextFromUrl('/')).toBeUndefined()
    expect(window.location.search).toBe(`?context=assignment:${ASSIGNMENT}`)
    expect(pendingSchoolContext()).toBeUndefined()
  })

  it('does nothing without the parameter', () => {
    window.history.replaceState(null, '', '/ai/?prompt=hi')
    expect(takeSchoolContextFromUrl('/ai/')).toBeUndefined()
    expect(window.location.search).toBe('?prompt=hi')
  })
})

describe('the home page with a context link', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
    testState.onSend = undefined
  })

  async function openHome(link: string, resolution?: SchoolContextResolution | Error) {
    if (resolution instanceof Error) testState.resolveSchoolContext.mockRejectedValue(resolution)
    else if (resolution !== undefined) testState.resolveSchoolContext.mockResolvedValue(resolution)
    window.history.replaceState(null, '', link)
    takeSchoolContextFromUrl('/ai/')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<HomePageContent />))
    return container
  }

  it('attaches what the backend confirmed, shows it, and leads the first message with it', async () => {
    const page = await openHome(`/ai/?context=assignment:${ASSIGNMENT}`, {
      status: 'attached',
      context: { kind: 'assignment', id: ASSIGNMENT, title: 'Lab report: Photosynthesis' },
    })
    expect(testState.resolveSchoolContext).toHaveBeenCalledWith(`assignment:${ASSIGNMENT}`)
    const chip = page.querySelector('[aria-label="Chat context"]')
    expect(chip?.textContent).toContain('Assignment')
    expect(chip?.textContent).toContain('Lab report: Photosynthesis')
    expect(pendingSchoolContext()).toBeUndefined()

    await act(async () => testState.onSend!('Help me plan this.', null))
    expect(testState.newChat.mock.calls[0]![0]).toBe(
      `[School context: assignment ${ASSIGNMENT}, "Lab report: Photosynthesis"]\n\nHelp me plan this.`,
    )
    expect(testState.addToast).not.toHaveBeenCalled()
  })

  it('starts the chat without the context once its chip is removed', async () => {
    const page = await openHome(`/ai/?context=assignment:${ASSIGNMENT}`, {
      status: 'attached',
      context: { kind: 'assignment', id: ASSIGNMENT, title: 'Lab report' },
    })
    await act(async () => page.querySelector<HTMLButtonElement>('[aria-label^="Remove"]')!.click())
    expect(page.querySelector('[aria-label="Chat context"]')).toBeNull()
    await act(async () => testState.onSend!('Hello', null))
    expect(testState.newChat.mock.calls[0]![0]).toBe('Hello')
  })

  it('drops a refused reference with a toast that names nothing about it', async () => {
    const page = await openHome('/ai/?context=submission:sub_someone-else', { status: 'refused' })
    expect(page.querySelector('[aria-label="Chat context"]')).toBeNull()
    expect(testState.addToast).toHaveBeenCalledTimes(1)
    const toast = testState.addToast.mock.calls[0]![0]
    expect(JSON.stringify(toast)).not.toContain('sub_someone-else')
    await act(async () => testState.onSend!('Hello', null))
    expect(testState.newChat.mock.calls[0]![0]).toBe('Hello')
  })

  it('refuses a malformed reference without asking the backend', async () => {
    await openHome('/ai/?context=grades:everyone')
    expect(testState.resolveSchoolContext).not.toHaveBeenCalled()
    expect(testState.addToast).toHaveBeenCalledTimes(1)
  })

  it('treats a failed check as a refusal', async () => {
    await openHome(`/ai/?context=assignment:${ASSIGNMENT}`, new Error('connection lost'))
    expect(testState.addToast).toHaveBeenCalledTimes(1)
  })

  it('ignores the reference quietly where the deployment has no district', async () => {
    const page = await openHome(`/ai/?context=assignment:${ASSIGNMENT}`, { status: 'unsupported' })
    expect(page.querySelector('[aria-label="Chat context"]')).toBeNull()
    expect(testState.addToast).not.toHaveBeenCalled()
  })
})
