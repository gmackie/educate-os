# Runbook: community installations for home learning

- Decision: [ADR-0016](../adr/0016-community-installations-and-home-learning.md). Product guide:
  [home-learning.md](../home-learning.md).
- Configs: `packages/educateos-district-worker/wrangler.demo-<slug>.jsonc`, generated from
  `scripts/production/communities.ts` by `pnpm production:configs` and committed. The file name is
  the demo districts' because the same generator builds both; a community has no demo vars.
- Account: the owner's (`c07a7e704db1808e1fff91bed2b1cd49`), which holds the educateos.io zone.

A community is one more install of the district Worker, set up like a
[demo district](demo-districts.md): its own Worker (`educateos-<slug>-district`), Durable Object,
Access application and ForgeGraph app (`educateos-<slug>`). It differs in what it holds: real
families' data. So it has no showcase, marketplace, course library or product analytics, the demo
operator routes stay off, and organizers can't see families' practice.

## The communities

| Slug | Hostname | Who Access admits | Sign-up | Organizer | First deployed |
|---|---|---|---|---|---|
| safranek | `safranek.educateos.io` | `me-gmail` (the owner, who is the family's parent) | open, 730-day retention, US jurisdiction | EducateOS operations (`admin@agents.gmac.io`'s Access subject), which `me-gmail` doesn't admit, so no organizer can sign in | 2026-11-15 |

## Adding a community

1. **Config.** Add the slug to `COMMUNITY_DEPLOYMENTS`, add its Worker name to the pinned names in
   `scripts/production/production-config.test.ts`, run `pnpm production:configs` and
   `pnpm production:watch-paths`, and merge. Create the ForgeGraph target only after this is on
   `main`: every merge deploys every target, and one whose config file is missing fails.
2. **Access, before the first deploy** (the deploy attaches the custom domain, and a hostname no
   application covers would serve without Access):

   ```sh
   forge cf access app create <slug>.educateos.io --name "EducateOS community: <Name> (<slug>.educateos.io)" --policy <reusable allow policy>
   forge cf access app create <slug>.educateos.io/healthz <slug>.educateos.io/.well-known/educateos.json \
     --name "EducateOS community: <Name> (bypass)"
   forge cf access app list | grep '<slug>.educateos.io'   # the first application's audience is CF_ACCESS_AUD
   ```

   The allow policy decides who may sign up. To add families' emails later, create a reusable
   policy that lists them and add it to the application in the Zero Trust dashboard.
3. **ForgeGraph app** `educateos-<slug>`, linked to `gmackie/educate-os`, stage `production`, one
   `cloudflare-workers` target on hetzner-fg, configured as a demo district's
   ([ForgeGraph](demo-districts.md#forgegraph)) with `wrangler.demo-<slug>.jsonc`.
4. **Secrets**, always with `FG_APP=educateos-<slug>`:

   ```sh
   node packages/educateos-district-worker/scripts/community-config.ts <slug> \
     --name "<Name>" --time-zone <IANA zone> --signup open --retention-days 730 [--contact <email or https link>] \
     --organizer-subject <Access user_uuid> --organizer-name "<Organizer>" |
     FG_APP=educateos-<slug> forge secret set DISTRICT_CONFIG --stage production --stdin
   printf %s '<audience>' | FG_APP=educateos-<slug> forge secret set CF_ACCESS_AUD --stage production --stdin
   printf %s 'https://gmacko.cloudflareaccess.com' | FG_APP=educateos-<slug> forge secret set CF_ACCESS_ISS --stage production --stdin
   openssl rand -hex 32 | FG_APP=educateos-<slug> forge secret set DEVICE_TOKEN_SECRET --stage production --stdin
   ```

   The directory is read on the Durable Object's first start only; `homeLearning` on every start.
5. **Deploy** through ForgeGraph, then verify:
   - `curl -sS https://<slug>.educateos.io/healthz` answers 200.
   - `curl -sSI https://<slug>.educateos.io/` redirects to `gmacko.cloudflareaccess.com`.
   - Signed in as an admitted person: the Learning Home offers "Join this learning community";
     joining leads to "Set up home learning".

## Offboarding

Remove the slug from `COMMUNITY_DEPLOYMENTS`, delete the target and app, the Worker (which deletes
its Durable Object and so every family's data: offer families their export first) and both Access
applications.
