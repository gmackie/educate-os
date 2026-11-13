# Cost to run: what a district pays Cloudflare

- Status: Living document. Figures last computed 2026-11-13.
- Issue: SCHO-362 (parent SCHO-358)
- Page: [educateos.io/pricing](https://educateos.io/pricing/) (`sites/educateos-io/public/pricing/index.html`)
- Inputs: `sites/educateos-io/public/assets/cost-to-run.json`. Model: `sites/educateos-io/cost-to-run.mjs`.
  `build.mjs` stamps every `data-cost="key"` element on the page from them, `build.mjs --check`
  fails on a stale page, and `pricing.test.mjs` checks the page, the model and the citations.

This note is the method behind the page: what a district install deploys, what we measured in the
live demo districts, the assumptions we added, the prices we used and the calculation. Every
figure is **measured** (read from Cloudflare analytics), **published** (a Cloudflare list price) or
**assumed** (our choice, stated), and every result is **projected**.

To change a price or an assumption, edit `cost-to-run.json` and run `node sites/educateos-io/build.mjs`.

## 1. What a district install deploys

From `packages/educateos-installer` (`src/desired.ts`), [installer-permissions.md](installer-permissions.md),
[launch-installer.md](launch-installer.md) and each Worker's `cloudflare.config.ts`:

| Resource | What it is | Billed as |
| --- | --- | --- |
| `router` Worker | The district's public origin: serves the frontend's static assets and routes `/api/*` and `/gatekeeper/*` | Workers requests and CPU. Static assets are free. |
| `workshop-backend` Worker | The teachers' AI workspace (Workshop): per-user Durable Objects, KV `BLUEPRINTS` and `AVATARS`, R2 `BLUEPRINT_CONTENT`, a Worker Loader | CPU (no extra request: reached by service binding); Durable Object requests and duration; KV and R2 operations and storage |
| Gatekeeper Workers (preinstalled ones, e.g. `gatekeeper-educateos`, `gatekeeper-google`, `gatekeeper-context` with KV `CONTEXT_COLLECTIONS`, `gatekeeper-scheduler`, `gatekeeper-websearch`) | Connections to outside services | CPU, small Durable Object use |
| `educateos-district-worker` | The district app: one `DistrictObject` (SQLite-backed Durable Object) holds every district store. No D1, no R2 (SCHO-138). Cron Triggers `7 * * * *` (notification sweep) and `0 14 * * SUN` (family digest). `SEND_EMAIL` binding | CPU; Durable Object requests, duration, SQLite rows and storage |
| `educateos-ai-guard` (optional service) | The AI call guard and its spend ledger (Durable Object); cron `17 3 * * *` | Small; the AI spend it guards is the district's cap (section 6) |
| OSS admin (optional, `admin.enabled`) | `educateos-admin` Worker with a D1 database | Small |
| AI Gateway (optional) | One gateway per install | Core gateway is free |
| Access applications and policies | Sign-in for every person | Zero Trust seats (section 5) |

## 2. Measurements

Source: the Cloudflare GraphQL Analytics API (`api.cloudflare.com/client/v4/graphql`), read-only,
for account `c07a7e704db1808e1fff91bed2b1cd49`, over **2026-10-14 to 2026-11-12** (30 days), read
on 2026-11-13. Credential: the Keychain item `educateos-cf-subdomains-token` (the only one of the
account's Keychain tokens with Analytics read; `educateos-cf-access-token` and
`educateos-cf-byoa-gmacko-token` are refused with `authz`, the others failed authentication).
Datasets: `workersInvocationsAdaptive`, `durableObjectsInvocationsAdaptiveGroups`,
`durableObjectsPeriodicGroups`, `durableObjectsSqlStorageGroups`. Workers invocation counts are
adaptively sampled (they come in multiples of 10).

The demo districts run the same district Worker a district installs, with synthetic rosters and
almost no human traffic. So the measurements give the **cost per request and per background job**;
how many requests people make is assumed (section 3).

### Workers, 30 days

| Worker | Requests | CPU total | CPU per request |
| --- | ---: | ---: | ---: |
| `router` (schoolos.gmac.io) | 11,780 | 6.77 s | 0.57 ms |
| `schoolos-district-worker` (Northfield) | 3,020 (370 fetch, 240 cron, 2,410 by service binding) | 4.95 s | 1.64 ms |
| `educateos-harbor-district` | 950 | 1.98 s | 2.08 ms |
| `educateos-cedarvalley-district` | 610 | 0.92 s | 1.51 ms |
| `educateos-riverbend-district` | 590 | 0.93 s | 1.58 ms |
| `educateos-lakeshore-district` | 520 | 0.78 s | 1.50 ms |
| `educateos-prairie-district` | 470 | 0.74 s | 1.57 ms |
| `workshop-backend` | 3,540 | 319.6 s | 90.3 ms |
| `educateos-ai-guard` | 90 | 0.54 s | 6.0 ms |

A request through the router to the district costs about 0.57 + 2.08 = **2.7 ms** of CPU at the
most (model: 3 ms). An AI workspace request costs **90.3 ms** (model: 91 ms).

### District Durable Objects: the hourly notification sweep

Each district's one `DistrictObject`, per day, 2026-11-06 to 2026-11-12, after SCHO-326 seeded the
demo districts on 2026-11-05. On these days nearly every Durable Object request is one of the 24
hourly sweeps, so a day's rows divided by 24 is one sweep. Students are the fixture's rostered
students (`@educateos/fixtures`).

| District | Students | DO requests/day | Rows read/day | Rows written/day | Read per student per sweep | Written per student per sweep | SQLite stored (2026-11-12) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| prairie | 4 | 24 | 138,456 | 1,728 | 1,442 | 18.0 | 2,117,632 B |
| riverbend | 4 | 24 | 137,928 | 1,512 | 1,437 | 15.8 | 1,916,928 B |
| cedarvalley | 6 | 24 | 261,816 | 2,592 | 1,818 | 18.0 | 3,059,712 B |
| harbor | 6 | 24 | 206,256 | 2,160 | 1,432 | 15.0 | 5,107,712 B |
| lakeshore | 10 | 24 | 545,736 | 4,104 | 2,274 | 17.1 | 4,726,784 B |
| northfield (`schoolos-district-worker`) | not read | 24 to 48 | 56.5 to 61.6 million | 196,668 to 213,564 | | | 166,580,220 B |

- Rows **written** per student per sweep are steady at **15 to 18** across all five (model: 18).
  The sweep (`runNotificationJob` in `packages/educateos-district-app/src/communication/service.ts`)
  runs `syncNotifications` for every active student every hour and writes rows even when nothing
  changed. Northfield's 8,500 rows written per sweep at the same rate suggest a roster of about 500;
  we did not read its roster. Before the seed (2026-11-01 to 11-04) the demo districts wrote 0 rows
  a day.
- Rows **read** per student per sweep rise with roster size (1,437 at 4 students, 2,274 at 10), and
  Northfield reads about 2.4 million a sweep. The model uses **5,000**; past the measured range this
  is a projection.
- Stored data is **0.47 to 0.85 MB per rostered student** with the K-12 showcase seeded (model: 1 MB).

### District Durable Object: requests from people

Northfield, 2026-10-27 to 2026-10-31, before the showcase seed: 115 to 349 requests a day over the
sweep-only baseline of 2026-11-01 and 11-02 (about 25 requests, 109,200 rows read and 1,224 rows
written a day). Over those five days the 985 extra requests read 87,600 rows and wrote 931:
**89 read and 0.95 written per request** on average; the busiest day (2026-10-30) was 230 and 3.5.
The model uses the busiest day rounded up: **250 read, 4 written**.

### Durable Object duration

Active time in the window: Northfield's district object 8,268 s; each demo district object 83 to
337 s; the Workshop's Durable Object namespaces up to 234,424 s. The model does not scale these:
it counts the district object as active all month (31 × 86,400 s × 0.125 GB = 334,800 GB-s, an
upper bound, since one object cannot be active longer) and each teacher's Workshop object as active
for their assumed Workshop hour each school day.

## 3. Assumptions

| Input | Value | Kind |
| --- | --- | --- |
| Students per teacher | 15 | assumed |
| Guardians who sign in, per student | 0.5 | assumed |
| School days in a busy month | 20 | assumed |
| Days in the month (for cron and the district object) | 31 | assumed |
| Billable requests per student per school day | 120 | assumed (static assets are free) |
| Billable requests per teacher per school day | 400 | assumed |
| Requests per guardian per month | 40 | assumed |
| AI workspace requests per teacher per school day | 40, over 1 active hour | assumed |
| Workers Logs events per request | 2 (router and district each log one invocation) | assumed |
| CPU per request | 3 ms (91 ms in the AI workspace) | measured |
| Rows per request | 250 read, 4 written | measured |
| Cron runs per month | 744 sweeps + 5 digests = 749 | measured (from the Worker's Cron Triggers) |
| Rows per student per sweep | 5,000 read, 18 written | measured |
| Stored data per student | 1 MB | measured |

Requests through the router reach the district Worker and the Workshop by service binding, which
Cloudflare bills as one request, with CPU from both Workers.

## 4. Prices

Read live on **2026-11-13** (USD, Workers Paid plan):

| Product | Included each month | Over that | Source |
| --- | --- | --- | --- |
| Workers Paid plan | | $5 per account | https://developers.cloudflare.com/workers/platform/pricing/ |
| Worker requests | 10 million | $0.30 per million | https://developers.cloudflare.com/workers/platform/pricing/ |
| Worker CPU time | 30 million ms | $0.02 per million ms | https://developers.cloudflare.com/workers/platform/pricing/ |
| Workers Logs | 20 million events | $0.60 per million (moves to Cloudflare Observability pricing on 2026-12-01) | https://developers.cloudflare.com/workers/platform/pricing/ |
| Durable Object requests | 1 million | $0.15 per million | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Durable Object duration | 400,000 GB-s | $12.50 per million GB-s (128 MB per object) | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| SQLite rows read | 25 billion | $0.001 per million | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| SQLite rows written | 50 million | $1.00 per million | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| SQLite storage | 5 GB-month | $0.20 per GB-month | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Zero Trust (Access) seats | Free plan: 50 users | Pay-as-you-go: $7 per user per month, for every user | https://www.cloudflare.com/plans/sase-zero-trust/ |
| KV | 10 million reads, 1 million writes, 1 GB | $0.50 / $5.00 per million, $0.50 per GB-month | https://developers.cloudflare.com/kv/platform/pricing/ |
| R2 Standard | 10 GB-month, 1 million Class A, 10 million Class B | $0.015 per GB-month, $4.50 / $0.36 per million | https://developers.cloudflare.com/r2/pricing/ |
| D1 | 25 billion rows read, 50 million written, 5 GB | $0.001 / $1.00 per million, $0.75 per GB-month | https://developers.cloudflare.com/d1/platform/pricing/ |
| AI Gateway | Core service free | Logs, Logpush, Unified Billing (5% on credits) extra | https://developers.cloudflare.com/ai-gateway/reference/pricing/ |

KV, R2 and D1 (the Workshop's blueprints and avatars, its blueprint content, the OSS admin's
database) are not modeled: the Workshop and the admin are staff-sized, and at these enrollments
their use stays inside what the plan includes. An Access seat holds from a person's first
sign-in until they are removed (https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/).

## 5. The calculation

For `S` students: teachers `T = ceil(S / 15)`, guardians `G = ceil(0.5 × S)`.

```text
app requests      A = S×120×20 + T×400×20 + G×40
workshop requests W = T×40×20
requests          R = A + W + 749
CPU ms            = (A + 749)×3 + W×91
DO requests       = R
DO GB-s           = 31×86,400×0.125 + T×1×3,600×20×0.125
rows read         = A×250 + S×5,000×749
rows written      = A×4   + S×18×749
storage GB        = S×1 MB / 1,024
log events        = R×2
usage             = $5 + Σ max(0, quantity − included) × price
Access seats      = S + T + G, free if ≤ 50, else × $7
```

(The sweep terms use all 749 cron runs, which counts the 5 digests as sweeps: a slight overcount.)

Worked example, **S = 500**: T = 34, G = 250. A = 1,200,000 + 272,000 + 10,000 = 1,482,000;
W = 27,200; R = 1,509,949, under 10 million, so $0. CPU = 4,448,247 + 2,475,200 = 6,923,447 ms,
under 30 million, $0. DO requests 1,509,949: 509,949 over, × $0.15/M = $0.08. DO GB-s =
334,800 + 306,000 = 640,800: 240,800 over, × $12.50/M = $3.01. Rows read 2.24 billion and written
12.7 million, both included. Storage 0.49 GB, logs 3.0 million: included. **Usage $8.09.**
Seats: 784 × $7 = **$5,488**.

Results (projected, USD per month):

| Students | Teachers | Usage | Largest usage lines | Usage per student | Access seats (all sign in) | Total at list price |
| ---: | ---: | ---: | --- | ---: | ---: | ---: |
| 500 | 34 | $8.09 | base $5, DO duration $3.01 | $0.016 | $5,488 | $5,496 |
| 2,500 | 167 | $37.29 | DO duration $17.97, rows written $13.25 | $0.015 | $27,419 | $27,456 |
| 10,000 | 667 | $339.58 | rows written $202.96, DO duration $74.22 | $0.034 | $109,669 | $110,009 |
| 50,000 | 3,334 | $2,048 | rows written $1,214.79, DO duration $374.26, rows read $199.17, logs $168.41 | $0.041 | $548,338 | $550,386 |

`node -e 'import("./sites/educateos-io/cost-to-run.mjs").then(m => console.log(m.monthlyCost(2500)))'`
prints any size, line by line.

## 6. AI model usage: the district's cap

Model calls are not in the table. They go through the AI call guard (`educateos-ai-guard`), whose
ledger holds every call against the budgets the district sets (district pool, protected safety
reserve, per-person caps) and refuses a call once its budget is spent. The most AI can cost is the
cap the district chooses, so the page shows it as "your AI cap". Planning figures for model spend
and Hall Monitor moderation are in [hall-monitor/source/03-PRICING-AND-SCENARIOS.md](hall-monitor/source/03-PRICING-AND-SCENARIOS.md).

## 7. Findings and limits

- **Access seats dominate.** Every person who signs in through Access takes a Zero Trust seat.
  Past 50 people, list price is $7 per person per month for everyone, which outweighs all usage
  by two orders of magnitude. A teachers-first pilot of up to 50 people stays on Zero Trust Free.
  A sign-in that does not take a seat per person is SCHO-369.
- **The notification sweep writes every hour.** At 10,000 students and above, rows written are the
  largest usage line, and about half of them are the sweep's. Making it write only what changed is
  SCHO-370.
- **One Durable Object per district.** Cloudflare limits an SQLite-backed Durable Object to 10 GB
  and about 1,000 requests a second (https://developers.cloudflare.com/durable-objects/platform/limits/).
  At 1 MB per student, 10,000 students is about 10 GB, and 50,000 students at 120 requests a day
  each average about 350 requests a second over a six-hour school day, with peaks well above. The
  10,000 and 50,000 rows are the cost of the current design if it held, not evidence that it does.
  The pilot gate's load test runs 24 students ([pilot-gate.md](pilot-gate.md)).
- **Usage per person is assumed.** No real students use EducateOS yet. Re-measure with a pilot
  district's own analytics and update `cost-to-run.json`.
- **Prices change.** Workers Logs moves to Cloudflare Observability pricing on 2026-12-01. Recheck
  every source above before relying on the figures and update `checked`.
