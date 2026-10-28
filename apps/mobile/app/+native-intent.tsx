// Every URL that opens the app passes through here first (expo-router). School codes are parsed and
// held in memory (src/links.ts), never put in a route; sign-in callbacks go to the waiting auth
// session; everything else (`educateos://class/<id>`, …) is routed by file name.
import { classifyIncomingUrl, isOwnRoomReturn, setPendingLink } from '../src/links';
import { consumeIncomingUrl } from '../src/auth/auth';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string | null {
  try {
    const incoming = classifyIncomingUrl(path);
    // The connect page returning to a room this phone is already polling: stay where we are.
    if (isOwnRoomReturn(incoming)) return null;
    switch (incoming.kind) {
      case 'join': case 'enroll': case 'invalid':
        setPendingLink(incoming);
        return '/connect';
      case 'legacy-pair':
        setPendingLink(incoming);
        return '/legacy-pair';
      case 'auth-callback':
        consumeIncomingUrl(path);
        return null;
      case 'route':
        return path;
    }
  } catch {
    return '/';
  }
}
