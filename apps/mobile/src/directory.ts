/**
 * "Find my school": the optional educateos.io directory, searched by school name or email domain.
 * Off unless app config `extra.schoolDirectory.enabled` is true, and hidden for the rest of the
 * session after any failure, so an unreachable directory never blocks the other two ways in.
 */
import { strictOrigin } from './security.ts';

export type DirectoryConfig = { enabled: boolean; url: string | null };
export type DirectoryEntry = { name: string; origin: string };

let failed = false;
export function directoryVisible(config: DirectoryConfig): boolean {
  return config.enabled && !!config.url && !failed;
}
export function markDirectoryFailed(): void { failed = true; }

export function readDirectoryConfig(extra: unknown): DirectoryConfig {
  const value = (extra as { schoolDirectory?: { enabled?: unknown; url?: unknown } } | undefined)?.schoolDirectory;
  const url = typeof value?.url === 'string' && value.url.startsWith('https://') ? value.url : null;
  return { enabled: value?.enabled === true, url };
}

/** Keeps only well-formed entries with one exact HTTPS origin each. */
export function parseDirectoryResults(value: unknown): DirectoryEntry[] {
  const list = (value as { schools?: unknown } | null)?.schools;
  if (!Array.isArray(list)) throw new Error('directory');
  const out: DirectoryEntry[] = [];
  for (const item of list.slice(0, 25)) {
    const entry = item as { name?: unknown; origin?: unknown } | null;
    if (typeof entry?.name !== 'string' || typeof entry.origin !== 'string' || entry.name.length > 200) continue;
    try {
      if (strictOrigin(entry.origin) === entry.origin) out.push({ name: entry.name, origin: entry.origin });
    } catch { /* skip */ }
  }
  return out;
}

export async function searchDirectory(config: DirectoryConfig, query: string, signal?: AbortSignal): Promise<DirectoryEntry[]> {
  if (!config.url) throw new Error('directory');
  const url = new URL(config.url);
  url.searchParams.set('q', query.trim().slice(0, 100));
  try {
    const response = await fetch(url.toString(), { redirect: 'manual', signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error('directory');
    return parseDirectoryResults(await response.json());
  } catch (e) {
    markDirectoryFailed();
    throw e;
  }
}
