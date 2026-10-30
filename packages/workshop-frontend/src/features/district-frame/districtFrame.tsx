// The district frame (SCHO-260, plan §4 "AI workspace at /ai"). On a district origin the Workshop is
// the AI workspace beside the LMS, and uses the LMS's school chrome (@educateos/shell):
// the school's name, logo and accent, role navigation and account actions share the Workshop's
// existing sidebar. Moving between Learn and AI is a link on the same origin.
//
// The frame is drawn only when both hold:
// - the Workshop is mounted below the origin's root (`/ai/`), which only a district origin does, and
// - the origin's public school manifest (`/.well-known/educateos.json`) loads and has `features.ai`.
// Mounted at the root (schoolos.gmac.io today) nothing is fetched and the Workshop is unchanged.

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import {
  SCHOOL_MANIFEST_PATH,
  loadSchoolManifest,
  navigationFor,
  shellRoleOf,
  useBrandAccent,
  type NavGroup,
  type SchoolManifest,
  type SchoolManifestState,
  type ShellLocation,
  type ShellPrincipal,
  type ShellRole,
} from '@educateos/shell'
import { WORKSHOP_BASE } from '../../workshopPath'
import { isDistrictOrigin } from '../../workshopBase'
import { useServerConfig } from '../../ServerConfigContext'

/** Whether the frame applies at all: off, still finding out, or on with the school's manifest. */
export type DistrictFrameState =
  | { status: 'off' }
  | { status: 'pending' }
  | { status: 'framed'; manifest: SchoolManifest }

/** How long the manifest may take before the Workshop starts without the frame. */
const MANIFEST_TIMEOUT_MS = 4000

const OFF: DistrictFrameState = { status: 'off' }
let frameState: DistrictFrameState = OFF
const listeners = new Set<() => void>()

const setFrameState = (next: DistrictFrameState) => {
  frameState = next
  for (const listener of listeners) listener()
}

type ManifestLoader = () => Promise<Exclude<SchoolManifestState, { status: 'loading' }>>

/**
 * Decides, once as the app starts, whether this page is framed. On a district origin it reads the
 * manifest, and the frame stays `pending` until that answers (or MANIFEST_TIMEOUT_MS passes, which
 * leaves it off).
 */
export function startDistrictFrame(
  base: string = WORKSHOP_BASE,
  load: ManifestLoader = () => loadSchoolManifest(SCHOOL_MANIFEST_PATH),
): void {
  if (!isDistrictOrigin(base)) {
    setFrameState(OFF)
    return
  }
  setFrameState({ status: 'pending' })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), MANIFEST_TIMEOUT_MS) })
  void Promise.race([load(), timeout]).then((state) => {
    clearTimeout(timer)
    setFrameState(state?.status === 'ready' && state.manifest.features.ai
      ? { status: 'framed', manifest: state.manifest }
      : OFF)
  }, () => {
    clearTimeout(timer)
    setFrameState(OFF)
  })
}

/** Back to unframed, for tests. */
export function resetDistrictFrame(): void {
  setFrameState(OFF)
}

/** Whether this page is framed, followed as the manifest arrives. */
export function useDistrictFrame(): DistrictFrameState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => frameState,
    () => frameState,
  )
}

/** Who the district says is signed in, as far as the frame needs it. */
export interface DistrictPrincipal {
  role: ShellRole
  name: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const PRINCIPAL_KINDS = new Set(['student', 'staff', 'guardian', 'service'])

/** Reads a `me.get` body (`/api/me`) as the frame's principal, or undefined if it isn't one. */
export function parseDistrictPrincipal(body: unknown): DistrictPrincipal | undefined {
  if (!isRecord(body) || typeof body.kind !== 'string' || !PRINCIPAL_KINDS.has(body.kind)) return undefined
  const roles = Array.isArray(body.roles)
    ? body.roles.filter((entry): entry is { role: string } => isRecord(entry) && typeof entry.role === 'string')
    : []
  const name = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  return { role: shellRoleOf({ kind: body.kind as ShellPrincipal['kind'], roles }), name }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Asks the district who is signed in: `/api/me` on this origin, with the same Access session the
 * page has. Undefined if it can't say (signed out, a redirect to sign-in, offline), in which case
 * the frame offers the minimal links.
 */
export async function loadDistrictPrincipal(
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<DistrictPrincipal | undefined> {
  try {
    const response = await fetchImpl('/api/me', {
      credentials: 'same-origin',
      redirect: 'manual',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return undefined
    return parseDistrictPrincipal(await response.json())
  } catch {
    return undefined
  }
}

const at = (pathname: string) => (location: ShellLocation) => location.pathname === pathname

/**
 * The links offered when the Workshop can't learn the person's role: back to the school's
 * everyday places, and the AI workspace, which is where they are.
 */
export function fallbackDistrictNavigation(school: SchoolManifest, base: string = WORKSHOP_BASE): NavGroup[] {
  const mount = base.replace(/\/$/, '')
  return [
    {
      id: 'school',
      label: `Back to ${school.name}`,
      items: [
        { id: 'home', label: 'Home', href: '/', icon: 'home', active: (location) => location.pathname === '/' && location.hash !== '#my-courses' },
        { id: 'classes', label: 'Classes', href: '/#my-courses', icon: 'classes', active: (location) => location.pathname === '/' && location.hash === '#my-courses' },
        { id: 'calendar', label: 'Calendar', href: '/calendar', icon: 'calendar', active: at('/calendar') },
        { id: 'inbox', label: 'Inbox', href: '/notifications', icon: 'inbox', active: at('/notifications') },
      ],
    },
    {
      id: 'workspace',
      label: 'Workspace',
      items: [{
        id: 'ai',
        label: 'AI workspace',
        href: base,
        icon: 'ai',
        active: (location) => location.pathname === mount || location.pathname.startsWith(`${mount}/`),
      }],
    },
  ]
}

/** The browser's place, read again on every router navigation (the router uses pushState). */
function useFrameLocation(): ShellLocation {
  useRouterState({ select: (state) => state.location.href })
  return { pathname: window.location.pathname, hash: window.location.hash }
}

interface DistrictSidebar {
  school: SchoolManifest
  principal: DistrictPrincipal | null | undefined
  navigation: NavGroup[]
  location: ShellLocation
}

const DistrictSidebarContext = createContext<DistrictSidebar | undefined>(undefined)

/** School branding, role navigation and account capabilities for the existing AI sidebar. */
export const useDistrictSidebar = (): DistrictSidebar | undefined => useContext(DistrictSidebarContext)

/**
 * Supplies the school's chrome to the existing Workshop sidebar. The role comes from the district;
 * until it answers navigation waits, and if it can't, the minimal links stand in.
 */
export const DistrictFrame = ({
  manifest,
  children,
  loadPrincipal = loadDistrictPrincipal,
  base = WORKSHOP_BASE,
}: {
  manifest: SchoolManifest
  children: ReactNode
  loadPrincipal?: () => Promise<DistrictPrincipal | undefined>
  /** The Workshop's mount, which the minimal links name as the AI workspace. */
  base?: string
}) => {
  const [principal, setPrincipal] = useState<DistrictPrincipal | null | undefined>(undefined)
  const location = useFrameLocation()
  const workshopAccent = useServerConfig()?.accentColor

  useEffect(() => {
    let cancelled = false
    void loadPrincipal().then((found) => {
      if (!cancelled) setPrincipal(found ?? null)
    })
    return () => { cancelled = true }
  }, [loadPrincipal])

  // The school's accent leads; a district that sets none keeps the Workshop's own.
  const accent = manifest.brand.accent ?? (workshopAccent || undefined)
  useBrandAccent(accent)
  const navigation = principal === undefined ? [] : principal === null
    ? fallbackDistrictNavigation(manifest, base)
    : navigationFor(principal.role, { ai: manifest.features.ai })
  return (
    <DistrictSidebarContext.Provider value={{ school: manifest, principal, navigation, location }}>
      {children}
    </DistrictSidebarContext.Provider>
  )
}
