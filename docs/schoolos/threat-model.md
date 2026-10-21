# SchoolOS threat model (v1)

- Status: Living document. Revisit at each release gate (G0-G4).
- Issue: SCHO-1

## Assets

| Asset | Why it matters |
| --- | --- |
| Student identity and roster | These are minors' records, covered by FERPA and COPPA and by state law. |
| Personal workspaces and conversations | Students expect them to be private, including from their teachers. |
| Course work, submissions and feedback | They are evidence for grades, so they must not change after submission. |
| Official grades | They have real consequences. They need teacher review and an audit trail. |
| AI budgets and usage records | They are district money, and per-principal usage is personal data. |
| District configuration and policy | Changing them changes who can see what. |
| Integration credentials | IdP, roster, LMS and provider keys. |
| Release and entitlement signatures | They decide what code a district runs. |

## Trust boundaries

1. **Root ↔ district.** `schoolos.dev` is outside the data plane (ADR-0001). It can propose a
   release. The district verifies the signature and applies it.
2. **District A ↔ district B.** Each district is a separate account or instance. Contracts carry
   `districtId` everywhere, and authorization denies across districts before any policy rule runs.
3. **Issuer ↔ principal.** Tokens prove an `(issuer, subject)`. Only the district's directory turns
   that into a principal and its roles (ADR-0003).
4. **Principal ↔ resource.** The policy engine decides every action, on every channel (ADR-0005).
5. **Agent/model ↔ tools.** Model output is untrusted input. Tool calls authorize as the principal
   the agent acts for, and model-written arguments never supply identity or role.
6. **External content ↔ system.** Imported pages, packages and cartridges are data. They cannot
   change instructions, policy or tool permissions.
7. **Sandboxed code ↔ host.** Gadget and assessment code runs isolated, with restricted outbound
   network access and resource limits.

## Threats and mitigations

| # | Threat | Mitigation | Verified by |
| --- | --- | --- | --- |
| T1 | District B reads district A data | `districtId` on every scope. `precheckAuthorization` denies across districts. Instances are separate. | §14 row 1. Contracts tests. H01 |
| T2 | Student A reads B's artifact or private chat | Owner and classification on every `ResourceRef`. Personal spaces are a separate kind. Unknown IDs return `not-found`. | §14 row 2. A02 |
| T3 | Teacher reads a student's personal conversation | Personal conversations are a distinct resource kind. The `teacherObservation` floor applies. | §14 row 3. A02 |
| T4 | Account takeover by a reused or shared email | Identity is `(district, issuer, subject)`. Email is never a key. Links are unique per district. | ADR-0003. Fixtures (shared family email, cross-district teacher). F04 |
| T5 | Forged role or tool annotation in a request | Closed, strict schemas. Extra fields fail to parse and are denied. | §14 row 4. Contracts tests |
| T6 | Roster sync deletes or remaps students | Snapshots must pass `checkDirectoryIntegrity`. Enrollments go inactive and are never deleted. Identity mismatches are quarantined. | §14 row 5. A03 |
| T7 | Prompt injection in imported content | Content is quarantined and treated as data. Policy and tools are unreachable from content. | §14 row 7. C03 |
| T8 | Answer key leaks through Git history | Baselines are sanitized before forking. Publication is blocked if old commits hold teacher-only files. | §14 row 8. W03 |
| T9 | AI overspend or double billing on retry | Reserve, then settle, with idempotency keys. Caps are enforced locally. | §14 row 9. G01 |
| T10 | An AI score becomes an official grade | Grade writeback requires `require-approval` and a teacher decision. | §14 row 10. E03; LMS passback gate in I02 |
| T11 | Expired course access persists | Term state is part of the authorization context. Course grants are revoked at close. | §14 row 12. W01 |
| T12 | Root compromise pushes malicious code | Releases are signed and pinned. The district can decline or roll back. Root holds no data. | §14 rows 13-15. R03 |
| T13 | Policy loosened through delegation | `resolvePolicy` refuses any narrower setting looser than the floor. | Contracts tests. F03 |
| T14 | Test data contains real people | Tests use only `@schoolos/fixtures` with `.example` domains, and a test enforces it. | Fixtures tests |

## Out of scope for v1

- Physical device security and endpoint management on school devices.
- Insider threats inside the district's Cloudflare account owner role.
- Legal review of FERPA, COPPA and state privacy obligations. That is an external gate before G3.
