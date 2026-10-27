# Runbook: billing end to end in the Stripe sandbox

- Status: Steps 1 and 2 were done on 2026-10-27. Step 3 runs once the PR deploys; not yet run
  against the deployed site.
- Issue: SCHO-208. Design: [control-plane.md, Billing](../control-plane.md#billing).
- Who runs it: someone who can set the `educateos-site` Worker's secrets and sign in to the
  operator console. About 20 minutes.
- Accounts: the EducateOS Stripe sandbox, "EducateOS sandbox" `acct_1UV2tGL1y99jAIet`, under the
  Gmacko organization. The live account `acct_1UV0G0PswAykERjZ` is not used until pricing is
  decided and the account is activated.

Every command reads keys from the macOS Keychain and prints none. The sandbox's keys are in
`stripe-educateos-test-secret` and `stripe-educateos-test-publishable`.

## 1. Webhook endpoint and portal configuration

Done on 2026-10-27: webhook endpoint `we_1UV3R5L1y99jAIetGYQtYV1W` (its signing secret is the
Worker's `STRIPE_WEBHOOK_SECRET`), and portal configuration
`bpc_1UV3R5L1y99jAIetN8fGRXZK`, set as `STRIPE_PORTAL_CONFIGURATION` in `wrangler.jsonc`. To make
them again:

Create the endpoint once. Its signing secret is shown only in the create response, so it goes
straight into the Keychain:

```sh
key=$(security find-generic-password -s stripe-educateos-test-secret -w)
curl -sS https://api.stripe.com/v1/webhook_endpoints -u "$key:" \
  -d url=https://educateos.io/stripe/webhook \
  -d 'enabled_events[]=payment_intent.succeeded' -d 'enabled_events[]=payment_intent.payment_failed' \
  -d 'enabled_events[]=refund.created' -d 'enabled_events[]=refund.updated' \
  -d 'description=educateos.io billing (SCHO-208)' \
  | python3 -c 'import json,subprocess,sys; d=json.load(sys.stdin); subprocess.run(["security","add-generic-password","-U","-s","stripe-educateos-test-webhook-secret","-a","educateos-sandbox","-w",d["secret"]],check=True); print(d["id"])'
```

Create a Customer Portal configuration that manages payment methods only, and note its `bpc_…` ID:

```sh
curl -sS https://api.stripe.com/v1/billing_portal/configurations -u "$key:" \
  -d 'features[payment_method_update][enabled]=true' \
  -d 'features[invoice_history][enabled]=false' \
  -d 'features[customer_update][enabled]=false' \
  -d 'business_profile[headline]=EducateOS payment methods' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])'
```

## 2. The site Worker's secrets

Done on 2026-10-27: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `COMMERCE_SIGNING_KEY` are set
on `educateos-site`. To set them again:

```sh
cd sites/educateos-io
security find-generic-password -s stripe-educateos-test-secret -w | pnpm exec wrangler secret put STRIPE_SECRET_KEY
security find-generic-password -s stripe-educateos-test-webhook-secret -w | pnpm exec wrangler secret put STRIPE_WEBHOOK_SECRET
```

`COMMERCE_SIGNING_KEY` is a new Ed25519 private JWK. Generate it into the Keychain, then set it:

```sh
node -e 'const {generateKeyPairSync, execFileSync} = {...require("node:crypto"), ...require("node:child_process")};
  const k = generateKeyPairSync("ed25519").privateKey.export({format: "jwk"});
  execFileSync("security", ["add-generic-password", "-U", "-s", "educateos-commerce-signing-key", "-a", "educateos.io",
    "-w", JSON.stringify({kty: k.kty, crv: k.crv, x: k.x, d: k.d})]);'
security find-generic-password -s educateos-commerce-signing-key -w | pnpm exec wrangler secret put COMMERCE_SIGNING_KEY
```

The portal configuration is the var `STRIPE_PORTAL_CONFIGURATION` in `wrangler.jsonc`.

## 3. Run it

In a browser signed in to educateos.io/app:

1. Open `/app/billing`. Three plans are listed, each marked as a placeholder price.
2. Choose **Managed hostname**, name an organization, and continue. Stripe's Checkout asks for a
   card and says nothing will be charged now. Use `4242 4242 4242 4242`, any future date, any CVC.
3. Back on `/app/billing`: "Your card is saved", the subscription **Active**, and one invoice for
   $1.00, already **Paid**: the 4242 card's PaymentIntent succeeds at once, and Stripe's reply says
   so.
4. Within a few seconds Stripe delivers `payment_intent.succeeded`. In the Stripe Dashboard
   (sandbox) the webhook endpoint shows it answered 200 `{"outcome":"duplicate"}` (the reply had
   recorded it), and Payments shows the $1.00 charge, with metadata `educateos_invoice`, to the
   customer whose metadata `commercial_account_id` is the operator's `acct_…`. A 503
   `{"outcome":"unmatched"}` there means a charge commerce hasn't recorded yet; Stripe redelivers it.
5. **Manage payment methods** opens the Customer Portal; its return link comes back to billing.
6. **Cancel subscription**: "Your subscription is cancelled", and the plans are offered again.

For a decline, subscribe with `4000 0000 0000 0341` (saves, then declines when charged): the
notice says the card was declined, the invoice shows **Declined** and the subscription **Payment
due**. Update the card in the portal to 4242, then **Pay now**: the declined PaymentIntent is
cancelled and a new one charges the invoice.

## 4. Evidence

Record on SCHO-208: the deploy ID and commit, the sandbox customer, PaymentIntent and event IDs
from steps 4 and 6, and the webhook endpoint's delivery log showing 200s.
