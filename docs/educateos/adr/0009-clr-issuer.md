# ADR-0009: Comprehensive Learner Record issuer

- Status: **Proposed.** It needs the decision of a district governance owner. Engineering can't
  accept it alone.
- Date: 2026-10-21
- Issue: SCHO-91 (follow-up of SCHO-32). Code seam: `ClrIssuer` in
  `packages/educateos-portability/src/clr.ts`.

## Context

`@educateos/portability` exports learner archives and defines a `ClrIssuer` seam for 1EdTech
Comprehensive Learner Record 2.0 credentials. Nothing implements it. The default,
`UNCONFIGURED_CLR_ISSUER`, refuses with `unavailable`. The seam's comment names three decisions that
must come first:

1. who holds the signing keys, and how they rotate;
2. which records the district asserts as achievements;
3. which learner identifier the credential carries.

This ADR sets out the options for each, against the specifications. All of them were read on
2026-10-21:

- CLR Standard 2.0 (document v1.1, 2025-10-14): <https://www.imsglobal.org/spec/clr/v2p0/main/>
- CLR 2.0 Certification Guide (2025-12-15): <https://www.imsglobal.org/spec/clr/v2p0/cert/>
- Open Badges 3.0 (document v1.4.5, 2026-06-29): <https://www.imsglobal.org/spec/ob/v3p0/main/>
- The Open Badges 3.0 / CLR 2.0 Implementation Guide (v2.1): <https://www.imsglobal.org/spec/ob/v3p0/impl/>
- Open Badges 3.0 Certification Guide: <https://www.imsglobal.org/spec/ob/v3p0/cert/>
- W3C Verifiable Credentials Data Model 2.0, Data Integrity, the EdDSA Cryptosuites, Controlled
  Identifiers 1.0, and Bitstring Status List 1.0, linked where they are used.

### What the specifications fix

- **Nesting.** A `ClrCredential` wraps one or more `AchievementCredential`s. `ClrSubject.verifiableCredential`
  is required, [1..*]
  (<https://www.imsglobal.org/spec/clr/v2p0/main/#clrsubject>). So the district signs each
  achievement credential, then signs the CLR around them.
- **Proofs.** "At least one proof mechanism … MUST be expressed"
  (<https://www.imsglobal.org/spec/clr/v2p0/main/#proof-formats-0>). The two formats are:
  - **VC-JWT.** "The signing algorithm MUST be "RS256" as a minimum", and "Additional JOSE Headers
    are NOT allowed"
    (<https://www.imsglobal.org/spec/clr/v2p0/main/#create-the-jose-header>). The payload's `sub`,
    which is `credentialSubject.id`, is marked **Required**
    (<https://www.imsglobal.org/spec/clr/v2p0/main/#jwt-payload-format-0>).
  - **Embedded Data Integrity proof.** Issuers "must use one of" `eddsa-rdfc-2022` or
    `ecdsa-sd-2023`, and verifiers "must support" both
    (<https://www.imsglobal.org/spec/ob/v3p0/cert/#supported-proof-mechanisms-1>). The proof purpose
    "MUST be 'assertionMethod'".
- **Issuer and key.** The issuer profile's `id` is a URI. Key dereferencing "allows the use of an
  HTTP URL … or a DID URL …, but only requires HTTP URL support"
  (<https://www.imsglobal.org/spec/clr/v2p0/main/#dereferencing-the-public-key>). For a Data
  Integrity proof, the verification method's `controller` must be the issuer's `id`. For a JWT, the
  key must appear in the JWK Set the issuer publishes
  (<https://www.imsglobal.org/spec/ob/v3p0/impl/#key-provenance-0>).
- **The key set must stay published.** It "should be publicly available at any time a credential is
  verified, which can happen long after the issuing of the credential"
  (<https://www.imsglobal.org/spec/ob/v3p0/impl/#jwk-set-endpoint-0>). Under W3C Controlled
  Identifiers 1.0, a verification method missing from the latest document "is considered invalid
  or revoked" (<https://www.w3.org/TR/cid-1.0/#verification-method-rotation>). Rotation must
  therefore keep old public keys published.
- **Identifying the learner.** A subject needs an `id` or at least one `identifier`
  (<https://www.imsglobal.org/spec/ob/v3p0/main/#achievementsubject>). An `IdentityObject` may be
  hashed: `sha256$<hex>` of the identifier plus a salt
  (<https://www.imsglobal.org/spec/ob/v3p0/main/#identityobject>). The spec recommends hashing
  "where there is an expectation of privacy". The identifier types include `sisSourcedId` and
  `oneRosterSourcedId`, but not `studentId`
  (<https://www.imsglobal.org/spec/ob/v3p0/main/#identifiertypeenum>).
- **Revocation.** A credential is revoked by a set bit in a `BitstringStatusListEntry`
  (<https://www.imsglobal.org/spec/clr/v2p0/main/#clrcredential-verification>,
  <https://www.w3.org/TR/vc-bitstring-status-list/>), whose lists are at least 131,072 entries long
  for group privacy.
- **Refresh.** The refresh service has no authentication: "any client could request the latest
  version of the credential from this endpoint if they knew the correct URL"
  (<https://www.imsglobal.org/spec/ob/v3p0/impl/>).
- **Minors.** No 1EdTech document mentions FERPA or COPPA. The only K-12 guidance is a
  non-normative use case. In it, "Until they are 18, Sammy's parents are able to hold all requested
  achievement assertions" (CLR §2.12). FERPA obligations come from the US Department of Education,
  not from 1EdTech.

### What EducateOS already fixes

- ADR-0001: the district is the issuer, and the root is never in the data path. So the root never
  holds a district's issuing key or signs for it.
- The `ClrIssuer` seam: the identifier must not be the district principal ID.
- ADR-0003: email is display metadata, not an identifier. OB 3.0 agrees that emails "aren't intended
  to be identifiers" (§2.3.3).
- `@educateos/fleet` already holds the district agent's Ed25519 key as a backend Worker secret, which
  cannot be read back, and signs with Web Crypto.

## Options

### 1. Key custody and rotation

| Option | Custody | Rotation | Trade-offs |
| --- | --- | --- | --- |
| **K1. A Worker secret in the district account** | A dedicated Ed25519 issuing key, separate from the fleet agent key, set by the installer as a backend secret. It never leaves the account. | Add the new key and switch signing to it. Old public keys stay published. A compromised key gets `revoked` set, and the credentials it signed are reissued. | Same mechanism as the fleet key, so nothing new to run. Anyone who can redeploy the Worker can use the key, so the district's Cloudflare administrators are within the trust boundary. |
| **K2. The district's external KMS or HSM** | The key stays in a KMS the district already runs. The issuer Worker sends it a digest to sign. | The KMS's own versioning. Old public keys stay published. | Strongest custody, and the private key is never extractable. But it needs an outbound dependency and credentials for the KMS, and Ed25519 support varies by KMS. |
| **K3. The root signs for the district** | `educateos.io` | n/a | **Rejected.** It violates ADR-0001, and it makes the root the issuer of every district's records. |

Publication is the same for K1 and K2. The district's EducateOS hostname serves
`/.well-known/did.json`, a `did:web` document whose verification methods use HTTPS `id`s. It also
serves `/.well-known/jwks.json`. The issuer `id` is the HTTPS URL of the district's issuer profile.
Every key's `controller` is that `id`. A district that changes its hostname must keep the old one
serving these documents, because `did:web` keeps no history
(<https://w3c-ccg.github.io/did-method-web/>).

### 2. Which achievements to assert

| Option | Assert | Risk |
| --- | --- | --- |
| **A1. Course completion** | One `AchievementCredential` per completed offering. `achievementType: Course`, with a `Result` whose `status` is `Completed`. | Low. It is a fact the district's records already hold. |
| **A2. Competency attainment** | One per competency a teacher marked attained. `achievementType: Competency`, with an `alignment` of `targetType: CFItem` to the registry's CASE item (<https://www.imsglobal.org/spec/ob/v3p0/main/#alignmenttargettype>). | Medium. It needs a district rule for "attained", and only evidence a teacher approved may count. |
| **A3. Assessment results and grades** | `Result` values, such as a letter grade or a rubric score, on course or assessment achievements. | Higher. Grades are education records under FERPA, and the Implementation Guide notes they "require learner's consent to disclose". |
| **A4. Everything in the archive** | Every submission and every piece of feedback. | **Rejected.** A CLR is a set of assertions, not an export. Work stays in the archive. |

Whichever is chosen, AI-suggested evidence never becomes an assertion, only what a teacher released
does, and nothing is asserted that the district could not defend as its own record. CLRs are always
issued with `partial: true`. Under the spec's wording, `false` would claim "all the assertions for
the learner known by the publisher"
(<https://www.imsglobal.org/spec/clr/v2p0/main/#clrcredential>).

### 3. Learner identifier

| Option | Identifier | Trade-offs |
| --- | --- | --- |
| **L1. Principal ID** | `prn_…` | **Rejected** by the seam. It is a district-internal key. |
| **L2. Email** | `emailAddress`, plain or hashed | **Rejected.** Addresses get reassigned and shared (ADR-0003), and OB 3.0 says emails are not identifiers. |
| **L3. Hashed SIS identifier** | An `IdentityObject` with `identityType: sisSourcedId`, or `oneRosterSourcedId`, `hashed: true`, and a fresh random salt per credential. | Verifiable by anyone who already knows the learner's SIS ID, and unlinkable across credentials for anyone who doesn't. It has no `credentialSubject.id`, so it can't be used with VC-JWT, whose `sub` is required. |
| **L4. A learner-held DID** | `credentialSubject.id` is a `did:key` from the learner's or guardian's wallet, bound through a DID-authentication step. | Best for portability, and lets the holder present the credential. But it needs wallet onboarding. For a minor, the holder is the guardian (CLR §2.12). A stable public DID can be correlated across issuers. |
| **L5. A pairwise random ID** | A per-credential `urn:uuid:` as `id`. | It satisfies JWT `sub`, but proves nothing about who the learner is unless it is paired with L3. |

### 4. Proof format

| Option | Format | Trade-offs |
| --- | --- | --- |
| **P1. Data Integrity `eddsa-rdfc-2022`** | An Ed25519 embedded proof. | It matches the existing Ed25519 code, every certified verifier must support it, and it allows an identifier-only subject (L3). But it needs RDF Dataset Canonicalization of JSON-LD, with the contexts bundled rather than fetched, which means a new dependency to review. |
| **P2. VC-JWT RS256** | An RSA JWT. | No canonicalization. But it needs an RSA key alongside the Ed25519 keys, and a `credentialSubject.id`, so L4 or L5. It also offers no selective disclosure. |

## Recommendation

1. **Custody: K1**, with a dedicated issuing key and K2 left open to a district that asks for it.
   Rotate yearly by adding a new key. Old public keys are never removed. A compromise sets `revoked`
   on the key and reissues what it signed.
2. **Achievements: A1 and A2 only** for the first version, both from teacher-released records. A3
   only by explicit district opt-in, and only for learners, or the guardians of minors, who request
   the credential.
3. **Identifier: L3**, a hashed, per-credential-salted `sisSourcedId`. L4 comes later, once a wallet
   binding flow exists. For a learner below the district's self-consent age, the guardian requests
   and holds the credential, as with transfer consent (`requiredConsenter` in
   `packages/educateos-portability/src/consent.ts`).
4. **Proof: P1**, `eddsa-rdfc-2022`, with the 1EdTech contexts bundled in the package and JSON-LD
   safe mode on.
5. **Revocation:** a `BitstringStatusListEntry`, with lists of 131,072 entries served from the
   district hostname. **No refresh service** for now, because it has no authentication and would
   disclose minors' records to anyone who has the URL.
6. **Certification** (<https://www.imsglobal.org/spec/clr/v2p0/cert/#the-conformance-process-0>)
   needs 1EdTech membership and the CLR Service Consumer (Write) API. Defer it. Build to the spec and
   validate against 1EdTech's public validator, without seeking certification yet.

## Consequences, if accepted

- `ClrIssuer` gets an implementation in `@educateos/portability`, or in a new `@educateos/credentials`
  package if the canonicalization dependency is heavy. It takes the district's achievement
  definitions, a key handle (K1 or K2), and a status-list store.
- The installer gains an issuing-key secret, and the `did.json`, `jwks.json`, issuer profile and
  status-list routes on the district hostname.
- The district admin console gains:
  - the achievement definitions, linked to CASE items;
  - an opt-in for A3;
  - key rotation and revocation actions, each audited without any learner data.
- The archive format doc's CLR section points here.

## Decisions needed from the district governance owner

1. Accept or change the recommendation for each of the four options above (custody, achievements,
   identifier, proof).
2. Name who may trigger key rotation and revocation, which needs district administrator authority.
3. Decide whether the A3 opt-in needs a FERPA review by the district's counsel before it is offered.
