// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { normalizeWorkshopBase } from './workshopBase'
import { WORKSHOP_BASE, workshopPath, workshopRouterBasepath, workshopUrl } from './workshopPath'

afterEach(() => vi.unstubAllGlobals())

describe('normalizeWorkshopBase', () => {
  it('defaults to the root', () => {
    for (const value of [undefined, '', ' ', '/']) expect(normalizeWorkshopBase(value)).toBe('/')
  })

  it('accepts a mount with or without its slashes', () => {
    for (const value of ['ai', '/ai', 'ai/', '/ai/', ' /ai/ ']) expect(normalizeWorkshopBase(value)).toBe('/ai/')
    expect(normalizeWorkshopBase('/a/b')).toBe('/a/b/')
  })

  it('refuses anything that is not plain path segments', () => {
    for (const value of ['//evil.example', '/ai//x', '/ai?x', '/ai#x', '/../x', '/a/./b', '/a b', 'https://x']) {
      expect(() => normalizeWorkshopBase(value)).toThrow('Invalid Workshop base path')
    }
  })
})

describe('workshopPath', () => {
  it('is the build base, which is the root by default', () => {
    expect(WORKSHOP_BASE).toBe('/')
    expect(workshopPath('/api')).toBe('/api')
  })

  it.each([
    ['/', '/api', '/api'],
    ['/', '/api/client-errors', '/api/client-errors'],
    ['/', '/', '/'],
    ['/ai/', '/api', '/ai/api'],
    ['/ai/', '/api/device-session/callback', '/ai/api/device-session/callback'],
    ['/ai/', '/blueprint-screenshot/x?v=1', '/ai/blueprint-screenshot/x?v=1'],
    ['/ai/', '/workspace/w#share=k', '/ai/workspace/w#share=k'],
    ['/ai/', '/', '/ai/'],
  ])('under base %s maps %s to %s', (base, path, expected) => {
    expect(workshopPath(path, base)).toBe(expected)
  })

  it('refuses paths that are not origin-relative', () => {
    for (const path of ['api', '//evil.example/api', 'https://evil.example/api']) {
      expect(() => workshopPath(path, '/ai/')).toThrow('origin-relative')
      expect(() => workshopPath(path, '/')).toThrow('origin-relative')
    }
  })

  it('builds full URLs on the current origin', () => {
    vi.stubGlobal('location', { origin: 'https://district.example' })
    expect(workshopUrl('/blueprint/b', '/')).toBe('https://district.example/blueprint/b')
    expect(workshopUrl('/blueprint/b', '/ai/')).toBe('https://district.example/ai/blueprint/b')
  })
})

describe('workshopRouterBasepath', () => {
  it('is / at the root and the mount without its trailing slash otherwise', () => {
    expect(workshopRouterBasepath()).toBe('/')
    expect(workshopRouterBasepath('/')).toBe('/')
    expect(workshopRouterBasepath('/ai/')).toBe('/ai')
  })

  it('makes route paths relative to the mount', async () => {
    const rootRoute = createRootRoute()
    const routeTree = rootRoute.addChildren([
      createRoute({ getParentRoute: () => rootRoute, path: '/workspace/$id' }),
    ])
    const router = createRouter({
      routeTree,
      basepath: workshopRouterBasepath('/ai/'),
      history: createMemoryHistory({ initialEntries: ['/ai/workspace/w1'] }),
    })
    await router.load()
    // The app's pathname checks (routes/__root.tsx) see the path without the mount...
    expect(router.state.location.pathname).toBe('/workspace/w1')
    expect(router.state.matches.at(-1)?.params).toEqual({ id: 'w1' })
    // ...and navigating by route path puts the mount back in the browser's URL.
    await router.navigate({ to: '/workspace/$id', params: { id: 'w2' } })
    expect(router.history.location.pathname).toBe('/ai/workspace/w2')
    expect(router.state.location.pathname).toBe('/workspace/w2')
  })
})
