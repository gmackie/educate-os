import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { type RpcPromise, RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { useNavigate } from '@tanstack/react-router'
import {
  isGatekeeperAppPath,
  type GatekeeperAppLocationReceiver,
  type GatekeeperUiFrame,
  type GatekeeperUserSelectionReceiver,
} from '@gadgets/workshop-shared/gatekeeper'
import { isHexColor } from '@gadgets/workshop-shared/api'
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from '@gadgets/workshop-shared/theme'
import { createRateLimitedCapability } from './rateLimitedCapability'
import { useTheme } from '@gadgets/ui/theme'
import { useServerConfig } from './ServerConfigContext'
import { forwardTrustedFrameError } from './errorReporting'
import { useAuthenticatedApi } from './AuthContext'
import { refreshGatekeeperApps } from './useGatekeeperApps'
import {
  normalizeGatekeeperAppPrompt,
  parseGatekeeperAppWorkspaceTarget,
  type GatekeeperAppWorkspaceTarget,
} from './gatekeeperAppNavigation'
import GatekeeperUserPickerDialog from './features/gatekeeper-sharing/GatekeeperUserPickerDialog'

// The content-pane rect, in viewport coordinates, that the app pins its page to while the iframe
// is full-viewport.
type OverlayRect = { left: number; top: number; width: number; height: number }

// The host's reply to a present/dismiss. On open, `rect` is where the app holds its page fixed while
// the iframe expands to full-viewport (null on restore); `willResize` is whether switching the iframe
// to/from full-viewport actually changes its pixel size (it won't if the pane already fills the window).
type PresentAck = { rect: OverlayRect | null; willResize: boolean }

// Grows the app's iframe to a full-viewport overlay for app-level modals (true) or restores it (false).
type PresentController = (active: boolean) => PresentAck
type OpenTarget = (target: GatekeeperAppWorkspaceTarget) => void
// Resolves workspace IDs the app already holds to their live titles; null for a workspace the user
// can no longer see. Deliberately a lookup, not an enumeration: the app learns nothing new.
type ResolveWorkspaceTitles = (ids: string[]) => Promise<(string | null)[]>
type OpenPrompt = (prompt: string) => void
// Opening throws synchronously if refused; returning transfers receiver ownership to the picker.
type OpenUserPicker = (receiver: RpcStub<GatekeeperUserSelectionReceiver>) => Promise<void>
type CancelUserPicker = () => void
// Moves the Workshop URL to the app's place `path`, adding a history entry unless `replace`.
type ChangePath = (path: string, options: { replace: boolean }) => void

type UserPicker = {
  id: number
  receiver: RpcStub<GatekeeperUserSelectionReceiver>
  deliveries: Set<RpcPromise<void>>
  resolve: () => void
}

const USER_PICKER_CANCELLED = 'Person selection cancelled. A delivery may already have been accepted.'

type OverlayState = 'full' | null

// Upper bound on one workspace-title lookup, matching the app's page size.
const MAX_RESOLVED_WORKSPACES = 100

// How long one gadget listing is reused across title lookups. The untrusted frame calls this once
// per page of rows (and could call it in a loop), so the listing is shared rather than repeated.
const WORKSPACE_TITLES_TTL_MS = 10_000

// The shortest gap between the sidebar refreshes an app asks for: each one re-reads every app's
// entries from its gatekeeper, and the untrusted frame could ask in a loop.
const NAV_REFRESH_INTERVAL_MS = 1_000

// Near the max int, so the full-viewport iframe sits above all Workshop chrome.
const overlayZIndex = 2147483000

const baseIframeStyle: CSSProperties = {
  border: 0,
  background: 'transparent',
}

function iframeStyleForOverlay(overlay: OverlayState): CSSProperties {
  if (overlay === 'full') {
    return {
      ...baseIframeStyle,
      position: 'fixed',
      top: 'calc(var(--app-top) + env(safe-area-inset-top))',
      right: 'env(safe-area-inset-right)',
      bottom: 'calc(var(--app-bottom) + env(safe-area-inset-bottom))',
      left: 'env(safe-area-inset-left)',
      width: 'calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right))',
      height: 'calc(100vh - var(--app-top) - var(--app-bottom) - env(safe-area-inset-top) - env(safe-area-inset-bottom))',
      zIndex: overlayZIndex,
    }
  }
  return {
    ...baseIframeStyle,
    display: 'block',
    width: '100%',
    height: '100%',
  }
}

// The host capability exposed to the sandboxed app (the gatekeeper's iframe UI) over the MessagePort
// RPC session. The app uses `ui` to reach the gatekeeper's own capability, which Workshop relays and
// rate-limits. `setPresenting` stays in Workshop and only grows/restores the iframe's layout.
class GatekeeperAppHostImpl extends RpcTarget {
  readonly #ui: RpcStub<RpcTarget>
  readonly #disposeRateLimiter: () => void
  readonly #present: PresentController
  readonly #openTarget: OpenTarget
  readonly #openPrompt: OpenPrompt
  readonly #resolveWorkspaceTitles: ResolveWorkspaceTitles
  readonly #openUserPicker: OpenUserPicker
  readonly #cancelUserPicker: CancelUserPicker
  readonly #changePath: ChangePath
  readonly #refreshNav: () => void
  #presenting = false
  #theme: GatekeeperAppTheme
  #themeReceiver: RpcStub<GatekeeperAppThemeReceiver> | null = null
  // Presentation changes are coalesced to a single apply per animation frame (see #applyPending).
  #pendingActive: boolean | null = null
  #pendingResolvers: ((ack: PresentAck) => void)[] = []
  #frameId: number | null = null
  // Where the app is, as the Workshop URL last said or the app last reported.
  #path: string
  #locationReceiver: RpcStub<GatekeeperAppLocationReceiver> | null = null
  // The app's moves are likewise coalesced to one URL change per animation frame (#applyLocation).
  #pendingLocation: { path: string, push: boolean } | null = null
  #locationFrameId: number | null = null
  #lastNavRefresh = -Infinity
  #navRefreshTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    capability: unknown,
    present: PresentController,
    theme: GatekeeperAppTheme,
    openTarget: OpenTarget,
    openPrompt: OpenPrompt,
    resolveWorkspaceTitles: ResolveWorkspaceTitles,
    openUserPicker: OpenUserPicker,
    cancelUserPicker: CancelUserPicker,
    path: string,
    changePath: ChangePath,
    refreshNav: () => void,
  ) {
    super()
    this.#theme = theme
    this.#path = path
    this.#changePath = changePath
    this.#refreshNav = refreshNav
    const { capability: ui, dispose } = createRateLimitedCapability(capability, {
      maxConcurrency: 8,
      maxCallsPerMinute: 600,
      maxPendingCalls: 128,
      onRateLimit: 'throttle',
      label: 'Gatekeeper app',
    })
    this.#ui = ui
    this.#disposeRateLimiter = dispose
    this.#present = present
    this.#openTarget = openTarget
    this.#openPrompt = openPrompt
    this.#resolveWorkspaceTitles = resolveWorkspaceTitles
    this.#openUserPicker = openUserPicker
    this.#cancelUserPicker = cancelUserPicker
  }

  get ui(): RpcStub<RpcTarget> {
    return this.#ui
  }

  // Navigate to a workspace the app knows about. The IDs are validated here because the app is
  // untrusted; navigation stays in-app rather than handing the frame a URL to follow.
  openWorkspace(workspaceId: string, gadgetId?: number): void {
    this.#openTarget(parseGatekeeperAppWorkspaceTarget(workspaceId, gadgetId))
  }

  // Resolve live titles for workspaces the app already references, so it never renders a stale
  // snapshot. Bounded per call; unknown or no-longer-visible workspaces come back as null.
  resolveWorkspaceTitles(ids: string[]): Promise<(string | null)[]> {
    if (!Array.isArray(ids) || ids.length > MAX_RESOLVED_WORKSPACES) {
      throw new TypeError('Invalid workspace title lookup.')
    }
    return this.#resolveWorkspaceTitles(ids)
  }

  openPrompt(prompt: string): void {
    this.#openPrompt(normalizeGatekeeperAppPrompt(prompt))
  }

  // Open the trusted Workshop-owned person picker over the app. The directory search happens in the
  // parent, and the Workshop mints a single-use ticket for each person the user selects
  // (AuthenticatedApi.createGatekeeperUserSelection) and delivers it to `receiver.receive()` — to
  // the iframe, not to the gatekeeper's server. The app decides what a selection is for: it can send
  // the ticket to its backend at once, or hold it in form state and submit it later, while it is
  // valid. The promise resolves when the picker closes: after every delivery has settled, or
  // immediately on cancellation, when deliveries may still be running. Frame teardown also
  // cancels, but the app then sees its connection close instead. Cancellation cannot undo a
  // delivery the app may already have accepted. Otherwise it stays pending while open (no timeout).
  // Only one picker can be open at a time.
  selectUsers(receiver: RpcStub<GatekeeperUserSelectionReceiver>): Promise<void> {
    if (typeof receiver?.dup !== 'function') {
      return Promise.reject(new TypeError('selectUsers requires a receiver capability.'))
    }
    // The argument stub is disposed when this call returns. Opening transfers this dup to the
    // picker, which releases it on close or cancellation; only an opening failure releases it here.
    const retained = receiver.dup()
    try {
      return this.#openUserPicker(retained)
    } catch (error) {
      retained[Symbol.dispose]()
      return Promise.reject(error)
    }
  }

  // The app calls this once to learn the current theme and register a receiver for later changes.
  // Apps that don't theme themselves never call it.
  subscribeTheme(receiver: RpcStub<GatekeeperAppThemeReceiver>): GatekeeperAppTheme {
    this.#themeReceiver?.[Symbol.dispose]?.()
    // The argument stub is disposed when this call returns, so keep our own dup (released in dispose).
    this.#themeReceiver = receiver.dup()
    return this.#theme
  }

  #dropThemeReceiver(receiver: RpcStub<GatekeeperAppThemeReceiver>) {
    if (this.#themeReceiver !== receiver) return
    receiver[Symbol.dispose]?.()
    this.#themeReceiver = null
  }

  // Push a new theme to a subscribed app; a no-op until (and unless) the app subscribes.
  updateTheme(theme: GatekeeperAppTheme) {
    this.#theme = theme
    const receiver = this.#themeReceiver
    if (!receiver) return

    try {
      Promise.resolve(receiver.setTheme(theme)).catch(() => this.#dropThemeReceiver(receiver))
    } catch {
      this.#dropThemeReceiver(receiver)
    }
  }

  // The app calls this once to learn its place in the Workshop URL and to follow later changes to it
  // (a sidebar entry, the back button). Apps without places of their own never call it.
  subscribeLocation(receiver: RpcStub<GatekeeperAppLocationReceiver>): string {
    if (typeof receiver?.dup !== 'function') {
      throw new TypeError('subscribeLocation requires a receiver capability.')
    }
    this.#locationReceiver?.[Symbol.dispose]?.()
    // The argument stub is disposed when this call returns, so keep our own dup (released in dispose).
    this.#locationReceiver = receiver.dup()
    return this.#path
  }

  #dropLocationReceiver(receiver: RpcStub<GatekeeperAppLocationReceiver>) {
    if (this.#locationReceiver !== receiver) return
    receiver[Symbol.dispose]?.()
    this.#locationReceiver = null
  }

  // Tell a subscribed app the Workshop URL moved to `path`, unless the app is already there (as it
  // is after a move it reported itself). The user's move supersedes any the app has queued.
  updateLocation(path: string) {
    this.#cancelPendingLocation()
    if (path === this.#path) return
    this.#path = path
    const receiver = this.#locationReceiver
    if (!receiver) return

    try {
      Promise.resolve(receiver.setPath(path)).catch(() => this.#dropLocationReceiver(receiver))
    } catch {
      this.#dropLocationReceiver(receiver)
    }
  }

  // Record the app's move to `path` in the Workshop URL, so reloading, sharing or going back returns
  // there. Moves in one animation frame make one URL change, which adds a history entry if any of
  // them did not ask to `replace`, so a redirect right after a navigation stays one entry.
  setLocation(path: string, options?: { replace?: boolean }): void {
    if (!isGatekeeperAppPath(path)) throw new TypeError('Invalid gatekeeper app location.')
    const push = options?.replace !== true || (this.#pendingLocation?.push ?? false)
    this.#pendingLocation = { path, push }
    this.#locationFrameId ??= requestAnimationFrame(() => this.#applyLocation())
  }

  #applyLocation() {
    this.#locationFrameId = null
    const { path, push } = this.#pendingLocation!
    this.#pendingLocation = null
    if (path === this.#path) return
    this.#path = path
    this.#changePath(path, { replace: !push })
  }

  #cancelPendingLocation() {
    if (this.#locationFrameId !== null) cancelAnimationFrame(this.#locationFrameId)
    this.#locationFrameId = null
    this.#pendingLocation = null
  }

  // Re-read the sidebar entries of the user's apps, after the app changed what its own should be.
  // At most one refresh per NAV_REFRESH_INTERVAL_MS; a request inside the interval is deferred to
  // its end, and further ones until then share it.
  refreshNav(): void {
    if (this.#navRefreshTimer !== null) return
    const run = () => {
      this.#navRefreshTimer = null
      this.#lastNavRefresh = Date.now()
      this.#refreshNav()
    }
    const wait = this.#lastNavRefresh + NAV_REFRESH_INTERVAL_MS - Date.now()
    if (wait <= 0) run()
    else this.#navRefreshTimer = setTimeout(run, wait)
  }

  // Queue a presentation change; the latest requested state is applied on the next frame.
  setPresenting(active: boolean): Promise<PresentAck> {
    return new Promise((resolve) => {
      this.#pendingActive = active
      this.#pendingResolvers.push(resolve)
      this.#frameId ??= requestAnimationFrame(() => this.#applyPending())
    })
  }

  // Apply the last-requested state once, resolving every caller queued this frame with the result.
  #applyPending() {
    this.#frameId = null
    const active = this.#pendingActive!
    const resolvers = this.#pendingResolvers
    this.#pendingActive = null
    this.#pendingResolvers = []
    // No-op toggles skip the layout apply.
    const ack: PresentAck =
      active === this.#presenting ? { rect: null, willResize: false } : this.#present(active)
    this.#presenting = active
    for (const resolve of resolvers) resolve(ack)
  }

  // Cancel the rate limiter's pending resume timer once this host is no longer in use.
  dispose() {
    this.#disposeRateLimiter()
    this.#cancelUserPicker()
    this.#themeReceiver?.[Symbol.dispose]?.()
    this.#themeReceiver = null
    this.#locationReceiver?.[Symbol.dispose]?.()
    this.#locationReceiver = null
    this.#cancelPendingLocation()
    if (this.#navRefreshTimer !== null) clearTimeout(this.#navRefreshTimer)
    this.#navRefreshTimer = null
    if (this.#frameId !== null) {
      cancelAnimationFrame(this.#frameId)
      this.#frameId = null
    }
    for (const resolve of this.#pendingResolvers) resolve({ rect: null, willResize: false })
    this.#pendingResolvers = []
    this.#pendingActive = null
    if (this.#presenting) {
      this.#presenting = false
      this.#present(false)
    }
  }
}

/**
 * Hosts a gatekeeper's full-page management SPA in a sandboxed, network-isolated iframe. The app
 * talks to the gatekeeper only through the `ui` capability carried over the MessagePort RPC session.
 * The iframe fills its parent container.
 *
 * `path` is the app's place in the Workshop URL: a change is passed to the app (subscribeLocation)
 * without reloading the frame, and the app's own moves come back through `onPathChange`.
 */
export default function SandboxedGatekeeperApp({ frame, gatekeeperVendorId, path, onPathChange }: {
  frame: GatekeeperUiFrame,
  gatekeeperVendorId: string,
  path: string,
  onPathChange: ChangePath,
}) {
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const sessionRef = useRef<{ [Symbol.dispose]?(): void } | null>(null)
  const hostRef = useRef<GatekeeperAppHostImpl | null>(null)
  const connectedRef = useRef(false)
  const invalidatedRef = useRef(false)
  const [overlay, setOverlay] = useState<OverlayState>(null)
  // The open picker owns the receiver dup and settles `selectUsers()` on close or cancellation.
  // State drives rendering; the ref lets callbacks check identity before settling, so late
  // callbacks from a cancelled picker cannot close a newly opened picker.
  const [userPicker, setUserPicker] = useState<UserPicker | null>(null)
  const openPickerRef = useRef<UserPicker | null>(null)
  const nextPickerId = useRef(0)
  const overlayRef = useRef<OverlayState>(null)
  // Push the Workshop's resolved light/dark mode and deployment accent whenever either changes.
  const { resolvedThemeMode } = useTheme()
  const configuredAccentColor = useServerConfig()?.accentColor
  const accentColor = configuredAccentColor && isHexColor(configuredAccentColor)
    ? configuredAccentColor
    : null
  const themeRef = useRef<GatekeeperAppTheme>({ mode: resolvedThemeMode, accentColor })
  themeRef.current = { mode: resolvedThemeMode, accentColor }
  useEffect(() => {
    hostRef.current?.updateTheme({ mode: resolvedThemeMode, accentColor })
  }, [resolvedThemeMode, accentColor])
  // The location is pushed the same way. The host outlives renders, so it reaches the latest
  // `onPathChange` through a ref rather than restarting the session when the callback changes.
  const pathRef = useRef(path)
  pathRef.current = path
  useEffect(() => {
    hostRef.current?.updateLocation(path)
  }, [path])
  const onPathChangeRef = useRef(onPathChange)
  onPathChangeRef.current = onPathChange
  const changePath = useCallback<ChangePath>(
    (next, options) => onPathChangeRef.current(next, options),
    [],
  )
  const refreshNav = useCallback(() => refreshGatekeeperApps(authenticatedApi), [authenticatedApi])

  const setOverlayPhase = useCallback((next: OverlayState) => {
    if (overlayRef.current === next) return
    overlayRef.current = next
    setOverlay(next)
  }, [])

  // Grow the iframe to full-viewport (or restore it), then report back the pane rect and whether the
  // size actually changed.
  const present = useCallback<PresentController>((active) => {
    const el = iframeRef.current
    const before = el?.getBoundingClientRect()
    // Duplicate restores are common during cleanup; avoid forcing layout when already restored.
    if (!active && overlayRef.current === null) return { rect: null, willResize: false }
    flushSync(() => setOverlayPhase(active ? 'full' : null))
    const after = el?.getBoundingClientRect()
    const willResize =
      !!before && !!after && (before.width !== after.width || before.height !== after.height)
    // On open, `before` is the pane rect the app pins to.
    const rect =
      active && before
        ? { left: before.left, top: before.top, width: before.width, height: before.height }
        : null
    return { rect, willResize }
  }, [setOverlayPhase])
  const openTarget = useCallback<OpenTarget>(({ workspaceId, gadgetId }) => {
    navigate({
      to: '/workspace/$id',
      params: { id: workspaceId },
      search: gadgetId === undefined ? {} : { w: gadgetId },
    })
  }, [navigate])
  const titlesRef = useRef<{ at: number, titles: Promise<Map<string, string>> } | null>(null)
  const resolveWorkspaceTitles = useCallback<ResolveWorkspaceTitles>(async (ids) => {
    let entry = titlesRef.current
    if (!entry || Date.now() - entry.at >= WORKSPACE_TITLES_TTL_MS) {
      entry = {
        at: Date.now(),
        titles: authenticatedApi.listWorkspaces()
          .then((gadgets) => new Map(gadgets.map((gadget) => [gadget.id, gadget.title]))),
      }
      titlesRef.current = entry
      // Don't cache a failure: drop it so the next lookup retries.
      const failed = entry
      entry.titles.catch(() => {
        if (titlesRef.current === failed) titlesRef.current = null
      })
    }
    const titles = await entry.titles
    return ids.map((id) => titles.get(id) ?? null)
  }, [authenticatedApi])
  const openPrompt = useCallback<OpenPrompt>((prompt) => {
    navigate({ to: '/', search: { prompt } })
  }, [navigate])
  const openUserPicker = useCallback<OpenUserPicker>((receiver) => {
    if (openPickerRef.current) {
      throw new Error('A person picker is already open.')
    }
    // Promise.withResolvers is not in this package's ES2023 TypeScript lib.
    let resolve!: () => void
    const promise = new Promise<void>((resolver) => {
      resolve = resolver
    })
    const open: UserPicker = { id: ++nextPickerId.current, receiver, deliveries: new Set(), resolve }
    openPickerRef.current = open
    setUserPicker(open)
    return promise
  }, [])
  // Normal closing waits for deliveries; cancellation releases ownership immediately even if
  // a receiver never settles. Neither path may dispose or settle the same picker twice.
  const finishUserPicker = useCallback((open: UserPicker) => {
    if (openPickerRef.current !== open) return
    openPickerRef.current = null
    setUserPicker(null)
    open.receiver[Symbol.dispose]()
    for (const delivery of open.deliveries) delivery[Symbol.dispose]()
    open.deliveries.clear()
    open.resolve()
  }, [])
  const cancelUserPicker = useCallback<CancelUserPicker>(() => {
    const open = openPickerRef.current
    if (open) finishUserPicker(open)
  }, [finishUserPicker])
  // The gatekeeper-defined capability remains opaque; this host only relays it through `ui`.
  const capabilityRef = useRef<unknown>(null)
  capabilityRef.current = frame.ui

  useEffect(() => {
    connectedRef.current = false
    invalidatedRef.current = false

    const connect = (port: MessagePort) => {
      if (connectedRef.current) {
        // A second handshake (e.g. iframe reloaded) invalidates the session.
        invalidatedRef.current = true
        port.close()
        sessionRef.current?.[Symbol.dispose]?.()
        sessionRef.current = null
        hostRef.current?.dispose()
        hostRef.current = null
        setOverlayPhase(null)
        return
      }
      if (invalidatedRef.current || !capabilityRef.current) {
        port.close()
        return
      }
      const host = new GatekeeperAppHostImpl(
        capabilityRef.current,
        present,
        themeRef.current,
        openTarget,
        openPrompt,
        resolveWorkspaceTitles,
        openUserPicker,
        cancelUserPicker,
        pathRef.current,
        changePath,
        refreshNav,
      )
      hostRef.current = host
      sessionRef.current = newMessagePortRpcSession(port, host)
      connectedRef.current = true
    }

    const handleMessage = (event: MessageEvent) => {
      // Only accept the handshake from our own sandboxed iframe (which posts from a null origin).
      // Capture contentWindow first: if the frame isn't mounted there's no legitimate sender, so
      // reject — comparing against a concrete window avoids a `source === undefined` edge.
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow || event.origin !== 'null') return
      if (invalidatedRef.current) return
      if (forwardTrustedFrameError(
        event, frameWindow, { surface: 'gatekeeper-app', gatekeeperVendorId },
      )) return
      if (event.data?.type === 'handshake' && event.ports?.[0]) {
        connect(event.ports[0])
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      sessionRef.current?.[Symbol.dispose]?.()
      sessionRef.current = null
      hostRef.current?.dispose()
      hostRef.current = null
      setOverlayPhase(null)
    }
    // Re-establish the session if either the HTML or the `ui` capability changes, so a new frame
    // carrying a fresh stub (even with identical HTML) never keeps talking through the stale one.
  }, [frame.iframeHtml, frame.ui, gatekeeperVendorId, cancelUserPicker, changePath, openPrompt,
      openTarget, openUserPicker, present, refreshNav, resolveWorkspaceTitles, setOverlayPhase])

  return (
    <>
      <iframe
        ref={iframeRef}
        srcDoc={frame.iframeHtml}
        // allow-scripts: run the app's JS. allow-modals: its beforeunload unsaved-changes guard.
        // allow-downloads: files it builds for the user (e.g. a CSV export). Not allow-same-origin
        // (the frame stays an opaque origin), and the app's CSP keeps connect-src 'none'.
        sandbox="allow-scripts allow-modals allow-downloads"
        allow="clipboard-write"
        title="Gatekeeper app"
        style={iframeStyleForOverlay(overlay)}
      />
      {userPicker && (
        <GatekeeperUserPickerDialog
          key={userPicker.id}
          authenticatedApi={authenticatedApi}
          gatekeeperId={gatekeeperVendorId}
          onSelected={async (selection) => {
            if (openPickerRef.current !== userPicker) {
              return Promise.reject(new Error(USER_PICKER_CANCELLED))
            }
            const delivery = userPicker.receiver.receive(selection)
            userPicker.deliveries.add(delivery)
            try {
              await delivery
            } finally {
              if (userPicker.deliveries.delete(delivery)) delivery[Symbol.dispose]()
            }
          }}
          onClose={() => finishUserPicker(userPicker)}
          onCancel={() => finishUserPicker(userPicker)}
        />
      )}
    </>
  )
}
