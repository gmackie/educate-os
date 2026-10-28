/**
 * Every failure a district call can surface. Messages are written for people: native fetch errors,
 * redirect bodies and server stack text never reach the UI.
 */
export type DistrictErrorCode =
  | 'needs-access' | 'needs-sign-in' | 'needs-pairing' | 'device-revoked' | 'unreachable'
  | 'unavailable' | 'unauthenticated' | 'forbidden' | 'not-found' | 'conflict' | 'validation-failed'
  | (string & {});

export class DistrictApiError extends Error {
  constructor(public readonly status: number, public readonly code: DistrictErrorCode, message: string) {
    super(message);
    this.name = 'DistrictApiError';
  }
}

export const MESSAGES = {
  needsSignIn: 'Your school needs a fresh sign-in before classes can load on this phone. Your AI workspace still works.',
  needsPairing: 'This phone needs to be connected to your school again.',
  revoked: 'This phone was signed out by your school.',
  unreachable: "We couldn't reach your school. Check your internet connection and try again.",
  unavailable: 'Your school could not complete this request. Try again in a moment.',
  deviceAuthUnavailable: "Your school hasn't turned on phone sign-in yet.",
} as const;

/** A redirect is always an identity provider asking for a sign-in, never data. */
export function isRedirect(response: Response): boolean {
  return response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
}

/** The district's own error body, if it has one; never raw text. */
export async function errorFrom(response: Response): Promise<DistrictApiError> {
  const value: unknown = await response.json().catch(() => null);
  const body = value && typeof value === 'object' ? value as { code?: unknown; message?: unknown } : {};
  const code = typeof body.code === 'string' && /^[a-z-]{1,40}$/.test(body.code) ? body.code : 'unavailable';
  const message = typeof body.message === 'string' && body.message.length <= 300 ? body.message : MESSAGES.unavailable;
  return new DistrictApiError(response.status, code, message);
}
