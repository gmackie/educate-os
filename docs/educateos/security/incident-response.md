# Incident response and breach notification

- Status: Published outline, SCHO-372 (parent SCHO-358), 2026-11-14. Not yet exercised in a real
  incident or a tabletop exercise.
- Public copy: `sites/educateos-io/public/security/incident-response/index.html`
  (educateos.io/security/incident-response/). Change both in the same PR.
- Related: [vulnerability-disclosure.md](vulnerability-disclosure.md),
  [../threat-model.md](../threat-model.md) T12 (release key compromise),
  [../release-signing.md](../release-signing.md), DPA template §10
  (`sites/educateos-io/public/student-privacy/dpa/index.html`)

How Gmacko Ventures LLC, which develops EducateOS and runs educateos.io, responds to a security
incident, and when it notifies a district. It is an outline, not a certification or an audited
process, and is revised after each incident and each tabletop exercise.

## Who does what

Each district runs EducateOS in its own Cloudflare account, so the district operates its
installation and leads the response inside it: its account, logs, users and notification decisions.
Gmacko Ventures LLC leads the response for what it controls: the open-source code, the signed
releases and their keys, educateos.io and its services, the project's demo districts, and any
district data it holds or accessed under Support Access (only at the district's written request,
DPA §6). In every incident that touches a district, it works with the district's team.

## Reporting

Anyone reports a suspected incident or vulnerability to security@educateos.io. A district that
suspects an incident in its installation emails there as well as following its own plan.

## Process

1. **Receive and log.** Every report and alert gets a private incident record, with times.
2. **Triage.** Establish what is affected, whether it is exploited, and severity, and decide whether
   it is a confirmed incident: the evidence shows the security of a system or of data was actually
   compromised, not merely that a flaw exists.
3. **Contain.** Stop the harm in what we control: take a service offline, revoke credentials, or
   rotate release signing keys under the key-set procedure in
   [release-signing.md](../release-signing.md). Where containment needs an action in a district's
   account, tell the district exactly what to do.
4. **Fix.** Fix the cause and publish a signed release with an advisory that says how urgent it is
   (districts apply releases when they choose; there are no automatic updates).
5. **Notify.** Notify affected districts as below, and keep them updated until the incident closes.
6. **Review.** Write down what happened, why and what changes; share what concerns a district with
   that district.

## Our breach notification commitment to districts

If Gmacko Ventures LLC confirms an incident affecting an installation's data, it notifies the
district's named contact without undue delay, and no later than **72 hours after confirming it**.
Examples: a flaw in EducateOS exploited to reach the data, a misused release signing key, or data
Gmacko Ventures LLC holds or accessed under Support Access. The named contact is the person the
district names for security matters, in its agreement or by email to security@educateos.io.

The notice gives what is known at that point: what happened and when it happened and was
discovered; which systems, releases and kinds of data are or may be affected; what has been done to
contain it and what the district should do now; and whom to contact for updates. Unknowns don't
delay the notice; follow-ups add them. Because the district runs its installation, Gmacko Ventures
LLC may not see which records or people are affected; the district determines that from its own
account.

The DPA template (§10, draft pending counsel review) has the same 72 hours for student data Gmacko
Ventures LLC holds or has accessed.

## Supporting the district's own notification duties

A district may have its own duties to notify students, families, staff or state agencies under
federal law and the law of its state, including Texas and Michigan. Those decisions and notices are
the district's. Gmacko Ventures LLC supports them by notifying promptly so the district's deadlines
can be met; providing the facts it has that the district needs for its notices and reports,
including timelines and what was affected; answering the district's and its counsel's questions
about how EducateOS stores and handles data; and coordinating any public statement of its own with
the district first. It gives no legal advice, and sends no notices to a district's students,
families or staff unless the district asks in writing.

## Not covered

- Incidents in a district's account that EducateOS did not cause, such as a compromised district
  administrator account. Gmacko Ventures LLC helps on request.
- Incidents at Cloudflare or another provider, which notify their own customers under their own
  agreements. If Gmacko Ventures LLC learns of one affecting installations, it tells districts what
  it knows.
