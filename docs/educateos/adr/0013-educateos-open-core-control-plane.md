# ADR-0013: EducateOS, open core with an optional paid control plane at educateos.io

- Status: Accepted
- Date: 2026-10-25
- Issues: SCHO-199 (umbrella SCHO-198). Amends [ADR-0011](0011-open-source-charter-and-module-ownership.md)
  decisions 1, 3 and 6.

## Context

ADR-0011 made SchoolOS an open-source project with an optional website at `schoolos.dev` that
hosts documentation, a guided bootstrap and releases, and nothing else. It explicitly ruled out a
commercial offering.

The owner has since decided three things:

1. SchoolOS is renamed **EducateOS** (SCHO-200 does the mechanical rename).
2. **educateos.io** replaces `schoolos.dev` as the project's site. Besides docs and releases, it
   offers a guided install, a dashboard for installations, billing, and a marketplace.
3. Installations are reachable at **`<districtslug>.educateos.io`** by default. Each installation
   still runs in the organization's own Cloudflare account (bring your own account).

Each of these touches an ADR-0011 rule. Billing contradicts "it is not a commercial SaaS". A
default hostname on our zone puts educateos.io on the request path at the DNS and TLS layer. A
marketplace with paid items needs entitlement-like state somewhere. This ADR says what changes
and what does not.

## Decision

1. **The core stays open source and complete.** Everything ADR-0011 lists as the kernel, core
   runtime and optional runtime stays Apache-2.0. A default install has every educational
   capability, with no paid tier inside the runtime. An organization can install, run, update
   and offboard EducateOS from the CLI or its own CI without ever contacting educateos.io. This
   remains a release gate.
2. **educateos.io may charge for services it performs itself.** These are:
   - the managed default hostname,
   - the guided install and the update channel,
   - support,
   - paid marketplace items.

   Billing state lives in educateos.io's own account (`@schoolos/commerce`, to be
   `@educateos/commerce`), never in an installation.
3. **Installations never check entitlements.** No runtime code asks educateos.io whether a
   feature, a seat or a marketplace item is paid for. A paid marketplace item is delivered as a
   signed artifact that the installation verifies offline against keys it pins, the same way it
   verifies releases. After delivery, the installation keeps working with it whether or not a
   subscription lapses. A lapsed subscription stops future deliveries and managed services only.
4. **The default hostname is routing, not data access.** `<slug>.educateos.io` is a Cloudflare for
   SaaS custom hostname on the educateos.io zone, and its origin is the Worker in the
   organization's account. Cloudflare terminates TLS for that hostname under our zone. educateos.io
   never stores, logs or inspects request content, and holds no credentials for the installation.
   Every installation can also be served on the organization's own domain, and the installer
   supports moving to one without data loss. An organization that wants no dependency on
   educateos.io at any layer uses its own domain.
5. **The guided install holds the organization's Cloudflare credentials only for the
   install.** It uses the installer OAuth flow (SCHO-67). The token is used to deploy and is then
   discarded. educateos.io keeps no standing access to the account.
6. **The installation registry is still opt-in and content-free** (ADR-0011 decision 7). The
   educateos.io dashboard shows only the installations that registered, and only the allow-listed
   R01 fields. A managed hostname needs the slug and the target, not registration.
7. **`@schoolos/commerce` and `@schoolos/fleet` become control-plane code.** This settles the
   ADR-0011 open decision: they stay in this repository, educateos.io deploys them, and the rule
   that no installation runtime depends on them still holds.

ADR-0011 decisions 2, 4, 5 and 7 and its module ownership table stand, with "schoolos.dev" read as
"educateos.io".

## Consequences

- The README rules change: educateos.io is never in the data path, never gates features and never
  issues runtime tokens. Billing is allowed for the services above.
- The pilot gate's root-outage criterion becomes "educateos.io unreachable". A district on the
  default hostname depends on Cloudflare for SaaS staying configured on our zone, not on any
  educateos.io Worker. The subdomain work (SCHO-207) must show the district keeps serving while
  the educateos.io site Worker is down.
- Offboarding must release the slug and remove the custom hostname. If educateos.io ever stops
  operating, installations keep working on their own domains. The documentation for a custom-domain
  move covers this case.
- `@schoolos/commerce` needs a Stripe Checkout and Portal path for managed services (SCHO-208). The
  marketplace (SCHO-209) needs signed listings that installations verify offline.
- Claims about integrations still follow [maturity.md](../maturity.md).

## Addendum A1 (2026-10-25, SCHO-207): how the default hostname is attached

The spike is [managed-hostnames-cloudflare.md](../spikes/managed-hostnames-cloudflare.md). It
refines decision 4 as follows:

- **The district is the Cloudflare for SaaS provider, not educateos.io.** The custom hostname
  `<slug>.educateos.io` lives on a zone in the district's own account, with its certificate, a
  Worker route to its Worker, and its own Access application. Cloudflare terminates TLS under the
  district's zone, not ours. educateos.io publishes only DNS records: a **DNS-only** CNAME to the
  district's fallback origin, and the TXT records for hostname ownership and certificate
  validation. A proxied CNAME is not allowed, because it would run our zone's settings first
  (Orange-to-Orange).
- **When the district's account also holds educateos.io** (the demo, which runs every demo district
  in the owner's account), the hostname is a Workers Custom Domain on the district's Worker, and SaaS
  is not used. Cloudflare does not apply Access to a SaaS custom hostname whose zone is in the same
  account.
- **The default hostname is an alias.** The district's own hostname stays its public base URL and
  data namespace. So leaving is removing the alias, with no data to move.
- **Slugs** are DNS labels of 3 to 32 characters from a reserved-word filter. They are unique because
  the educateos.io side refuses records that another instance owns.
