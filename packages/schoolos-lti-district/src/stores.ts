import { z } from "zod";
import { EnrollmentId, OfferingId, SchoolOsError, SourceLink, UtcTimestamp } from "@schoolos/contracts";
import {
  ActivityLink,
  decidePassbackClaim,
  GradeRoute,
  LtiContextServices,
  PassbackLedgerEntry,
  PendingPlatformRegistration,
  PlatformRegistration,
  settlePassbackEntry,
  type Clock,
  type GradeRouteStore,
  type PassbackClaim,
  type PassbackLedger,
  type PendingRegistrationId,
  type PendingRegistrationStore,
  type PlatformRegistrationStore,
  type RegistrationKey,
  type SingleUseStore,
} from "@schoolos/lti";
import { tupleKey, type RecordTable } from "./table.ts";

/** The collection each store keeps its records in. */
export const LTI_COLLECTIONS = {
  loginStates: "lti.login-state",
  deepLinkSessions: "lti.deep-link-session",
  invitations: "lti.registration-invitation",
  registrations: "lti.registration",
  pendingRegistrations: "lti.pending-registration",
  passback: "lti.passback",
  contextServices: "lti.context-services",
  gradeRoutes: "lti.grade-route",
  gradeColumns: "lti.grade-column",
  rosterSources: "lti.roster-source",
} as const;

/** Thrown when a stored record does not match its schema. Nothing is decided on such a record. */
export class LtiStoredRecordError extends Error {
  override readonly name = "LtiStoredRecordError";
}

function read<T>(schema: z.ZodType<T>, value: unknown, collection: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new LtiStoredRecordError(`a ${collection} record does not match its schema`);
  return parsed.data;
}

/**
 * A {@link SingleUseStore} over a record table. `take` removes the record in one step and returns
 * it only if it has not expired, so of two concurrent takes at most one receives the value: this is
 * what makes a replayed login state, deep linking session or registration invitation fail.
 */
export class TableSingleUseStore<T> implements SingleUseStore<T> {
  readonly #table: RecordTable;
  readonly #collection: string;
  readonly #schema: z.ZodType<T>;
  readonly #now: Clock;

  constructor(table: RecordTable, collection: string, schema: z.ZodType<T>, now: Clock = Date.now) {
    this.#table = table;
    this.#collection = collection;
    this.#schema = schema;
    this.#now = now;
  }

  /** Stores `value`, refusing a key already in use. Expired records are purged as a side effect. */
  async put(key: string, value: T, expiresAt: number): Promise<void> {
    const parsed = this.#schema.parse(value);
    this.#table.atomically(() => {
      this.#table.purgeExpired(this.#collection, this.#now());
      if (this.#table.get(this.#collection, key) !== undefined) throw new SchoolOsError("conflict", "That single-use key is taken.");
      this.#table.put(this.#collection, key, parsed, expiresAt);
    });
  }

  async take(key: string): Promise<T | undefined> {
    const row = this.#table.atomically(() => this.#table.delete(this.#collection, key));
    if (row === undefined || row.expiresAt === undefined || row.expiresAt <= this.#now()) return undefined;
    return read(this.#schema, row.value, this.#collection);
  }
}

/**
 * Checks a registration's targets against the district before it is stored: that its offerings
 * and activities exist (see `directoryRegistrationTargets`).
 */
export interface RegistrationTargets {
  /** Refuses a registration for another district, an untrusted issuer, or an unknown offering or activity. */
  assertRegistration(registration: PlatformRegistration): Promise<void>;
  /** Refuses a link to an activity that is not installed in the link's offering. */
  assertActivityLink(link: ActivityLink): Promise<void>;
}

/** A {@link PlatformRegistrationStore} the district's admin service can also add to. */
export interface DistrictRegistrationStore extends PlatformRegistrationStore {
  /** Every registration. */
  list(): Promise<readonly PlatformRegistration[]>;
  /**
   * Stores a new registration after checking its targets. Throws `conflict` if one with the same
   * `(issuer, clientId)` exists.
   */
  save(registration: PlatformRegistration): Promise<void>;
}

const registrationKey = (key: RegistrationKey): string => tupleKey(key.issuer, key.clientId);

/** A {@link DistrictRegistrationStore} over a record table. */
export class TableRegistrationStore implements DistrictRegistrationStore {
  readonly #table: RecordTable;
  readonly #targets: RegistrationTargets;

  constructor(table: RecordTable, targets: RegistrationTargets) {
    this.#table = table;
    this.#targets = targets;
  }

  async get(key: RegistrationKey): Promise<PlatformRegistration | undefined> {
    const row = this.#table.get(LTI_COLLECTIONS.registrations, registrationKey(key));
    return row === undefined ? undefined : read(PlatformRegistration, row.value, LTI_COLLECTIONS.registrations);
  }

  async listByIssuer(issuer: string): Promise<readonly PlatformRegistration[]> {
    return (await this.list()).filter((registration) => registration.issuer === issuer);
  }

  async list(): Promise<readonly PlatformRegistration[]> {
    return this.#table.list(LTI_COLLECTIONS.registrations).map(({ row }) => read(PlatformRegistration, row.value, LTI_COLLECTIONS.registrations));
  }

  async save(input: PlatformRegistration): Promise<void> {
    const registration = PlatformRegistration.parse(input);
    await this.#targets.assertRegistration(registration);
    const key = registrationKey(registration);
    this.#table.atomically(() => {
      if (this.#table.get(LTI_COLLECTIONS.registrations, key) !== undefined) {
        throw new SchoolOsError("conflict", "This platform is already registered with that client ID.");
      }
      this.#table.put(LTI_COLLECTIONS.registrations, key, registration);
    });
  }

  async addActivityLink(key: RegistrationKey, input: ActivityLink): Promise<void> {
    const link = ActivityLink.parse(input);
    await this.#targets.assertActivityLink(link);
    const stored = registrationKey(key);
    // Read, append and write with no await between them, so two links added at once both land or
    // the second is refused as a duplicate; neither overwrites the other.
    this.#table.atomically(() => {
      const row = this.#table.get(LTI_COLLECTIONS.registrations, stored);
      if (row === undefined) throw new SchoolOsError("not-found", "No such LTI registration.");
      const registration = read(PlatformRegistration, row.value, LTI_COLLECTIONS.registrations);
      const updated = PlatformRegistration.safeParse({ ...registration, activityLinks: [...registration.activityLinks, link] });
      if (!updated.success) throw new SchoolOsError("conflict", "That link is already mapped in this offering, or the offering is not this platform's.");
      this.#table.put(LTI_COLLECTIONS.registrations, stored, updated.data);
    });
  }
}

/** A {@link PendingRegistrationStore} over a record table. */
export class TablePendingRegistrationStore implements PendingRegistrationStore {
  readonly #table: RecordTable;

  constructor(table: RecordTable) {
    this.#table = table;
  }

  async put(input: PendingPlatformRegistration): Promise<void> {
    const pending = PendingPlatformRegistration.parse(input);
    this.#table.atomically(() => {
      if (this.#table.get(LTI_COLLECTIONS.pendingRegistrations, pending.id) !== undefined) {
        throw new SchoolOsError("conflict", "That pending registration already exists.");
      }
      this.#table.put(LTI_COLLECTIONS.pendingRegistrations, pending.id, pending);
    });
  }

  async get(id: PendingRegistrationId): Promise<PendingPlatformRegistration | undefined> {
    const row = this.#table.get(LTI_COLLECTIONS.pendingRegistrations, id);
    return row === undefined ? undefined : read(PendingPlatformRegistration, row.value, LTI_COLLECTIONS.pendingRegistrations);
  }

  async list(): Promise<readonly PendingPlatformRegistration[]> {
    return this.#table
      .list(LTI_COLLECTIONS.pendingRegistrations)
      .map(({ row }) => read(PendingPlatformRegistration, row.value, LTI_COLLECTIONS.pendingRegistrations));
  }

  async remove(id: PendingRegistrationId): Promise<boolean> {
    return this.#table.atomically(() => this.#table.delete(LTI_COLLECTIONS.pendingRegistrations, id)) !== undefined;
  }
}

/**
 * A {@link PassbackLedger} over a record table. `claim` reads the entry, decides with the shared
 * `decidePassbackClaim` rule and records the claim in one atomic step, so of two concurrent claims
 * for one version exactly one is `claimed`.
 */
export class TablePassbackLedger implements PassbackLedger {
  readonly #table: RecordTable;

  constructor(table: RecordTable) {
    this.#table = table;
  }

  async claim(key: string, version: number, approvedAtMs: number, now: number, leaseUntil: number): Promise<PassbackClaim> {
    return this.#table.atomically(() => {
      const decision = decidePassbackClaim(this.#entry(key), version, approvedAtMs, now, leaseUntil);
      if (decision.claim === "claimed") this.#table.put(LTI_COLLECTIONS.passback, key, decision.entry);
      return decision.claim;
    });
  }

  async complete(key: string, version: number): Promise<void> {
    this.#settle(key, version, "complete");
  }

  async release(key: string, version: number): Promise<void> {
    this.#settle(key, version, "release");
  }

  #settle(key: string, version: number, outcome: "complete" | "release"): void {
    this.#table.atomically(() => {
      const next = settlePassbackEntry(this.#entry(key), version, outcome);
      if (next !== undefined) this.#table.put(LTI_COLLECTIONS.passback, key, next);
    });
  }

  #entry(key: string): PassbackLedgerEntry | undefined {
    const row = this.#table.get(LTI_COLLECTIONS.passback, key);
    return row === undefined ? undefined : read(PassbackLedgerEntry, row.value, LTI_COLLECTIONS.passback);
  }
}

/** One context's LTI Advantage services, as last reported by a launch into an offering. */
export const RecordedContextServices = z.strictObject({
  offeringId: OfferingId,
  services: LtiContextServices,
  /** When the launch that reported them was accepted. */
  observedAt: UtcTimestamp,
});
/** Recorded context services. */
export type RecordedContextServices = z.infer<typeof RecordedContextServices>;

/** Where the services launches report are kept, per offering and platform context. */
export interface ContextServicesStore {
  /**
   * Records what a launch reported. A record older than the stored one is ignored, so a delayed
   * launch cannot bring back URLs the platform has since replaced.
   */
  record(input: RecordedContextServices): Promise<void>;
  /** Every context recorded for `offeringId`. */
  list(offeringId: OfferingId): Promise<readonly RecordedContextServices[]>;
}

const contextKey = (offeringId: OfferingId, services: LtiContextServices): string =>
  tupleKey(offeringId, services.registration.issuer, services.registration.clientId, services.contextId);

/** A {@link ContextServicesStore} over a record table. */
export class TableContextServicesStore implements ContextServicesStore {
  readonly #table: RecordTable;

  constructor(table: RecordTable) {
    this.#table = table;
  }

  async record(input: RecordedContextServices): Promise<void> {
    const recorded = RecordedContextServices.parse(input);
    const key = contextKey(recorded.offeringId, recorded.services);
    this.#table.atomically(() => {
      const row = this.#table.get(LTI_COLLECTIONS.contextServices, key);
      const current = row === undefined ? undefined : read(RecordedContextServices, row.value, LTI_COLLECTIONS.contextServices);
      if (current !== undefined && Date.parse(current.observedAt) > Date.parse(recorded.observedAt)) return;
      this.#table.put(LTI_COLLECTIONS.contextServices, key, recorded);
    });
  }

  async list(offeringId: OfferingId): Promise<readonly RecordedContextServices[]> {
    return this.#table
      .list(LTI_COLLECTIONS.contextServices)
      .map(({ row }) => read(RecordedContextServices, row.value, LTI_COLLECTIONS.contextServices))
      .filter((recorded) => recorded.offeringId === offeringId);
  }
}

/** A {@link GradeRouteStore} an administrator sets routes in. */
export interface ConfigurableGradeRouteStore extends GradeRouteStore {
  /** Sets (or replaces) the offering's route. */
  setRoute(route: GradeRoute): Promise<void>;
}

/** A {@link ConfigurableGradeRouteStore} over a record table. */
export class TableGradeRouteStore implements ConfigurableGradeRouteStore {
  readonly #table: RecordTable;

  constructor(table: RecordTable) {
    this.#table = table;
  }

  async routeFor(offeringId: OfferingId): Promise<GradeRoute | undefined> {
    const row = this.#table.get(LTI_COLLECTIONS.gradeRoutes, offeringId);
    return row === undefined ? undefined : read(GradeRoute, row.value, LTI_COLLECTIONS.gradeRoutes);
  }

  async setRoute(input: GradeRoute): Promise<void> {
    const route = GradeRoute.parse(input);
    this.#table.atomically(() => this.#table.put(LTI_COLLECTIONS.gradeRoutes, route.offeringId, route));
  }
}

/**
 * What a roster sync remembers about one external roster (one platform context feeding one
 * offering): the projection it last applied, and a source link for every enrollment it wrote.
 * The links are how a later sync finds who has left: an enrollment this source wrote that its
 * roster no longer lists becomes inactive.
 */
export const RosterSourceState = z.strictObject({
  /** The `observedAt` of the last projection applied. A projection no newer than it is refused. */
  observedAt: UtcTimestamp.optional(),
  enrollments: z.record(EnrollmentId, SourceLink),
});
/** A roster source's state. */
export type RosterSourceState = z.infer<typeof RosterSourceState>;

/** Where roster sources' state is kept. */
export interface RosterSourceStore {
  /** The state for `key`, or an empty one. */
  load(key: string): Promise<RosterSourceState>;
  /** Stores the state for `key`, refusing one older than what is stored. */
  save(key: string, state: RosterSourceState): Promise<void>;
}

/** A {@link RosterSourceStore} over a record table. */
export class TableRosterSourceStore implements RosterSourceStore {
  readonly #table: RecordTable;

  constructor(table: RecordTable) {
    this.#table = table;
  }

  async load(key: string): Promise<RosterSourceState> {
    const row = this.#table.get(LTI_COLLECTIONS.rosterSources, key);
    return row === undefined ? { enrollments: {} } : read(RosterSourceState, row.value, LTI_COLLECTIONS.rosterSources);
  }

  async save(key: string, input: RosterSourceState): Promise<void> {
    const state = RosterSourceState.parse(input);
    this.#table.atomically(() => {
      const row = this.#table.get(LTI_COLLECTIONS.rosterSources, key);
      const stored = row === undefined ? undefined : read(RosterSourceState, row.value, LTI_COLLECTIONS.rosterSources).observedAt;
      if (stored !== undefined && (state.observedAt === undefined || Date.parse(state.observedAt) < Date.parse(stored))) {
        throw new SchoolOsError("conflict", "A newer roster has already been applied.");
      }
      this.#table.put(LTI_COLLECTIONS.rosterSources, key, state);
    });
  }
}
