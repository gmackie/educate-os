# Spike: `<slug>.educateos.io`, a managed hostname on a district's own Worker

- Status: Decided 2026-10-25. The same-account path is live for the demo district. The
  cross-account path is built and tested against the installer's fake Cloudflare API only; no
  second account has been used.
- Issue: SCHO-207 (umbrella SCHO-198). Decision: [ADR-0013](../adr/0013-educateos-open-core-control-plane.md),
  addendum A1.
- Code: the demo's alias is `district.aliases` in `scripts/production/schoolos-gmac-io.ts` (see the
  [production runbook](../runbooks/production-instance.md#the-district-lms-lite)). Installer support
  for both paths, and the slug rules, follow in `packages/educateos-installer`.

## The question

educateos.io is a zone in our account. A district's Worker runs in the district's own account. How
does `<slug>.educateos.io` reach that Worker, over HTTPS and behind the district's Access, without
any educateos.io Worker on the request path? And how does a district leave?

## Findings

Read on 2026-10-25 from Cloudflare's docs. Each line links its source.

1. **A plain CNAME across accounts does not work.** Cloudflare refuses it with error 1014: "a CNAME
   record between domains in different Cloudflare accounts is prohibited", except within one account
   or "when using Cloudflare for SaaS".
   <https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1014/>
2. **A Workers Custom Domain needs the zone in the Worker's account.** "You cannot create a Custom
   Domain on a hostname with an existing CNAME DNS record or on a zone you do not own." In the same
   account, Cloudflare creates the DNS record and an Advanced certificate itself, and one Worker may
   have many custom domains, on different zones.
   <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>
3. **Delegating the label as its own zone is Enterprise only.** "Subdomain setup is only available
   for Enterprise accounts."
   <https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/setup/>
4. **Cloudflare for SaaS works across accounts, with the district as the provider.** The district
   enables SaaS on a zone it already owns (its own domain) and creates the custom hostname
   `<slug>.educateos.io` there. We publish the routing and validation records in educateos.io.
   <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/>
5. **Our CNAME must be DNS-only.** If educateos.io proxies it, that is Orange-to-Orange: "the
   settings configured in your Cloudflare zone will be applied to the traffic first", so our zone's
   WAF, rules and any matching Worker would sit on the district's path, and WebSockets are listed as
   unsupported. A DNS-only CNAME leaves only the district's zone on the path ("Without O2O enabled,
   the settings configured in the SaaS Provider's zone will be applied").
   <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/how-it-works/>,
   <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/saas-customers/product-compatibility/>
6. **The Worker is attached with a hostname route on the district's zone.** With a DNS-only
   customer record, a route on the custom hostname itself (`<slug>.educateos.io/*`) runs. Cloudflare
   recommends `*/*` for a whole SaaS zone, but that would capture every hostname on the district's
   own domain, so the installer uses the hostname route. The fallback origin can be originless
   (`AAAA 100::`), because the Worker answers every request.
   <https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/hostname-routing/>,
   <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/>
7. **Validation can finish before any traffic moves.** Without O2O, hostname ownership can be
   pre-validated with a TXT record at `_cf-custom-hostname.<host>`, and the certificate with
   `ssl.method: txt` at `_acme-challenge.<host>`. Both are records in educateos.io, which we
   publish. The validation values may be missing from the create response, so the installer reads
   the custom hostname again on its next run.
   <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/domain-support/hostname-validation/pre-validation/>,
   <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/certificate-management/issue-and-validate/validate-certificates/txt/>
8. **Access works on a cross-account custom hostname, but not on a same-account one.** The Access
   application lives in the district's account and names the hostname as a custom input. "If the
   custom hostname zone is in the same account as the SaaS zone, the Access application will not be
   applied."
   <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/security/secure-with-access/>
9. **One Access application can cover several hostnames and keeps one audience.** Its
   `destinations` list supersedes `self_hosted_domains`. The AUD tag "will never change unless you
   delete or recreate" the application, so adding a hostname leaves a Worker's `CF_ACCESS_AUD` valid.
   <https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/>,
   <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/>
10. **Cost.** On Free, Pro and Business zones, Cloudflare for SaaS includes 100 custom hostnames,
    then $0.10 a month each. Enabling it needs a payment method on file. Wildcard hostnames, custom
    certificates and custom metadata are Enterprise only, and none is needed here. One district uses
    one hostname. The DNS records in educateos.io are free.
    <https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/>

What we saw on the account itself: educateos.io is a Free zone, SSL for SaaS is not enabled on it,
it has no Worker routes, and the site Worker `educateos-site` holds only `educateos.io` and
`www.educateos.io`.

## Decision

| Case | Mechanism | Who holds what |
|---|---|---|
| The district's account also holds educateos.io (the demo, one owner account) | A Workers Custom Domain `<slug>.educateos.io` on the district's Worker, beside its own hostname, and the hostname added as a destination of its existing Access application | The district's account holds everything. No SaaS. |
| The district has its own account (the product, BYOA) | A Cloudflare for SaaS custom hostname on the district's own zone (TXT validation), an originless fallback origin there, a Worker route `<slug>.educateos.io/*` to its Worker, and the hostname added to its Access application | The district holds the hostname, certificate, route and Access. educateos.io publishes four DNS records: a DNS-only CNAME to the district's fallback origin, the ownership TXT and the certificate TXT records. |

Rejected: a proxied CNAME (puts our zone on the path), `*/*` routes (capture the district's own
domain), subdomain delegation (Enterprise), SaaS on educateos.io with us as the provider (our zone
would terminate TLS and hold the route, and an Access application in our account would protect the
district, which is the reverse of ADR-0013 decisions 4 and 5).

### The managed hostname is an alias, never the identity

The district's own hostname stays its `PUBLIC_BASE_URL`, which also namespaces data (the Context
Library's `sharingDomain`, for one). The managed hostname is only a second way in. So leaving needs
no data move: remove the alias and the district is already serving on its own domain. That also
means a district with no domain of its own cannot use the installer yet; that is a follow-up, not
part of SCHO-207.

### Slugs

`slug.ts`: 3 to 32 characters, lowercase letters, digits and single hyphens, starting with a letter
and not ending with a hyphen (so never an `xn--` label), and not one of the reserved names
(`www`, `api`, `app`, `admin`, `demo`, `docs`, `mail` and about 140 more). A slug is unique because
the educateos.io half refuses to write a record a different instance owns. Records carry an
ownership comment, `educateos:<instanceId>`.

### Leaving and offboarding

- **Moving to the district's own domain:** drop `managedHostname` from the install config and
  apply. The installer removes the route, custom hostname (or custom domain) and Access destination
  it finds pointing at its router. The educateos.io half then deletes the records that instance owns.
- **Offboarding:** the same, and the slug is free once the records are gone.
- **If educateos.io stops operating:** the district keeps serving on its own hostname, which never
  depended on us. Its managed hostname stops resolving when our zone does.
- **If the educateos.io site Worker is down:** nothing changes, because no educateos.io Worker is
  on the path in either case. In the cross-account case our zone only answers DNS.

## Verified, and not yet verified

Verified live (same account): see the SCHO-207 issue for the hostname, certificate, Access and
health checks.

Not verified, since it needs a second account (the owner decided on one account for the demo, see
SCHO-210):

- the TXT-pre-validated custom hostname reaching `active` without traffic,
- the hostname route firing for a DNS-only custom hostname,
- Access applying on a custom-input destination in the district's account,
- WebSockets (the Workshop's RPC) through the custom hostname.

The installer's fake account models these as the docs describe them. Prove them on a real second
account before the first BYOA district uses a managed hostname.
