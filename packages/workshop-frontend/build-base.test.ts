import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const packageDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * Builds the app the way a district's router will serve it, under `/ai/` (SCHO-259), and checks the
 * emitted entry document: a real build, because Vite's rewriting of the HTML's own and `public/`
 * URLs is what the router's static mount depends on. Takes a few seconds.
 */
describe('a build with VITE_WORKSHOP_BASE_PATH=/ai/', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'workshop-base-'))
  afterAll(() => rmSync(outDir, { recursive: true, force: true }))

  it('references its scripts, styles, icons and manifest under /ai/', async () => {
    const previous = process.env.VITE_WORKSHOP_BASE_PATH
    process.env.VITE_WORKSHOP_BASE_PATH = '/ai/'
    try {
      const { build } = await import('vite')
      await build({
        root: packageDir,
        configFile: join(packageDir, 'vite.config.ts'),
        mode: 'production',
        logLevel: 'error',
        build: { outDir, emptyOutDir: true, sourcemap: false },
      })
    } finally {
      if (previous === undefined) delete process.env.VITE_WORKSHOP_BASE_PATH
      else process.env.VITE_WORKSHOP_BASE_PATH = previous
    }

    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    const urls = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map(match => match[1])
    expect(urls).toEqual(expect.arrayContaining([
      '/ai/favicon.svg', '/ai/manifest.webmanifest', '/ai/icons/apple-touch-icon.png',
    ]))
    expect(urls.some(url => /^\/ai\/assets\/index-[^/]+\.js$/.test(url))).toBe(true)
    expect(urls.some(url => /^\/ai\/assets\/index-[^/]+\.css$/.test(url))).toBe(true)
    // Nothing the document loads escapes the mount to the LMS at the origin root.
    for (const url of urls) expect(url).toMatch(/^\/ai\//)

    // The manifest resolves against its own URL, so it scopes the installed app to the mount.
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.webmanifest'), 'utf8')) as {
      id: string, start_url: string, scope: string, icons: { src: string }[]
    }
    const manifestUrl = 'https://district.example/ai/manifest.webmanifest'
    expect(new URL(manifest.start_url, manifestUrl).pathname).toBe('/ai/')
    expect(new URL(manifest.scope, manifestUrl).pathname).toBe('/ai/')
    for (const icon of manifest.icons) {
      expect(new URL(icon.src, manifestUrl).pathname).toMatch(/^\/ai\/icons\//)
    }
    // At the root the same manifest means what the absolute one did before.
    const rootUrl = 'https://schoolos.example/manifest.webmanifest'
    expect(new URL(manifest.start_url, rootUrl).pathname).toBe('/')
    expect(new URL(manifest.id, new URL(manifest.start_url, rootUrl)).pathname).toBe('/')
  }, 120_000)
})
