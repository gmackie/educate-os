# The founding pilot: program summary

- Status: Published at <https://educateos.io/pilot/>. Keep this file and the page in step.
- Issue: SCHO-366.

This summarizes the program. It is not a contract: the signed pilot agreement and the data
processing agreement (DPA) govern.

## Who it's for

- **Public school districts in Texas and Michigan.** Three to five districts in this first round.
- **One school in each district**, with a school lead and a few champion teachers (we suggest three
  to six) who will use it each week.
- **An IT team willing to install it in the district's own Cloudflare account**, with our help on a
  call.
- **Teacher-facing AI first.** Teachers use agents and gadgets to plan and build classroom
  materials. Student-facing AI stays off in the pilot.

Where EducateOS is today: it runs on synthetic demo districts, no real students use it, and no
district has yet run the installer in its own account. The founding pilot districts will be the
first. Status claims follow [maturity.md](../maturity.md). We make no compliance or certification
claims.

## What the district gets

- **The software, free.** Apache-2.0, no per-seat fee to us.
- **A guided install and pilot support at no charge.** We run `npx launch-educate-os` with the IT
  team on a call, in the district's account, under a token the district creates and deletes.
- **Training for the champion teachers** in week 1, and a 20-minute check-in each week after.
- **Written success criteria** agreed at kickoff, and a written end-of-pilot review against them.
- **A seat on the founding advisory councils** as we form them, for an educator, an IT lead or both
  (see [/advisory/](https://educateos.io/advisory/)).
- **A direct say in what gets built next.** Issues go into the project tracker, and we report back
  on each one.

## What the district gives

- **Its own Cloudflare bill, paid directly to Cloudflare.** Workers Paid from $5 a month plus small
  usage; up to 50 people signing in fits Zero Trust Free. AI model usage is billed by the model
  provider, up to the cap the district sets. Nothing passes through us. See
  [/pricing/](https://educateos.io/pricing/#pilot) and [cost-to-run.md](../cost-to-run.md).
- **Staff time.** A few hours of IT time before kickoff, about an hour of training per champion
  teacher, regular use in their own planning, and the weekly 20-minute check-in.
- **Honest feedback.** The baseline and exit surveys ([surveys.md](surveys.md)) and the issues they
  run into.
- **A reference at the end, if the district is willing.** Never a condition of the pilot. We never
  name a district publicly without its written approval.

After the pilot the software stays free. The optional educateos.io services (the guided install
after the pilot, managed updates) will be priced later; pilot districts hear the prices before
anything is charged.

## Timeline (about ten weeks)

| When | What |
| --- | --- |
| Before kickoff | A 20-minute IT walkthrough; the readiness checklist; the pilot agreement signed and the DPA's status agreed; the guided install on a call, then verification. |
| Week 1 | Kickoff with every role; success criteria written and agreed; champion teacher training; baseline survey. |
| Weeks 2 to 9 | Teachers use EducateOS in their own planning; a 20-minute check-in each week; a shared issue log; a mid-point review in week 5. |
| Week 10 | Exit survey; review against the success criteria; the district decides to keep, export or uninstall. |

With the domain and identity provider already on Cloudflare, the install itself takes under an
hour ([district-install.md](../runbooks/district-install.md)). Moving nameservers or waiting on
another team's identity provider sets the schedule. School calendars move the dates; we agree them
at kickoff.

## Roles

| Role | What they do |
| --- | --- |
| District sponsor | Owns the pilot: signs the pilot agreement, agrees the success criteria, makes the call at the end. |
| IT lead | Owns the Cloudflare account, runs the install with us, controls who can sign in, attends kickoff and the final review. |
| School lead | Picks the champion teachers, protects their time, joins check-ins when needed. |
| Champion teachers | Use EducateOS in their planning each week, attend check-ins, raise issues, answer the two surveys. |
| EducateOS pilot lead | Main contact: runs kickoff, check-ins and reviews, keeps the issue log, answers hello@educateos.io. |
| EducateOS technical contact | Runs the guided install with the IT lead; fixes or tracks every technical issue. |

The people in each EducateOS role are named in the pilot agreement.

## Readiness checklist

### For IT

From [district-install.md](../runbooks/district-install.md#prerequisites-checklist) and
[installer-permissions.md](../installer-permissions.md); the installer's preflight checks most of
these and stops, having changed nothing, if one is missing.

- [ ] A Cloudflare account the district owns, with a payment method, and an administrator who can
      create an API token (13 permissions, scoped to the account and zone, short expiry).
- [ ] Workers Paid on that account, with R2 turned on.
- [ ] A domain as an active zone in the account, with no DNS records yet at the chosen hostname.
- [ ] Cloudflare Zero Trust with a team, and the district's identity provider (Google Workspace,
      Microsoft Entra ID, Clever, or another SAML or OIDC provider) added as a login method.
- [ ] Who may sign in (staff domain or the champion teachers' addresses) and one to twenty
      administrators. Zero Trust Free admits 50 people.
- [ ] A machine with Node.js 22.12 or later.
- [ ] AI model access: the provider, who holds that account, and the monthly AI cap. Before any
      teacher signs in, we confirm in writing which AI controls (screening and spending caps) are in
      place in the district's install.
- [ ] The roster source, if any. A teachers-first pilot does not need one, and no real roster is
      connected before a DPA is signed.
- [ ] The LMS, if any. We say honestly how ready EducateOS is for it
      ([integrations](https://educateos.io/integrations/)).

### For the school

- [ ] A school lead who can give the champion teachers time.
- [ ] A few champion teachers who plan lessons weekly and want to try AI in that work.
- [ ] An hour in week 1 for training and a fixed 20-minute weekly slot.
- [ ] One or two problems worth solving, to anchor the success criteria.
- [ ] The data rule shared with every champion teacher before they sign in.
- [ ] The baseline survey answered in week 1, before teachers start.

## The data rule

Until the district signs a DPA, the pilot uses **synthetic data or staff-only data**: teachers' own
accounts and their own teaching materials. Nobody enters students' names, records, grades or work,
and no real roster is connected.

- EducateOS runs in the district's own Cloudflare account; Gmacko Ventures LLC does not receive
  student records.
- The [DPA template](https://educateos.io/student-privacy/dpa/) is a draft pending counsel review
  (SCHO-229). A state standard student data privacy agreement is welcome.
- Student-facing AI stays off throughout the pilot.
- The IT lead can stop all access at any time by changing the EducateOS Access policy in the
  district's account, without us.

## Success criteria

Three to five measurable criteria, each with a target and a measurement method, agreed at kickoff
and reviewed at weeks 5 and 10. The worksheet and examples are in
[success-criteria.md](success-criteria.md).

## Support

- Email hello@educateos.io with "Pilot" and the district's name in the subject. **Support target
  during the pilot: a reply within one business day.**
- The weekly 20-minute check-in covers what worked, what didn't and the issue log.
- Safety or data concerns first: "Safety" in the subject. The IT lead can stop access straight away
  and then write to us.
- The support target is a pilot commitment, not a service-level agreement; the pilot agreement says
  what we commit to.

## At the end

- **Keep it.** It keeps running in the district's account; the software stays free. Moving on to
  students needs a signed DPA first, and seat-free student sign-in is still planned (SCHO-369).
- **Export.** A district administrator downloads the district as one ZIP (`admin.exportDistrict`),
  and each student can download their own `.educateos` archive. Workshop gadgets and agents are not
  in either export yet. Harness-tested, not yet run in a live district
  ([maturity.md](../maturity.md)).
- **Uninstall.** Delete everything named `educateos-<name>-*`, following
  [district-offboarding.md](../runbooks/district-offboarding.md). There is no uninstall command yet
  (SCHO-368). We help on a call if asked.

Whatever the decision, we write up the end-of-pilot review and send it to the district sponsor.

## How to apply

1. Email hello@educateos.io to book a 20-minute IT walkthrough, with the district, the school in
   mind, the identity provider, the roster source and the LMS.
2. We reply within one business day and say honestly how ready EducateOS is for those systems.
3. If it fits, we send the pilot agreement and the DPA template and agree a kickoff date.

Professional details only: no student information in email.
