import { describe, expect, it } from 'vitest';
import router, { type Env } from '../src/index';
import { legacyRedirect, parseLegacyHosts } from '../src/legacy-hosts';

// ADR-0014 §7: the old hostnames stay on the router and answer with redirects to the one origin.

const LEGACY_HOSTS = JSON.stringify({
  'schoolos.gmac.io': 'https://northfield.educateos.io/ai',
  'district.schoolos.gmac.io': 'https://northfield.educateos.io',
});

function env(extra: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fetcher = (label: string) => ({
    fetch: async (input: RequestInfo, init?: RequestInit) => {
      const req = new Request(input, init);
      await req.arrayBuffer();
      calls.push(`${label} ${new URL(req.url).host}${new URL(req.url).pathname}`);
      return new Response(label);
    },
  }) as unknown as Fetcher;
  return {
    calls,
    env: {
      WORKSHOP_BACKEND: fetcher('backend'),
      ASSETS: fetcher('assets'),
      DISTRICT: fetcher('district'),
      GATEKEEPER_GOOGLE: fetcher('google'),
      LEGACY_HOSTS,
      ...extra,
    } as Env,
  };
}

async function call(e: Env, url: string, init?: RequestInit) {
  const res = await router.fetch!(new Request(url, init), e, {} as ExecutionContext);
  await res.text();
  return res;
}

describe('legacy hostname redirects', () => {
  const table: [string, string][] = [
    ['https://schoolos.gmac.io/', 'https://northfield.educateos.io/ai/'],
    ['https://schoolos.gmac.io/blueprints/1?tab=x', 'https://northfield.educateos.io/ai/blueprints/1?tab=x'],
    ['https://schoolos.gmac.io/api/device-session/callback?state=s', 'https://northfield.educateos.io/ai/api/device-session/callback?state=s'],
    // Gatekeepers stay at the root of the district origin.
    ['https://schoolos.gmac.io/gatekeeper/google/oauth?code=1', 'https://northfield.educateos.io/gatekeeper/google/oauth?code=1'],
    ['https://schoolos.gmac.io/gatekeepers', 'https://northfield.educateos.io/ai/gatekeepers'],
    ['https://district.schoolos.gmac.io/', 'https://northfield.educateos.io/'],
    ['https://district.schoolos.gmac.io/teach/classes?x=1', 'https://northfield.educateos.io/teach/classes?x=1'],
    ['https://district.schoolos.gmac.io/lti/launch', 'https://northfield.educateos.io/lti/launch'],
    ['https://district.schoolos.gmac.io/.well-known/educateos.json', 'https://northfield.educateos.io/.well-known/educateos.json'],
  ];
  for (const [from, to] of table) {
    it(`GET ${from} → 301 ${to}`, async () => {
      const { env: e, calls } = env();
      const res = await call(e, from);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe(to);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(calls).toEqual([]);
    });
  }

  it('keeps the method and body of anything but GET and HEAD with a 308', async () => {
    const { env: e, calls } = env();
    const post = await call(e, 'https://district.schoolos.gmac.io/lti/launch', { method: 'POST', body: 'id_token=x' });
    expect(post.status).toBe(308);
    expect(post.headers.get('location')).toBe('https://northfield.educateos.io/lti/launch');
    expect((await call(e, 'https://schoolos.gmac.io/x', { method: 'HEAD' })).status).toBe(301);
    expect(calls).toEqual([]);
  });

  it('still answers /healthz on an old hostname, for the deployer\'s probe', async () => {
    const { env: e } = env();
    const res = await router.fetch!(new Request('https://schoolos.gmac.io/healthz'), e, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('routes the new origin and unlisted hostnames as before', async () => {
    const { env: e, calls } = env();
    expect((await call(e, 'https://northfield.educateos.io/teach/')).status).toBe(200);
    expect((await call(e, 'https://northfield.educateos.io/ai/api')).status).toBe(200);
    expect((await call(e, 'https://other.example/gatekeeper/google/x')).status).toBe(200);
    expect(calls).toEqual([
      'district northfield.educateos.io/teach/',
      'backend northfield.educateos.io/ai/api',
      'google other.example/gatekeeper/google/x',
    ]);
  });

  it('redirects nothing when LEGACY_HOSTS is unset or empty', async () => {
    for (const value of [undefined, '', '{}']) {
      const { env: e, calls } = env({ LEGACY_HOSTS: value });
      expect((await call(e, 'https://schoolos.gmac.io/teach/')).status).toBe(200);
      expect(calls).toEqual(['district schoolos.gmac.io/teach/']);
    }
  });

  it('fails closed on an invalid LEGACY_HOSTS, apart from /healthz', async () => {
    for (const value of ['not json', '[]', '{"schoolos.gmac.io": 1}', '{"x": "https://a.example"}',
      '{"schoolos.gmac.io": "http://a.example"}', '{"schoolos.gmac.io": "https://a.example/ai/"}',
      '{"schoolos.gmac.io": "https://a.example/?q=1"}', '{"schoolos.gmac.io": "https://schoolos.gmac.io/ai"}']) {
      const { env: e, calls } = env({ LEGACY_HOSTS: value });
      expect((await call(e, 'https://northfield.educateos.io/')).status, value).toBe(500);
      expect((await call(e, 'https://northfield.educateos.io/healthz')).status).toBe(200);
      expect(calls).toEqual([]);
    }
  });

  it('parses hostnames to their prefixes', () => {
    const hosts = parseLegacyHosts(LEGACY_HOSTS);
    expect([...hosts.keys()]).toEqual(['schoolos.gmac.io', 'district.schoolos.gmac.io']);
    expect(legacyRedirect(new Request('https://elsewhere.example/'), hosts)).toBeUndefined();
  });
});
