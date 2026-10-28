# ADR-0014: One origin per district

- Status: Accepted
- Date: 2026-10-28
- Issues: SCHO-259 (phase 1 of epic SCHO-257). Amends [ADR-0013](0013-educateos-open-core-control-plane.md)
  addendum A1. Design: [the one-domain plan](../../plans/2026-10-28-educateos-one-domain-design.html).

## Context

A district today is two products on two hosts. The router serves the Workshop (the AI workspace)
at the instance hostname (`schoolos.gmac.io`), and the district Worker serves the LMS at its own
hostname (`district.schoolos.gmac.io`, aliased as `northfield.educateos.io`). Each host has its own
Cloudflare Access application and audience. The Workshop keys users by Access email; the district
keys them by Access `sub` ([ADR-0003](0003-principal-identity.md)).

That split is the root cause of the mobile app's "fetch failed: Redirect is not allowed" error. The
phone signs in through the Workshop, then sends that Access token to the district host, whose own
Access edge doesn't accept it and answers with a 302 to its login page. It also means two sign-ins
in a browser, two themes, and no link between the LMS and the AI workspace.

ADR-0013 A1 made `<slug>.educateos.io` an alias of the district Worker's hostname. It said nothing
about the Workshop, because no demo district had one.

## Decision

1. **One district, one origin.** Each district is served at one hostname: `<slug>.educateos.io` or
   its own domain. The two work the same way. The router owns that hostname and splits it by path.
   The Workshop and district stay separate Workers behind it.

2. **The path table.**

   | Path | Goes to | Access |
   |---|---|---|
   | `/healthz` | the router itself | bypass |
   | `/.well-known/educateos.json` | district: the public school manifest | bypass |
   | `/`, `/classes`, `/calendar`, `/inbox`, `/family`, `/teach/*`, `/admin/*`, the UI assets | district assets | Access |
   | `/api/*` (except the three below) | district Worker | Access JWT |
   | `/api/m/*` | district: the phones' device-token API | bypass; the Worker enforces device auth on every route |
   | `/api/pair/*` | district: the pairing relay | bypass; room-secret auth |
   | `/api/ops/*` | district: the signed admin operations API | bypass; Ed25519 request signatures |
   | `/lti/*` | district: the LTI Tool | bypass, as today |
   | `/ai`, `/ai/*` | Workshop SPA (Vite base `/ai/`), from the Workshop's assets with `/ai` stripped and SPA fallback | Access |
   | `/ai/api`, `/ai/api/*` | Workshop backend, URL unchanged | Access |
   | `/gatekeeper/*` | gatekeepers, unchanged, so registered OAuth redirect URIs keep working | Access |

   The Workshop backend receives `/ai/api...` URLs unchanged and accepts both `/api...` and
   `/ai/api...`. For one release the router also sends the Workshop's old root endpoints to its
   backend, so older Workshop builds and phones keep working: exactly `/api` (the RPC socket),
   `/api/router-tag`, `/api/site-logo`, `/api/client-errors`, `/api/device-session/*` and
   `/blueprint-screenshot[/*]`. That list is what `packages/workshop-backend/src/server.ts` serves.
   (`/api/health`, `/api/version`, `/api/summarize` and `/api/channels` appear only in the
   frontend's sample data, so they aren't aliased.) None of these collides with a district route;
   if one ever does, the district wins. Everything not listed goes to the district.

3. **The router binds the district as `DISTRICT`.** The table applies only when that service
   binding is present; without it the router behaves exactly as before. A deployment that binds
   it runs the router first for every path (`run_worker_first: true`), since the Workshop's assets
   would otherwise answer `/` and shadow the district's `/assets/*`. The table is in
   `packages/router/src/one-origin.ts`, and its unit tests cover it with and without `DISTRICT`.

4. **One Access application per host.** It covers the whole hostname, with bypass paths for
   `/healthz`, `/.well-known/educateos.json`, `/lti/*`, `/api/m/*`, `/api/pair/*` and `/api/ops/*`.
   Every route under a bypass path must check its own credential before its handler runs, and a
   generated test calls each one with no credential and expects a 401. Both Workers verify the
   same assertion against the same audience, so the district's dual-audience allowance
   (`CF_ACCESS_AUD` listing the Workshop's application) is dropped once every host is on one
   application.

5. **Identity is the Access `sub`.** The Workshop binds `PRINCIPAL_RESOLVER` to the district (the
   seam from ADR-0003), so its user Durable Object is keyed by principal, not email. Northfield's
   existing email-keyed users are migrated once, with a dry run that reports counts; the demo
   districts have no Workshop users. Workshop password tokens remain only for open-source installs
   that run without Access.

6. **A public school manifest.** `GET /.well-known/educateos.json` returns version 1 of the
   manifest: the district's name and origin, its brand (logo, accent), its sign-in methods, its
   features (`ai`, `mobile`, `family`), the device API versions it speaks (`mobileApi`) and its
   release. It needs no sign-in, contains no personal data, is `public, max-age=300`, and allows
   any origin. The phone, the admin editions and the educateos.io directory read it, so nobody
   types two URLs again. The name comes from `DISTRICT_CONFIG`; the rest from the optional
   `SCHOOL_MANIFEST` var, with defaults (the request's origin, no brand, sign-in methods implied by
   the configuration, `ai: false`). The schema is `SchoolManifest` in
   `packages/educateos-district-worker/src/school-manifest.ts`. For example:

   ```json
   {
     "v": 1,
     "name": "Northfield Public Schools",
     "origin": "https://northfield.educateos.io",
     "brand": { "logo": "https://northfield.educateos.io/brand/logo.svg", "accent": "#2458ac" },
     "signIn": [{ "id": "google", "label": "Google" }, { "id": "clever", "label": "Clever" }],
     "features": { "ai": true, "mobile": true, "family": true },
     "mobileApi": { "min": 1, "max": 1 },
     "release": "r000042-ade9299"
   }
   ```

7. **The old hosts redirect.** At cutover, `schoolos.gmac.io/*` answers with a 301 to
   `northfield.educateos.io/ai/*`, and `district.schoolos.gmac.io/*` with a 301 to
   `northfield.educateos.io/*`, path and query kept.

8. **One AI-enabled demo district.** Northfield is the only demo district with a Workshop. The other
   demo districts run the router with `DISTRICT` bound and `AI_ENABLED` set to `"false"` (they may
   leave `WORKSHOP_BACKEND` unbound). Their `/ai` serves a small themed "AI isn't enabled at your
   school" page that links to Northfield through `AI_DEMO_URL`, and their `/ai/api` is a 404.

## Amendment to ADR-0013 A1

A1 said the district's own hostname stays its public base URL and data namespace, and
`<slug>.educateos.io` is an alias of the district Worker. Under this ADR:

- The hostname, managed or custom, is attached to the **router**, not the district Worker. The
  district Worker gets no hostname of its own; the router reaches it by service binding.
- The district's **public origin is the one hostname** it is served at. Moving to a custom domain
  still moves no data, since Durable Object state is keyed by district ID, not hostname. The old
  hostname then answers with 301s.
- The Access application in front of that hostname is the district's only application. A1's
  "second Access destination" for an alias is replaced by one application per host.

The rest of A1 (who is the Cloudflare for SaaS provider, DNS-only CNAMEs, same-account custom
domains, slug rules) stands.

## Consequences

- One browser sign-in covers the LMS and `/ai`. The phone's district API calls stop redirecting,
  since every call goes to the origin it signed in to (and, from phase 3, to `/api/m/*` with a
  device token).
- The bypass paths are the main new risk. A route under them that forgets its own check is open to
  the internet, which is why the per-route credential test is a release gate.
- The Workshop moves to `/ai`, which changes its RPC URL, asset base and service worker scope.
  The legacy aliases cover one release; remove them in the release after cutover.
- The installer's desired state and the release manifest must bind the router to the district,
  set `run_worker_first: true` and create the bypass paths (a later phase-1 slice). Production
  configs don't bind `DISTRICT` until the Northfield cutover.
- `production-instance.md` and the demo districts runbook change at cutover.
