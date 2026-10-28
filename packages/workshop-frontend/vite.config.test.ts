import type { ConfigEnv, UserConfig, UserConfigExport } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'

const loadedEnv = vi.hoisted(() => ({ value: {} as Record<string, string> }))
const BASE_ENV = {
  VITE_BACKEND_HOST: 'backend.from-env.test:9999',
  VITE_FRONTEND_ERROR_REPORTING: 'true',
}

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>()
  return {
    ...actual,
    loadEnv: () => ({ ...BASE_ENV, ...loadedEnv.value }),
  }
})

import config from './vite.config'

async function resolveConfig(value: UserConfigExport): Promise<UserConfig> {
  if (typeof value !== 'function') return value
  const env: ConfigEnv = { command: 'build', mode: 'test', isSsrBuild: false, isPreview: false }
  return await value(env)
}

afterEach(() => { loadedEnv.value = {} })

describe('Vite development proxy', () => {
  it('uses loaded environment values for the proxy and source maps', async () => {
    const resolved = await resolveConfig(config)
    expect(resolved.server?.proxy).toMatchObject({
      '/api/client-errors': 'http://backend.from-env.test:9999',
      '/api/device-session/callback': 'http://backend.from-env.test:9999',
      '/api/site-logo': 'http://backend.from-env.test:9999',
    })
    expect(resolved.build?.sourcemap).toBe('hidden')
  })
})

describe('Workshop base path', () => {
  it('serves from the origin root by default', async () => {
    expect((await resolveConfig(config)).base).toBe('/')
  })

  it('mounts the build and the dev proxy under VITE_WORKSHOP_BASE_PATH', async () => {
    for (const value of ['/ai/', '/ai', 'ai']) {
      loadedEnv.value = { VITE_WORKSHOP_BASE_PATH: value }
      const resolved = await resolveConfig(config)
      expect(resolved.base).toBe('/ai/')
      expect(Object.keys(resolved.server?.proxy ?? {}).toSorted()).toEqual([
        '/ai/api/client-errors',
        '/ai/api/device-session/callback',
        '/ai/api/site-logo',
        '/ai/blueprint-screenshot',
      ])
    }
  })

  it('fails the build on a malformed base', async () => {
    loadedEnv.value = { VITE_WORKSHOP_BASE_PATH: '//evil.example' }
    await expect(resolveConfig(config)).rejects.toThrow('Invalid Workshop base path')
  })
})
