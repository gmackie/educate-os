import { z } from "zod";
import { roleAssignmentInForce, scopeContains, Principal, RoleAssignment, DistrictId } from "@educateos/contracts";
import { BlueprintEducationMetadata, BlueprintReviewCatalog, type BlueprintReviewActor, type BlueprintReviewSnapshot } from "./blueprint-review.ts";

/** Structural subset of SQLite Durable Object storage; transactionSync must roll back on throw. */
export interface BlueprintSqlStorage {
  sql: { exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(closure: () => T): T;
}

/** Required human attestations; all refer to the exact immutable metadata and artifact digest. */
export const BlueprintAttestation = z.strictObject({
  licenseRights: z.literal(true), noCredentials: z.literal(true), noLearnerData: z.literal(true), noSourceChat: z.literal(true),
});
const identity = BlueprintEducationMetadata.pick({ id: true, version: true });
/** Untrusted write commands contain no actor, roles, timestamps or review history. */
export const BlueprintCatalogCommand = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("create"), metadata: BlueprintEducationMetadata, attestation: BlueprintAttestation }),
  z.strictObject({ operation: z.literal("transition"), ...identity.shape,
    action: z.enum(["submitted", "reviewed", "approved", "rejected", "revoked"]), requestId: z.string().min(1).max(200) }),
]);
const publicShape = BlueprintEducationMetadata.pick({ id: true, version: true, artifactDigest: true,
  instructionalIntent: true, gradeBand: true, license: true, requiredCapabilities: true,
  provenance: true, accessibility: true, evaluation: true });
/** Strict public interchange schema: never accepts source bytes, identities or arbitrary payloads. */
export const PublicBlueprintEntry = publicShape.extend({ schemaVersion: z.literal(1) }).strict().refine(
  (entry) => entry.evaluation.outcome === "passed", "Only passed approved entries may be imported",
);
const storedCommand = z.strictObject({ command: BlueprintCatalogCommand,
  actor: z.strictObject({ principal: Principal, assignments: z.array(RoleAssignment) }), at: z.iso.datetime(), revision: z.number().int().positive() });
const TABLE = "educateos_blueprint_commands";

/** A revision mismatch: caller must read again before submitting a different decision. */
export class BlueprintRevisionConflict extends Error {}

/**
 * District-owned append-only SQLite journal. Replays the unchanged strict review SDK inside the
 * same synchronous transaction as the revision check and append. No command is acknowledged
 * before persistence; failed decisions leave neither state nor audit rows. One storage per district.
 */
export class PersistentBlueprintCatalog {
  readonly #storage: BlueprintSqlStorage;
  /** The district that owns this storage, enforced on every access. */
  readonly districtId: DistrictId;
  /** Bind the adapter to one district and its existing SQLite Durable Object storage. */
  constructor(storage: BlueprintSqlStorage, districtId: DistrictId) {
    this.#storage = storage;
    this.districtId = DistrictId.parse(districtId);
  }

  #transaction<T>(fn: () => T): T {
    return this.#storage.transactionSync(() => {
      this.#storage.sql.exec(`CREATE TABLE IF NOT EXISTS educateos_blueprint_owner (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), district_id TEXT NOT NULL)`);
      this.#storage.sql.exec(`INSERT OR IGNORE INTO educateos_blueprint_owner (singleton, district_id) VALUES (1, ?)`, this.districtId);
      const [owner] = this.#storage.sql.exec(`SELECT district_id FROM educateos_blueprint_owner WHERE singleton = 1`).toArray();
      if (owner?.district_id !== this.districtId) throw new Error("Catalog storage belongs to another district");
      this.#storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (revision INTEGER PRIMARY KEY, district_id TEXT NOT NULL, command_json TEXT NOT NULL)`);
      for (const verb of ["UPDATE", "DELETE"]) this.#storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS ${TABLE}_no_${verb} BEFORE ${verb} ON ${TABLE} BEGIN SELECT RAISE(ABORT, 'append-only'); END`);
      return fn();
    });
  }

  #load() {
    const catalog = new BlueprintReviewCatalog();
    const snapshots = new Map<string, BlueprintReviewSnapshot>();
    const audit = this.#storage.sql.exec(`SELECT district_id, command_json FROM ${TABLE} ORDER BY revision`).toArray().map((row, index) => {
      if (row.district_id !== this.districtId || typeof row.command_json !== "string") throw new Error("Catalog district mismatch or corrupt journal");
      const item = storedCommand.parse(JSON.parse(row.command_json));
      if (item.revision !== index + 1) throw new Error("Corrupt catalog revision");
      const snapshot = this.#apply(catalog, item.command, item.actor, new Date(item.at));
      snapshots.set(JSON.stringify([snapshot.metadata.id, snapshot.metadata.version]), snapshot);
      return item;
    });
    return { catalog, audit, snapshots, revision: audit.length };
  }

  #actor(actor: BlueprintReviewActor) {
    if (actor.principal.districtId !== this.districtId || actor.principal.status !== "active") throw new Error("Catalog access denied");
  }

  #apply(catalog: BlueprintReviewCatalog, command: z.infer<typeof BlueprintCatalogCommand>, actor: BlueprintReviewActor, at: Date) {
    this.#actor(actor);
    if (command.operation === "create") {
      if (command.metadata.scope.districtId !== this.districtId) throw new Error("Catalog access denied");
      return catalog.create(command.metadata, actor);
    }
    return catalog.transition(command.id, command.version, command.action, command.requestId, actor, at);
  }

  /** Execute with optimistic concurrency. Exact retries return current state without another audit event. */
  execute(input: unknown, expectedRevision: number, actor: BlueprintReviewActor, at: Date) {
    const command = BlueprintCatalogCommand.parse(input);
    z.number().int().nonnegative().parse(expectedRevision);
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid clock");
    return this.#transaction(() => {
      this.#actor(actor);
      const { catalog, audit, revision } = this.#load();
      // Apply before retry detection so a retry still requires current authority.
      const snapshot = this.#apply(catalog, command, actor, at);
      const duplicate = audit.some((item) => item.actor.principal.id === actor.principal.id && JSON.stringify(item.command) === JSON.stringify(command));
      if (duplicate) return { revision, snapshot };
      if (revision !== expectedRevision) throw new BlueprintRevisionConflict("Catalog revision changed");
      const next = revision + 1;
      this.#storage.sql.exec(`INSERT INTO ${TABLE} (revision, district_id, command_json) VALUES (?, ?, ?)`, next, this.districtId,
        JSON.stringify({ command, actor, at: at.toISOString(), revision: next }));
      return { revision: next, snapshot };
    });
  }

  /** Inspect private version metadata as its author or a currently scoped staff reviewer. */
  review(id: string, version: string, actor: BlueprintReviewActor, at: Date) {
    return this.#transaction(() => {
      this.#actor(actor);
      const { snapshots, revision } = this.#load();
      const snapshot = snapshots.get(JSON.stringify([id, version]));
      if (!snapshot) throw new Error("Unknown Blueprint version");
      if (actor.principal.id !== snapshot.metadata.author.id && !(actor.principal.kind === "staff"
        && actor.assignments.some((a) => a.principalId === actor.principal.id
          && ["teacher", "curriculum-admin", "district-admin"].includes(a.role)
          && roleAssignmentInForce(a, at) && scopeContains(a.scope, snapshot.metadata.scope)))) {
        throw new Error("Review access denied");
      }
      return { revision, snapshot };
    });
  }

  /** Read current public entries; revoked versions are absent even after an approval retry. */
  entries(actor: BlueprintReviewActor) {
    return this.#transaction(() => { this.#actor(actor); const { catalog, revision } = this.#load();
      return { revision, entries: catalog.exportEntries().map((entry) => PublicBlueprintEntry.parse(entry)) }; });
  }

  /** Fetch a current approved manifest, never an artifact URL or source payload. */
  download(id: string, version: string, actor: BlueprintReviewActor) {
    const { entries } = this.entries(actor);
    const entry = entries.find((item) => item.id === id && item.version === version);
    if (!entry) throw new Error("Approved Blueprint not found");
    return entry;
  }

  /** Persist only strict public manifests in a quarantine table; import never conveys local approval. */
  importEntries(input: unknown, actor: BlueprintReviewActor, at: Date) {
    const entries = z.array(PublicBlueprintEntry).max(100).parse(input);
    if (!Number.isFinite(at.getTime())) throw new Error("Invalid clock");
    return this.#transaction(() => {
      assertCatalogAdmin(actor, this.districtId, at);
      this.#storage.sql.exec(`CREATE TABLE IF NOT EXISTS educateos_blueprint_imports (district_id TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, entry_json TEXT NOT NULL, actor_id TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY (district_id, id, version))`);
      for (const entry of entries) {
        const json = JSON.stringify(entry);
        const [existing] = this.#storage.sql.exec(`SELECT entry_json FROM educateos_blueprint_imports WHERE district_id = ? AND id = ? AND version = ?`, this.districtId, entry.id, entry.version).toArray();
        if (existing && existing.entry_json !== json) throw new Error("Imported version is immutable");
        this.#storage.sql.exec(`INSERT OR IGNORE INTO educateos_blueprint_imports (district_id, id, version, entry_json, actor_id, imported_at) VALUES (?, ?, ?, ?, ?, ?)`, this.districtId, entry.id, entry.version, json, actor.principal.id, at.toISOString());
      }
      return { imported: entries.length, status: "quarantined" as const };
    });
  }

  /** Internal audit restricted to active district staff with an in-force district-wide admin role. */
  audit(actor: BlueprintReviewActor, at: Date) {
    return this.#transaction(() => { this.#actor(actor);
      assertCatalogAdmin(actor, this.districtId, at);
      return this.#load().audit;
    });
  }
}

/** Authorization used for catalog administration and quarantined marketplace imports. */
export function assertCatalogAdmin(actor: BlueprintReviewActor, districtId: DistrictId, at: Date): void {
  if (actor.principal.status !== "active" || actor.principal.kind !== "staff" || actor.principal.districtId !== districtId
    || !actor.assignments.some((a) => a.principalId === actor.principal.id && a.scope.level === "district"
      && a.scope.districtId === districtId && ["district-admin", "curriculum-admin"].includes(a.role) && roleAssignmentInForce(a, at))) {
    throw new Error("Catalog administration denied");
  }
}
