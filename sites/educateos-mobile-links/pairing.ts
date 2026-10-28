export type School = { name: string; portal: string; workshop: string };
export type Claim = { state: string; publicKey: string; code: string };
export type Pairing = {
  school: School; expiresAt: number; browserHash: string; phoneHash: string;
  claim?: Claim; approved?: boolean; callback?: string;
};
const HEX = /^[0-9a-f]{64}$/;
export const validToken = (value: string): boolean => HEX.test(value);
export const hash = async (value: string): Promise<string> => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
export const token = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export function schoolDetails(value: unknown): School {
  if (!value || typeof value !== 'object') throw new Error('Invalid school');
  const { name, portal, workshop } = value as Record<string, unknown>;
  if (typeof name !== 'string' || name.trim().length < 2 || name.length > 90) throw new Error('Invalid school');
  for (const origin of [portal, workshop]) {
    if (typeof origin !== 'string' || new URL(origin).origin !== origin || !origin.startsWith('https://') || new URL(origin).port) throw new Error('Invalid school origin');
  }
  return { name: name.trim(), portal: portal as string, workshop: workshop as string };
}
export async function makeClaim(id: string, value: unknown): Promise<Claim> {
  if (!value || typeof value !== 'object') throw new Error('Invalid phone request');
  const { state, publicKey } = value as Record<string, unknown>;
  if (typeof state !== 'string' || !new RegExp(`^pair-v1\\.${id}\\.[A-Za-z0-9_-]{43}$`).test(state) ||
      typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(publicKey)) throw new Error('Invalid phone request');
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='), c => c.charCodeAt(0));
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error('Invalid phone key');
  await crypto.subtle.importKey('raw', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const code = (await hash(state + '.' + publicKey)).slice(0, 8).toUpperCase();
  return { state, publicKey, code };
}
export function acceptCallback(pair: Pairing, url: URL, now = Date.now()): void {
  if (now >= pair.expiresAt || !pair.approved || !pair.claim || pair.callback ||
      url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pair.claim.state ||
      url.searchParams.get('cfos_callback') !== 'install-connected') throw new Error('Invalid or expired transfer');
  for (const key of ['publicKey', 'salt', 'iv', 'ciphertext']) {
    const all = url.searchParams.getAll(key);
    if (all.length !== 1 || !/^[A-Za-z0-9_-]+$/.test(all[0]) || all[0].length > 12000) throw new Error('Invalid transfer');
  }
  pair.callback = url.href;
}
