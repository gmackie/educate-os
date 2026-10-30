import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'

/** Presentation flag only; district and Workshop services still authorize every request. */
export const SCHOOL_MODE = import.meta.env.VITE_EDUCATEOS_SCHOOL_MODE === 'true'

const destinations = [
  { role: 'student', label: 'Student', path: '/learn' },
  { role: 'teacher', label: 'Teacher', path: '/teach' },
  { role: 'guardian', label: 'Guardian', path: '/learn/family' },
  { role: 'admin', label: 'Administrator', path: '/admin' },
] as const

/** Infer available views only from the School app's district-derived landing entries. */
export const schoolViews = (app: GatekeeperAppInfo | undefined) =>
  destinations.filter(({ path }) => app?.nav?.some((entry) => entry.path === path))

/** A URL chooses a page, never a role or an authorization grant. */
export const isSchoolRoute = (pathname: string) => pathname === '/gatekeepers/educateos'
