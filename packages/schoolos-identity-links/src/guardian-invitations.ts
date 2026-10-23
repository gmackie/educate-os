import { z } from "zod";
import {
  DistrictId,
  externalIdentityKey,
  GuardianRelationshipId,
  PrincipalId,
  SchoolOsError,
  UtcTimestamp,
  type Caller,
  type GuardianRelationship,
  type VerifiedIdentity,
} from "@schoolos/contracts";
import type { AcademicStore } from "@schoolos/academics";
import { requestNewPrincipalLink } from "@schoolos/identity";
import {
  NewGuardianRelationship,
  type GuardianRelationships,
  type GuardianRelationshipStore,
} from "@schoolos/policy";
import { IdentityRequestId, newIdentityRequestId } from "./records.ts";
import type { IdentityLinkStore } from "./store.ts";

/** Identifies a guardian invitation. Opaque and random. */
export const GuardianInvitationId = z.string().regex(/^gin_[0-9a-f-]{36}$/, "expected a guardian invitation ID (gin_…)").brand<"guardianInvitation">();
/** A guardian invitation ID. */
export type GuardianInvitationId = z.infer<typeof GuardianInvitationId>;

/** How long an invitation can be redeemed for by default: a week. */
export const DEFAULT_GUARDIAN_INVITATION_HOURS = 7 * 24;

/** The longest an invitation can stay redeemable: thirty days. */
export const MAX_GUARDIAN_INVITATION_HOURS = 30 * 24;

/**
 * What redeeming an invitation did.
 *
 * - `awaiting-approval`: the guardian had no principal, so a pending identity link was recorded
 *   (`requestId`) that creates one when a district admin approves it.
 * - `joined`: the identity already belonged to an active guardian (a parent with a child already
 *   on SchoolOS), so the pending relationship now names that guardian.
 */
export const GuardianInvitationRedemption = z.strictObject({
  at: UtcTimestamp,
  outcome: z.enum(["awaiting-approval", "joined"]),
  /** The guardian the relationship names after redemption. */
  guardianPrincipalId: PrincipalId,
  /** For `awaiting-approval`, the identity request a district admin decides. */
  requestId: IdentityRequestId.optional(),
});
/** An invitation redemption. */
export type GuardianInvitationRedemption = z.infer<typeof GuardianInvitationRedemption>;

/**
 * A district admin's single-use invitation for one guardian of one student (ADR-0012). It is never
 * authority: redeeming it only starts the guardian's identity link request, which a district admin
 * approves, and the relationship it was issued with stays `pending` until a district admin confirms
 * it. Only the token's SHA-256 digest is kept, so the stored invitation cannot be redeemed by
 * whoever reads it, and no email is kept at all: the link is handed over by the administrator.
 */
export const GuardianInvitation = z.strictObject({
  id: GuardianInvitationId,
  districtId: DistrictId,
  studentPrincipalId: PrincipalId,
  /** The pending relationship the invitation was issued with. */
  relationshipId: GuardianRelationshipId,
  /** The principal ID reserved for the guardian, which approving their sign-in creates. */
  reservedGuardianPrincipalId: PrincipalId,
  /** The name the guardian's principal is created with. */
  guardianDisplayName: z.string().trim().min(1).max(200),
  /** The hex SHA-256 digest of the token. */
  tokenDigest: z.string().regex(/^[0-9a-f]{64}$/),
  created: z.strictObject({ by: PrincipalId, at: UtcTimestamp }),
  expiresAt: UtcTimestamp,
  /** Set once, when the invitation is redeemed. */
  redeemed: GuardianInvitationRedemption.optional(),
});
/** A guardian invitation. */
export type GuardianInvitation = z.infer<typeof GuardianInvitation>;

/** An invitation as an administrator reviews it: without its token digest. */
export type GuardianInvitationView = Omit<GuardianInvitation, "tokenDigest">;

/** Where a district's guardian invitations are kept. Invitations are never deleted. */
export interface GuardianInvitationStore {
  /** The invitation whose token has this digest. */
  findByTokenDigest(tokenDigest: string): Promise<GuardianInvitation | undefined>;
  /** Every invitation for a student, oldest first. */
  listForStudent(studentPrincipalId: PrincipalId): Promise<GuardianInvitation[]>;
  /** Adds a new invitation. Throws if its ID or token digest is already stored. */
  add(invitation: GuardianInvitation): Promise<void>;
  /**
   * Records the invitation's redemption if it has none yet, and reports whether it did: of two
   * redemptions racing for one invitation, exactly one succeeds.
   */
  claim(id: GuardianInvitationId, redemption: GuardianInvitationRedemption): Promise<boolean>;
}

/** A {@link GuardianInvitationStore} in memory, for tests and local development. */
export class InMemoryGuardianInvitationStore implements GuardianInvitationStore {
  readonly #invitations: GuardianInvitation[] = [];

  async findByTokenDigest(tokenDigest: string): Promise<GuardianInvitation | undefined> {
    return structuredClone(this.#invitations.find((i) => i.tokenDigest === tokenDigest));
  }

  async listForStudent(studentPrincipalId: PrincipalId): Promise<GuardianInvitation[]> {
    return structuredClone(this.#invitations.filter((i) => i.studentPrincipalId === studentPrincipalId));
  }

  async add(invitation: GuardianInvitation): Promise<void> {
    const parsed = GuardianInvitation.parse(invitation);
    if (this.#invitations.some((i) => i.id === parsed.id || i.tokenDigest === parsed.tokenDigest)) throw new Error("duplicate guardian invitation");
    this.#invitations.push(parsed);
  }

  async claim(id: GuardianInvitationId, redemption: GuardianInvitationRedemption): Promise<boolean> {
    const invitation = this.#invitations.find((i) => i.id === id);
    if (invitation === undefined || invitation.redeemed !== undefined) return false;
    invitation.redeemed = GuardianInvitationRedemption.parse(redemption);
    return true;
  }
}

/** What inviting a guardian takes. */
export const NewGuardianInvitation = NewGuardianRelationship.omit({ guardianPrincipalId: true }).extend({
  /** The name the guardian's account is created with. */
  guardianDisplayName: z.string().trim().min(1).max(200),
  /** How long the link can be redeemed for. Defaults to a week. */
  expiresInHours: z.int().min(1).max(MAX_GUARDIAN_INVITATION_HOURS).default(DEFAULT_GUARDIAN_INVITATION_HOURS),
});
/** A new guardian invitation. */
export type NewGuardianInvitation = z.input<typeof NewGuardianInvitation>;

/** What issuing an invitation produced. The token is returned only here; only its digest is stored. */
export interface IssuedGuardianInvitation {
  invitation: GuardianInvitationView;
  relationship: GuardianRelationship;
  /** The single-use secret the guardian redeems. Hand it over as a link; it is never shown again. */
  token: string;
}

/** What a guardian's redemption produced. */
export interface RedeemedGuardianInvitation {
  outcome: GuardianInvitationRedemption["outcome"];
}

/** What a {@link GuardianInvitations} service is built from. */
export interface GuardianInvitationsOptions {
  /** Where invitations are kept. */
  store: GuardianInvitationStore;
  /** The district's relationship service, which decides and records the relationship. */
  relationships: GuardianRelationships;
  /** Where relationships are kept, which a redemption by an existing guardian updates. */
  relationshipStore: GuardianRelationshipStore;
  /** The district's identity-link log, where a redemption's link request waits for a district admin. */
  identityLinks: IdentityLinkStore;
  /** The district's directory. Never written here. */
  directory: AcademicStore;
  /** The clock. Defaults to the system clock. */
  now?: () => Date;
}

const INVALID = "This invitation link can't be used. Ask the school for a new one.";

const toHex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The digest a token is stored and found by. */
export async function guardianInvitationDigest(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

const TOKEN = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

function viewOf({ tokenDigest: _, ...view }: GuardianInvitation): GuardianInvitationView {
  return view;
}

/**
 * Guardian onboarding (ADR-0012 §8): three decisions, each recorded on its own.
 *
 * 1. A district admin invites a guardian for a named student ({@link invite}). That records a
 *    `pending` relationship through `GuardianRelationships` (decided as `create` on a
 *    `guardian-relationship`), reserves the principal ID the guardian will get, and returns a
 *    single-use token for the administrator to hand over.
 * 2. The guardian signs in through a trusted issuer and redeems the token ({@link redeem}). An
 *    identity no principal holds yet becomes a pending identity link that creates the guardian's
 *    principal when a district admin approves it (`IdentityLinkAdminService`); an identity that is
 *    already an active guardian's joins the relationship directly, since they were already
 *    approved. Either way nothing is granted: the relationship is still `pending`.
 * 3. A district admin confirms the relationship (`GuardianRelationships.confirm`).
 */
export class GuardianInvitations {
  readonly #store: GuardianInvitationStore;
  readonly #relationships: GuardianRelationships;
  readonly #relationshipStore: GuardianRelationshipStore;
  readonly #identityLinks: IdentityLinkStore;
  readonly #directory: AcademicStore;
  readonly #now: () => Date;

  constructor(options: GuardianInvitationsOptions) {
    this.#store = options.store;
    this.#relationships = options.relationships;
    this.#relationshipStore = options.relationshipStore;
    this.#identityLinks = options.identityLinks;
    this.#directory = options.directory;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Invites a guardian for a student: records the pending relationship and the invitation.
   *
   * @throws SchoolOsError `forbidden` unless the caller is a district admin, and whatever
   *   `GuardianRelationships.record` refuses.
   */
  async invite(caller: Caller, rawInput: unknown): Promise<IssuedGuardianInvitation> {
    const parsed = NewGuardianInvitation.safeParse(rawInput);
    if (!parsed.success) throw new SchoolOsError("validation-failed", z.prettifyError(parsed.error).slice(0, 1000));
    const { guardianDisplayName, expiresInHours, ...terms } = parsed.data;
    const reservedGuardianPrincipalId = PrincipalId.parse(`prn_g-${crypto.randomUUID()}`);
    const relationship = await this.#relationships.record(caller, { ...terms, guardianPrincipalId: reservedGuardianPrincipalId });

    const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const at = this.#now();
    const invitation = GuardianInvitation.parse({
      id: `gin_${crypto.randomUUID()}`,
      districtId: relationship.districtId,
      studentPrincipalId: relationship.studentPrincipalId,
      relationshipId: relationship.id,
      reservedGuardianPrincipalId,
      guardianDisplayName,
      tokenDigest: await guardianInvitationDigest(token),
      created: { by: caller.principal.principalId, at: at.toISOString() },
      expiresAt: new Date(at.getTime() + expiresInHours * 3_600_000).toISOString(),
    });
    await this.#store.add(invitation);
    return { invitation: viewOf(invitation), relationship, token };
  }

  /**
   * Redeems an invitation as the identity a trusted issuer verified. The token is spent whatever
   * follows, so a link that leaked can be used once at most, and every refusal of a token (unknown,
   * expired, spent, or its relationship no longer pending) is the same `not-found`.
   *
   * @throws SchoolOsError `not-found` for a token that cannot be used; `forbidden` for an identity
   *   that belongs to someone who is not a guardian, or one from an issuer the district does not
   *   trust; `conflict` when the guardian already has a relationship to the student.
   */
  async redeem(identity: VerifiedIdentity, rawToken: unknown): Promise<RedeemedGuardianInvitation> {
    const token = TOKEN.safeParse(rawToken);
    if (!token.success) throw new SchoolOsError("not-found", INVALID);
    const invitation = await this.#store.findByTokenDigest(await guardianInvitationDigest(token.data));
    const at = this.#now();
    if (invitation === undefined || invitation.redeemed !== undefined || at.getTime() >= Date.parse(invitation.expiresAt)) {
      throw new SchoolOsError("not-found", INVALID);
    }
    const relationship = await this.#relationshipStore.get(invitation.relationshipId);
    if (relationship === undefined || relationship.status !== "pending" || relationship.guardianPrincipalId !== invitation.reservedGuardianPrincipalId) {
      throw new SchoolOsError("not-found", INVALID);
    }

    const { snapshot } = await this.#directory.load();
    const key = externalIdentityKey({ districtId: snapshot.district.id, issuer: identity.issuer, subject: identity.subject });
    const holder = snapshot.principals.find((p) => p.externalIdentities.some((i) => externalIdentityKey(i) === key));
    if (holder !== undefined) return this.#join(invitation, relationship, holder, identity, at);

    // Checks the identity can be linked before the token is spent, so a mistaken sign-in (another
    // district's issuer, a service credential) does not use up the guardian's link.
    const link = requestNewPrincipalLink(snapshot, {
      principalId: invitation.reservedGuardianPrincipalId,
      newPrincipal: { kind: "guardian", displayName: invitation.guardianDisplayName },
      identity,
      requestedAt: at.toISOString(),
    });
    const requestId = newIdentityRequestId();
    const claimed = await this.#store.claim(invitation.id, {
      at: at.toISOString(),
      outcome: "awaiting-approval",
      guardianPrincipalId: invitation.reservedGuardianPrincipalId,
      requestId,
    });
    if (!claimed) throw new SchoolOsError("not-found", INVALID);
    // The reserved principal ID belongs to this invitation alone, which only this redemption has
    // claimed, so no other request can be open for it.
    await this.#identityLinks.transact(() => ({ append: [{ type: "link-requested", requestId, link }], result: undefined }));
    return { outcome: "awaiting-approval" };
  }

  /** Every invitation for a student, for review. Decided as listing the student's relationships. */
  async listForStudent(caller: Caller, rawStudentId: unknown): Promise<GuardianInvitationView[]> {
    await this.#relationships.listForStudent(caller, rawStudentId);
    return (await this.#store.listForStudent(PrincipalId.parse(rawStudentId))).map(viewOf);
  }

  async #join(
    invitation: GuardianInvitation,
    relationship: GuardianRelationship,
    holder: { id: PrincipalId; kind: string; status: string },
    identity: VerifiedIdentity,
    at: Date,
  ): Promise<RedeemedGuardianInvitation> {
    if (holder.kind !== "guardian" || holder.status !== "active" || identity.credential !== "person") {
      throw new SchoolOsError("forbidden", "This sign-in belongs to an account that cannot be a guardian. Sign in with your own account.");
    }
    const open = (await this.#relationshipStore.listForStudent(relationship.studentPrincipalId))
      .some((r) => r.guardianPrincipalId === holder.id && r.status !== "revoked");
    if (open) throw new SchoolOsError("conflict", "You are already connected to this student.");
    const claimed = await this.#store.claim(invitation.id, { at: at.toISOString(), outcome: "joined", guardianPrincipalId: holder.id });
    if (!claimed) throw new SchoolOsError("not-found", INVALID);
    const next = { ...relationship, guardianPrincipalId: holder.id };
    await this.#relationshipStore.commit(next, {
      districtId: relationship.districtId,
      actor: { principalId: holder.id },
      action: "guardian-relationship.guardian-joined",
      target: { relationshipId: relationship.id, guardianPrincipalId: holder.id, studentPrincipalId: relationship.studentPrincipalId },
      at: at.toISOString(),
    }, relationship);
    return { outcome: "joined" };
  }
}
