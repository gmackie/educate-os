import { relayRequest, type RelayEnv } from './relay';
export { PhonePairing } from './relay';
/** Public app-link metadata and a fallback that never reflects callback credentials. */
export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/pairings' || path.startsWith('/pairings/')) return relayRequest(request, env);
    if (path === '/oauthredirect' && url.searchParams.get('state')?.startsWith('pair-v1.')) {
      const id = /^pair-v1\.([0-9a-f-]{36})\./.exec(url.searchParams.get('state')!)?.[1];
      if (!id || request.url.length > 16000) return new Response('Invalid transfer.', { status: 400 });
      const result = await env.PAIRINGS.getByName(id).fetch('https://relay/callback', { method: 'POST', body: request.url });
      return new Response(result.ok ? 'Phone connected. Return to EducateOS on your phone.' : 'This pairing has expired. Start again.', { status: result.ok ? 200 : 410, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': 'text/plain' } });
    }
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': 'text/plain; charset=utf-8' };
    if (path === '/healthz') return new Response('ok', { headers });
    if (path === '/oauthredirect' || path === '/authpopup') {
      return new Response('Return to EducateOS and start sign-in again. If this page keeps appearing, ask your school to check mobile sign-in setup.', { headers });
    }
    return env.ASSETS.fetch(request);
  },
};
