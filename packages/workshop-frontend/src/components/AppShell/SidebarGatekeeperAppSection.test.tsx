// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it } from 'vitest'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { parseGatekeeperAppSearch } from '../../gatekeeperAppNavigation'
import SidebarGatekeeperAppSection from './SidebarGatekeeperAppSection'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SCHOOL: GatekeeperAppInfo = {
  id: 'educateos',
  title: 'School',
  nav: [
    { label: 'Algebra I', path: '/classes/1', group: 'Classes' },
    { label: 'Administration', path: '/admin' },
    { label: '<b>Biology</b>', path: '/classes/2', group: 'Classes' },
    { label: 'Lincoln High', path: '/schools/9', group: 'Schools' },
  ],
}

describe('SidebarGatekeeperAppSection', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  async function renderAt(url: string) {
    const rootRoute = createRootRoute({
      component: () => (
        <>
          <SidebarGatekeeperAppSection app={SCHOOL} nav={SCHOOL.nav!} />
          <Outlet />
        </>
      ),
    })
    const appRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/gatekeepers/$appId',
      validateSearch: parseGatekeeperAppSearch,
    })
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/' })
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [url] }),
      routeTree: rootRoute.addChildren([indexRoute, appRoute]),
    })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<RouterProvider router={router} />))
    return router
  }

  const links = () => [...container!.querySelectorAll('a')]
  const current = () => links().filter((link) => link.getAttribute('aria-current') === 'page')

  it('lists the entries under the app heading, ungrouped first, each linking into the app', async () => {
    await renderAt('/')

    const nav = container!.querySelector('nav')!
    const heading = container!.querySelector('h2')!
    expect(heading.textContent).toBe('School')
    expect(nav.getAttribute('aria-labelledby')).toBe(heading.id)

    expect(links().map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Administration', '/gatekeepers/educateos?path=%2Fadmin'],
      ['Algebra I', '/gatekeepers/educateos?path=%2Fclasses%2F1'],
      ['<b>Biology</b>', '/gatekeepers/educateos?path=%2Fclasses%2F2'],
      ['Lincoln High', '/gatekeepers/educateos?path=%2Fschools%2F9'],
    ])
    // Labels are text, never markup.
    expect(container!.querySelector('b')).toBeNull()

    const groups = [...container!.querySelectorAll('[role="group"]')]
    expect(groups.map((group) => {
      const label = document.getElementById(group.getAttribute('aria-labelledby')!)
      return [label?.textContent, [...group.querySelectorAll('a')].map((a) => a.textContent)]
    })).toEqual([
      ['Classes', ['Algebra I', '<b>Biology</b>']],
      ['Schools', ['Lincoln High']],
    ])
  })

  it('marks only the entry whose path the URL carries as the current page', async () => {
    const router = await renderAt('/gatekeepers/educateos?path=%2Fclasses%2F1')
    expect(current().map((link) => link.textContent)).toEqual(['Algebra I'])

    await act(async () => {
      links().find((link) => link.textContent === 'Lincoln High')!.click()
    })
    expect(router.state.location.search).toEqual({ path: '/schools/9' })
    expect(current().map((link) => link.textContent)).toEqual(['Lincoln High'])

    await act(async () => router.navigate({ to: '/' }))
    expect(current()).toEqual([])
  })
})
