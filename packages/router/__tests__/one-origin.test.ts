import { describe, expect, it } from 'vitest';
import router, { type Env } from '../src/index';
import { districtOriginTarget, LEGACY_WORKSHOP_EXACT_PATHS, LEGACY_WORKSHOP_PREFIXES } from '../src/one-origin';

// ADR-0014: with a DISTRICT binding the router owns the district's whole origin.

interface Recorded { label: string; path: string; method: string; headers: Headers }

/** A fetcher that answers with its label and records what it was asked for. */
function recorder(label: string, log: Recorded[], answer?: (req: Request) => Response | undefined): Fetcher {
  return {
    fetch: async (input: RequestInfo, init?: RequestInit) => {
      const req = new Request(input, init);
      await req.arrayBuffer();
      const url = new URL(req.url);
      log.push({ label, path: url.pathname + url.search, method: req.method, headers: req.headers });
      return answer?.(req) ?? new Response(label);
    },
  } as unknown as Fetcher;
}

function oneOriginEnv(extra: Record<string, unknown> = {}) {
  const log: Recorded[] = [];
  const env = {
    WORKSHOP_BACKEND: recorder('backend', log),
    ASSETS: recorder('assets', log),
    DISTRICT: recorder('district', log),
    GATEKEEPER_GOOGLE: recorder('google', log),
    GATEKEEPER_EDUCATEOS: recorder('educateos', log),
    CF_VERSION_METADATA: { id: 'v', tag: 'r42:abcd1234', timestamp: '' },
    ...extra,
  } as Env;
  return { env, log };
}

async function call(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return router.fetch!(new Request(`https://northfield.educateos.io${path}`, init), env, {} as ExecutionContext);
}

/** Routes `path` and says which binding answered, at which path. */
async function routeOf(env: Env, log: Recorded[], path: string): Promise<string> {
  const before = log.length;
  const res = await call(env, path);
  const body = await res.text();
  const hit = log.slice(before).at(-1);
  return hit ? `${hit.label} ${hit.path}` : `router ${res.status} ${body.slice(0, 40)}`;
}

describe('the district origin path table (DISTRICT bound)', () => {
  const table: [string, string][] = [
    ['/healthz', 'router 200 ok'],
    ['/gatekeeper/google', 'google /gatekeeper/google'],
    ['/gatekeeper/google/oauth?code=1', 'google /gatekeeper/google/oauth?code=1'],
    ['/gatekeeper/educateos/connect', 'educateos /gatekeeper/educateos/connect'],
    ['/gatekeeper/not-installed', 'district /gatekeeper/not-installed'],
    // The Workshop under /ai: its RPC reaches the backend with the URL unchanged.
    ['/ai/api', 'backend /ai/api'],
    ['/ai/api/router-tag', 'backend /ai/api/router-tag'],
    ['/ai/api/device-session/callback?state=s', 'backend /ai/api/device-session/callback?state=s'],
    // Its SPA from the Workshop's assets with /ai stripped.
    ['/ai', 'assets /'],
    ['/ai/', 'assets /'],
    ['/ai/assets/index-abc.js', 'assets /assets/index-abc.js'],
    ['/ai/blueprints/123?tab=x', 'assets /blueprints/123?tab=x'],
    ['/ai/apiary', 'assets /apiary'],
    // Legacy Workshop endpoints at the root, for one release.
    ['/api', 'backend /api'],
    ['/api/router-tag', 'backend /api/router-tag'],
    ['/api/site-logo', 'backend /api/site-logo'],
    ['/api/client-errors', 'backend /api/client-errors'],
    ['/api/device-session/callback', 'backend /api/device-session/callback'],
    ['/blueprint-screenshot', 'backend /blueprint-screenshot'],
    ['/blueprint-screenshot/abc', 'backend /blueprint-screenshot/abc'],
    // Everything else is the district's.
    ['/', 'district /'],
    ['/admin/', 'district /admin/'],
    ['/teach/', 'district /teach/'],
    ['/assets/index-def.js', 'district /assets/index-def.js'],
    ['/api/', 'district /api/'],
    ['/api/me', 'district /api/me'],
    ['/api/student/classes', 'district /api/student/classes'],
    ['/api/m/today', 'district /api/m/today'],
    ['/api/pair/rooms', 'district /api/pair/rooms'],
    ['/api/ops/health', 'district /api/ops/health'],
    ['/api/health', 'district /api/health'],
    ['/api/version', 'district /api/version'],
    ['/api/client-errors/more', 'district /api/client-errors/more'],
    ['/api/device-sessions', 'district /api/device-sessions'],
    ['/lti/login', 'district /lti/login'],
    ['/.well-known/educateos.json', 'district /.well-known/educateos.json'],
    ['/aide', 'district /aide'],
    ['/healthz/more', 'district /healthz/more'],
    ['/blueprint-screenshots', 'district /blueprint-screenshots'],
  ];

  for (const [path, expected] of table) {
    it(`${path} → ${expected}`, async () => {
      const { env, log } = oneOriginEnv();
      expect(await routeOf(env, log, path)).toBe(expected);
    });
  }

  it('stamps the router tag on Workshop backend requests, and not on the district', async () => {
    const { env, log } = oneOriginEnv();
    await (await call(env, '/ai/api', { headers: { 'Cloudflare-OS-Router-Version': 'forged' } })).text();
    await (await call(env, '/api/me', { headers: { 'Cf-Access-Jwt-Assertion': 'jwt' } })).text();
    expect(log[0].headers.get('Cloudflare-OS-Router-Version')).toBe('r42:abcd1234');
    expect(log[1].label).toBe('district');
    expect(log[1].headers.get('Cloudflare-OS-Router-Version')).toBeNull();
    expect(log[1].headers.get('Cf-Access-Jwt-Assertion')).toBe('jwt');
  });

  it('passes the district its method and body unchanged', async () => {
    const bodies: string[] = [];
    const district = {
      fetch: async (req: Request) => {
        bodies.push(`${req.method} ${await req.text()}`);
        return new Response('district');
      },
    } as unknown as Fetcher;
    const { env } = oneOriginEnv({ DISTRICT: district });
    await (await call(env, '/api/admin/classes', { method: 'POST', body: '{"a":1}' })).text();
    expect(bodies).toEqual(['POST {"a":1}']);
  });

  it('passes a WebSocket upgrade on /ai/api through to the backend', async () => {
    const backend = {
      fetch: async () => {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        return new Response(null, { status: 101, webSocket: client });
      },
    } as unknown as Fetcher;
    const { env } = oneOriginEnv({ WORKSHOP_BACKEND: backend });
    const res = await call(env, '/ai/api', { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    res.webSocket!.accept();
    res.webSocket!.close();
  });

  it("falls back to the Workshop SPA's index.html when an /ai asset is missing", async () => {
    const log: Recorded[] = [];
    const assets = recorder('assets', log, (req) =>
      new URL(req.url).pathname === '/' ? new Response('index') : new Response('nope', { status: 404 }));
    const { env } = oneOriginEnv({ ASSETS: assets });
    const res = await call(env, '/ai/threads/42?x=1');
    expect(await res.text()).toBe('index');
    expect(log.map(({ path }) => path)).toEqual(['/threads/42?x=1', '/']);
    // Not for a POST.
    expect((await call(env, '/ai/threads/42', { method: 'POST' })).status).toBe(404);
  });

  it('puts root-relative redirects from the Workshop assets back under /ai', async () => {
    const assets = recorder('assets', [], (req) => new URL(req.url).pathname === '/foo/index.html'
      ? new Response(null, { status: 307, headers: { Location: '/foo/' } })
      : new URL(req.url).pathname === '/ext'
        ? new Response(null, { status: 302, headers: { Location: 'https://example.com/' } })
        : undefined);
    const { env } = oneOriginEnv({ ASSETS: assets });
    expect((await call(env, '/ai/foo/index.html')).headers.get('Location')).toBe('/ai/foo/');
    expect((await call(env, '/ai/ext')).headers.get('Location')).toBe('https://example.com/');
  });

  it('serves the Workshop frontend through the backend at the stripped path in dev (no ASSETS)', async () => {
    const { env, log } = oneOriginEnv({ ASSETS: undefined });
    expect(await routeOf(env, log, '/ai/blueprints/1')).toBe('backend /blueprints/1');
    expect(await routeOf(env, log, '/ai/api')).toBe('backend /ai/api');
    expect(await routeOf(env, log, '/')).toBe('district /');
  });
});

describe('a district origin with no AI', () => {
  for (const extra of [{ AI_ENABLED: 'false' }, { WORKSHOP_BACKEND: undefined }]) {
    const label = 'AI_ENABLED' in extra ? 'AI_ENABLED=false' : 'no WORKSHOP_BACKEND';

    it(`serves /ai as a themed page (${label})`, async () => {
      const { env, log } = oneOriginEnv({ ...extra, AI_DEMO_URL: 'https://northfield.educateos.io/ai' });
      for (const path of ['/ai', '/ai/', '/ai/threads/1']) {
        const res = await call(env, path);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        const html = await res.text();
        expect(html).toContain("AI isn't enabled at your school");
        expect(html).toContain('href="https://northfield.educateos.io/ai"');
        expect(html).toContain('prefers-color-scheme: dark');
      }
      expect(log).toEqual([]);
    });

    it(`answers /ai/api with a 404 and sends legacy Workshop paths to the district (${label})`, async () => {
      const { env, log } = oneOriginEnv(extra);
      const res = await call(env, '/ai/api');
      expect(res.status).toBe(404);
      await res.text();
      expect(await routeOf(env, log, '/api')).toBe('district /api');
      expect(await routeOf(env, log, '/api/site-logo')).toBe('district /api/site-logo');
      expect(await routeOf(env, log, '/blueprint-screenshot/x')).toBe('district /blueprint-screenshot/x');
      expect(await routeOf(env, log, '/')).toBe('district /');
      expect(log.some(({ label: l }) => l === 'backend' || l === 'assets')).toBe(false);
    });
  }

  it('leaves the demo link out unless it is an http(s) URL, and escapes it', async () => {
    const noLink = oneOriginEnv({ AI_ENABLED: 'false' });
    expect(await (await call(noLink.env, '/ai')).text()).not.toContain('demo district');
    const script = oneOriginEnv({ AI_ENABLED: 'false', AI_DEMO_URL: 'javascript:alert(1)' });
    expect(await (await call(script.env, '/ai')).text()).not.toContain('javascript:');
    const quoted = oneOriginEnv({ AI_ENABLED: 'false', AI_DEMO_URL: 'https://demo.example/?a="><script>' });
    const html = await (await call(quoted.env, '/ai')).text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('demo district');
  });

  it('serves the Workshop when AI_ENABLED is anything but "false"', async () => {
    for (const value of ['true', '', 'yes']) {
      const { env, log } = oneOriginEnv({ AI_ENABLED: value });
      expect(await routeOf(env, log, '/ai/api')).toBe('backend /ai/api');
    }
  });
});

describe('without DISTRICT bound (today\'s instances)', () => {
  // The router's original table, unchanged: AI_ENABLED is ignored and nothing moves under /ai.
  const table: [string, string][] = [
    ['/healthz', 'router 200 ok'],
    ['/gatekeeper/google/oauth', 'google /gatekeeper/google/oauth'],
    ['/gatekeeper/not-installed', 'assets /gatekeeper/not-installed'],
    ['/api', 'backend /api'],
    ['/api/me', 'backend /api/me'],
    ['/api/student/classes', 'backend /api/student/classes'],
    ['/blueprint-screenshot/abc', 'backend /blueprint-screenshot/abc'],
    ['/ai', 'assets /ai'],
    ['/ai/api', 'assets /ai/api'],
    ['/lti/login', 'assets /lti/login'],
    ['/.well-known/educateos.json', 'assets /.well-known/educateos.json'],
    ['/', 'assets /'],
  ];
  for (const [path, expected] of table) {
    it(`${path} → ${expected}`, async () => {
      const { env, log } = oneOriginEnv({ DISTRICT: undefined, AI_ENABLED: 'false' });
      expect(await routeOf(env, log, path)).toBe(expected);
    });
  }
});

describe('districtOriginTarget', () => {
  it('never claims a district API family for the Workshop', () => {
    const district = ['student', 'teacher', 'admin', 'guardian', 'me', 'calendar', 'onboarding', 'lti', 'm', 'pair', 'ops'];
    for (const family of district) {
      for (const path of [`/api/${family}`, `/api/${family}/x`]) {
        expect(districtOriginTarget(path, true), path).toBe('district');
      }
    }
    for (const path of [...LEGACY_WORKSHOP_EXACT_PATHS, ...LEGACY_WORKSHOP_PREFIXES]) {
      expect(path.startsWith('/ai')).toBe(false);
    }
  });
});
