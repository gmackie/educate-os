// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ThemeModeButton, ThemeProvider, useTheme } from '@gadgets/ui/theme'
import {
  DISTRICT_THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  injectedThemeMode,
  migrateLegacyThemeMode,
  themeStorageKey,
  workshopThemeSource,
} from './theme'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const root = document.documentElement

function setSystemDark(dark: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

beforeEach(() => {
  localStorage.clear()
  root.removeAttribute('data-mode')
  root.style.colorScheme = ''
  setSystemDark(false)
})

describe('where the Workshop keeps its theme', () => {
  it('keeps the legacy key at the root and shares the district key under /ai/', () => {
    expect(themeStorageKey('/')).toBe(LEGACY_THEME_STORAGE_KEY)
    expect(themeStorageKey('/ai/')).toBe(DISTRICT_THEME_STORAGE_KEY)
    expect(DISTRICT_THEME_STORAGE_KEY).toBe('educateos:theme-mode')
  })

  it('reads and writes only the legacy key at the root, and never migrates it', () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, 'dark')
    const source = workshopThemeSource('/', root, localStorage)
    expect(source.read()).toBe('dark')
    if ('write' in source) source.write('light')
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe('light')
    expect(localStorage.getItem(DISTRICT_THEME_STORAGE_KEY)).toBeNull()
  })
})

describe('migrating the legacy key on a district origin', () => {
  it('carries the legacy choice over once and removes it', () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, 'dark')
    const source = workshopThemeSource('/ai/', root, localStorage)
    expect(source.read()).toBe('dark')
    expect(localStorage.getItem(DISTRICT_THEME_STORAGE_KEY)).toBe('dark')
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull()
  })

  it("never overwrites a choice already made on the district's key", () => {
    localStorage.setItem(DISTRICT_THEME_STORAGE_KEY, 'light')
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, 'dark')
    migrateLegacyThemeMode(localStorage)
    expect(localStorage.getItem(DISTRICT_THEME_STORAGE_KEY)).toBe('light')
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBe('dark')
  })

  it('drops a legacy value that is not a mode', () => {
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, 'purple')
    expect(workshopThemeSource('/ai/', root, localStorage).read()).toBe('system')
    expect(localStorage.getItem(LEGACY_THEME_STORAGE_KEY)).toBeNull()
    expect(localStorage.getItem(DISTRICT_THEME_STORAGE_KEY)).toBeNull()
  })
})

describe('a data-mode the host injected', () => {
  it('reads only light or dark', () => {
    root.setAttribute('data-mode', 'sepia')
    expect(injectedThemeMode(root)).toBeUndefined()
    root.setAttribute('data-mode', 'dark')
    expect(injectedThemeMode(root)).toBe('dark')
  })

  it('is adopted when nothing has been chosen, without being stored', () => {
    root.setAttribute('data-mode', 'dark')
    const source = workshopThemeSource('/ai/', root, localStorage)
    expect(source.read()).toBe('dark')
    expect(localStorage.getItem(DISTRICT_THEME_STORAGE_KEY)).toBeNull()
  })

  it('gives way to a stored choice, including a migrated one', () => {
    root.setAttribute('data-mode', 'dark')
    localStorage.setItem(LEGACY_THEME_STORAGE_KEY, 'light')
    expect(workshopThemeSource('/ai/', root, localStorage).read()).toBe('light')
  })

  it('is noted as the app starts, so a later change to the attribute is not mistaken for it', () => {
    root.setAttribute('data-mode', 'dark')
    const source = workshopThemeSource('/', root, localStorage)
    root.setAttribute('data-mode', 'light')
    expect(source.read()).toBe('dark')
  })
})

const Mode = () => <output>{useTheme().themeMode}</output>

describe('the Workshop under the shared ThemeProvider', () => {
  let mounted: { root: Root; container: HTMLElement } | undefined

  afterEach(() => {
    if (mounted === undefined) return
    act(() => mounted!.root.unmount())
    mounted.container.remove()
    mounted = undefined
  })

  it('starts in the injected mode on a phone, and the shared toggle stores the next one under the district key', () => {
    root.setAttribute('data-mode', 'dark')
    const source = workshopThemeSource('/ai/', root, localStorage)
    const container = document.body.appendChild(document.createElement('div'))
    const reactRoot = createRoot(container)
    mounted = { root: reactRoot, container }
    act(() => reactRoot.render(
      <ThemeProvider source={source}>
        <Mode />
        <ThemeModeButton onAnnounce={() => {}} />
      </ThemeProvider>,
    ))
    expect(container.querySelector('output')?.textContent).toBe('dark')
    expect(root.getAttribute('data-mode')).toBe('dark')

    act(() => container.querySelector('button')!.click())
    expect(container.querySelector('output')?.textContent).toBe('system')
    expect(localStorage.getItem(DISTRICT_THEME_STORAGE_KEY)).toBe('system')
    expect(root.getAttribute('data-mode')).toBe('light')
  })
})
