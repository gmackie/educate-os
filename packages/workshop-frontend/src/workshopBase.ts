// The Workshop's mount point on its origin, as plain functions of the configured base. Kept free of
// `import.meta.env` and the DOM so vite.config.ts can share it; the app uses `workshopPath.ts`.

/**
 * Normalises a configured base to the form Vite uses for `base`: `/` or `/segment(s)/`.
 * Accepts it with or without the leading and trailing slash (`ai`, `/ai`, `/ai/`). Throws on
 * anything that is not a plain path, so a typo fails the build rather than shipping broken URLs.
 */
export function normalizeWorkshopBase(value: string | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (trimmed === '' || trimmed === '/') return '/'
  const inner = trimmed.replace(/^\//, '').replace(/\/$/, '')
  if (!/^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/.test(inner) ||
      inner.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error(`Invalid Workshop base path: ${JSON.stringify(value)}`)
  }
  return `/${inner}/`
}

/**
 * `path` (origin-relative, starting with a single `/`) under `base`: `/api` under `/` is `/api`,
 * under `/ai/` it is `/ai/api`. Query and fragment are kept.
 */
export function joinWorkshopPath(base: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error(`Workshop paths must be origin-relative: ${JSON.stringify(path)}`)
  }
  const normalized = normalizeWorkshopBase(base)
  return normalized === '/' ? path : normalized.slice(0, -1) + path
}

/** The TanStack Router `basepath` for a base: `/` at the root, `/ai` under `/ai/`. */
export function routerBasepathFor(base: string): string {
  const normalized = normalizeWorkshopBase(base)
  return normalized === '/' ? '/' : normalized.slice(0, -1)
}

/**
 * Whether a Workshop at `base` shares its origin with a district's LMS: only a district origin
 * mounts it below the root (`/ai/`, SCHO-259), where it draws the school's frame and takes "Ask AI
 * about this" links (SCHO-260).
 */
export function isDistrictOrigin(base: string): boolean {
  return normalizeWorkshopBase(base) !== '/'
}
