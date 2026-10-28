// "Ask AI about this" on a district origin (SCHO-260): the LMS links to `/ai/?context=assignment:<id>`
// or `?context=submission:<id>`. As the app starts the reference is taken off the URL (so it is
// neither bookmarked nor sent on with a shared link) and held until the home page asks the backend
// to check it with the district. Only what the backend confirms is attached to the new chat; see
// workshop-shared's school-context.ts.
//
// Mounted at an origin's root (schoolos.gmac.io) there is no district to ask, so the parameter is
// left alone.

import { useCallback, useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  formatSchoolContextRef,
  parseSchoolContextRef,
  type SchoolContext,
  type SchoolContextRef,
} from '@gadgets/workshop-shared/school-context'
import { isDistrictOrigin } from '../../workshopBase'
import { WORKSHOP_BASE } from '../../workshopPath'

/** The query parameter a context link carries. */
export const SCHOOL_CONTEXT_PARAM = 'context'

/** What `takeSchoolContextFromUrl` found: nothing, a reference to check, or one malformed from the start. */
export type PendingSchoolContext = { kind: 'ref'; ref: SchoolContextRef } | { kind: 'malformed' }

let pending: PendingSchoolContext | undefined

/**
 * Takes `?context=` off the current URL, without a navigation, and holds what it named for the
 * home page. On a Workshop mounted at the root, does nothing.
 */
export function takeSchoolContextFromUrl(
  base: string = WORKSHOP_BASE,
  location: Pick<Location, 'href'> = window.location,
  history: Pick<History, 'replaceState' | 'state'> = window.history,
): PendingSchoolContext | undefined {
  if (!isDistrictOrigin(base)) return undefined
  const url = new URL(location.href)
  if (!url.searchParams.has(SCHOOL_CONTEXT_PARAM)) return undefined
  const raw = url.searchParams.get(SCHOOL_CONTEXT_PARAM)
  url.searchParams.delete(SCHOOL_CONTEXT_PARAM)
  history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  const ref = parseSchoolContextRef(raw)
  pending = ref === undefined ? { kind: 'malformed' } : { kind: 'ref', ref }
  return pending
}

/** The reference waiting to be checked, if any. */
export function pendingSchoolContext(): PendingSchoolContext | undefined {
  return pending
}

/** Forgets the waiting reference: once the home page has dealt with it, and in tests. */
export function clearPendingSchoolContext(): void {
  pending = undefined
}

/** What the home page does about a context link. */
export type SchoolContextOutcome =
  | { status: 'none' }
  | { status: 'checking' }
  | { status: 'attached'; context: SchoolContext }
  | { status: 'refused' }

/**
 * Checks the waiting reference with the backend once and reports the outcome. A malformed
 * reference is refused without asking; a deployment with no district quietly ignores it.
 */
export function useSchoolContextLink(
  authenticatedApi: RpcStub<AuthenticatedApi>,
): [SchoolContextOutcome, () => void] {
  const [outcome, setOutcome] = useState<SchoolContextOutcome>(() =>
    pending === undefined ? { status: 'none' } : pending.kind === 'malformed' ? { status: 'refused' } : { status: 'checking' })

  useEffect(() => {
    const waiting = pending
    if (waiting === undefined) return
    if (waiting.kind === 'malformed') {
      clearPendingSchoolContext()
      return
    }
    let cancelled = false
    authenticatedApi.resolveSchoolContext(formatSchoolContextRef(waiting.ref)).then(
      (resolution) => {
        if (cancelled) return
        clearPendingSchoolContext()
        setOutcome(resolution.status === 'attached'
          ? { status: 'attached', context: resolution.context }
          : resolution.status === 'refused' ? { status: 'refused' } : { status: 'none' })
      },
      () => {
        if (cancelled) return
        clearPendingSchoolContext()
        setOutcome({ status: 'refused' })
      },
    )
    return () => { cancelled = true }
  }, [authenticatedApi])

  const dismiss = useCallback(() => setOutcome({ status: 'none' }), [])
  return [outcome, dismiss]
}
