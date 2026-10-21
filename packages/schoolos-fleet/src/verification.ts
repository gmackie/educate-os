import type { CommercialAccountId, InstanceId } from "@schoolos/contracts";
import type { ContactRole } from "./protocol.ts";

/**
 * What the root asks its commercial system about a registration (roadmap §9.1.1). Identifiers and
 * the contact's role only: the commercial system holds the contact people, and nothing about them
 * passes through the fleet protocol or this port.
 */
export interface RegistrationVerificationRequest {
  commercialAccountId: CommercialAccountId;
  instanceId: InstanceId;
  contactRole: ContactRole;
}

/** Why the commercial system refused a registration. */
export type RegistrationRefusal =
  /** No account has this ID. */
  | "unknown-account"
  /** The account has no verified contact in the stated role. */
  | "contact-unverified"
  /** The account's verified contact has not confirmed this instance. */
  | "instance-not-confirmed";

/** The commercial system's answer about one registration. */
export type RegistrationVerification = { outcome: "verified" } | { outcome: "refused"; reason: RegistrationRefusal };

/**
 * The root's port to its commercial system, consulted before a registration is accepted: the
 * account must exist, have a verified contact in the stated role, and that contact must have
 * confirmed this instance out of band. The private root service implements it over its CRM; a
 * verifier that throws fails the registration.
 */
export interface CommercialAccountVerifier {
  /** Whether the commercial system vouches for this registration. */
  verifyRegistration(request: RegistrationVerificationRequest): Promise<RegistrationVerification>;
}

/** One account as the {@link FakeCommercialAccountVerifier} knows it. */
export interface FakeCommercialAccount {
  commercialAccountId: CommercialAccountId;
  /** The roles of the account's verified contacts. */
  verifiedContactRoles: readonly ContactRole[];
  /** The instances those contacts confirmed. */
  confirmedInstanceIds: readonly InstanceId[];
}

/**
 * A {@link CommercialAccountVerifier} over a fixed list of accounts, for tests and the local
 * harness. It records every request it was asked, so a test can check what reached it.
 */
export class FakeCommercialAccountVerifier implements CommercialAccountVerifier {
  /** Every request, in order. */
  readonly requests: RegistrationVerificationRequest[] = [];
  readonly #accounts: Map<CommercialAccountId, FakeCommercialAccount>;

  constructor(accounts: readonly FakeCommercialAccount[]) {
    this.#accounts = new Map(accounts.map((account) => [account.commercialAccountId, account]));
  }

  async verifyRegistration(request: RegistrationVerificationRequest): Promise<RegistrationVerification> {
    this.requests.push(structuredClone(request));
    const account = this.#accounts.get(request.commercialAccountId);
    if (account === undefined) return { outcome: "refused", reason: "unknown-account" };
    if (!account.verifiedContactRoles.includes(request.contactRole)) return { outcome: "refused", reason: "contact-unverified" };
    if (!account.confirmedInstanceIds.includes(request.instanceId)) return { outcome: "refused", reason: "instance-not-confirmed" };
    return { outcome: "verified" };
  }
}
