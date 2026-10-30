// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NoWorkspacesYet } from './NoWorkspacesYet'

const district = vi.hoisted(() => ({ current: undefined as undefined | { school: { name: string } } }))
vi.mock('../features/district-frame/districtFrame', () => ({ useDistrictSidebar: () => district.current }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined

beforeEach(() => {
  window.scrollTo = vi.fn<() => void>()
})

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  district.current = undefined
  document.body.innerHTML = ''
})

const render = async () => {
  const rootRoute = createRootRoute()
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <p>Home page</p> }),
      createRoute({ getParentRoute: () => rootRoute, path: '/workspaces', component: NoWorkspacesYet }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/workspaces'] }),
  })
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<RouterProvider router={router} />)
    await router.load()
  })
  return container
}

describe('NoWorkspacesYet', () => {
  it('sends a Workshop user to Home to start one', async () => {
    const container = await render()

    expect(container.textContent).toContain('No workspaces yet')
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === 'Go to Home')
    expect(link).toBeDefined()

    await act(async () => link!.click())
    expect(container.textContent).toContain('Home page')
  })

  it('speaks to school work on a district origin', async () => {
    district.current = { school: { name: 'Northfield' } }
    const container = await render()

    expect(container.textContent).toContain('learning tool you make gets its own workspace')
    expect([...container.querySelectorAll('a')].some((a) => a.textContent === 'Go to AI home')).toBe(true)
  })
})
