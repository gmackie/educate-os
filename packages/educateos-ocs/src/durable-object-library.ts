// The district course library on Durable Object SQLite (SCHO-96), published as its own entry point
// (`@educateos/ocs/durable-object-library`). Like the Content Studio's store, it names the storage it
// needs structurally and imports nothing from `cloudflare:workers`.
import { EducateOsError } from "@educateos/contracts";
import { migrateLegacyTables } from "@educateos/contracts/legacy-tables";
import { activityExportDigest, type ActivityExportSource, type ParsedActivityExport, type PublishedActivityExport, readActivityExport } from "./activity-export.ts";
import { type OcsFiles, type OcsPackage, packageDigest, readPackage } from "./package.ts";
import type { PackageSource, PublishedPackage } from "./resolver.ts";
import type { OcsPackageId } from "./schema.ts";

/**
 * Decides whether a package may enter the library, and whether it entered signed; throws to
 * refuse it. `publisherPolicy` (in the package's main entry) checks publisher signatures against
 * the district's approved keys. It is injected, rather than imported here, so this entry point
 * stays free of the signing code's dependencies.
 */
export type PublicationPolicy = (pkg: OcsPackage, signature: unknown) => Promise<{ signed: boolean }>;

/**
 * {@link PublicationPolicy} for activity exports (OCS 1.1): `publisherExportPolicy` checks them
 * against the same approved publisher keys, in the export signing context.
 */
export type ExportPublicationPolicy = (exported: ParsedActivityExport, signature: unknown) => Promise<{ signed: boolean }>;

/** A value SQLite stores in one column. */
export type LibrarySqlValue = string | number | null;

/**
 * The part of a SQLite-backed Durable Object's `ctx.storage` the library uses. `DurableObjectStorage`
 * satisfies it as it is.
 */
export interface LibrarySqlStorage {
  /** The SQL API. */
  readonly sql: {
    /** Runs one statement, returning a cursor over its rows. */
    exec(query: string, ...bindings: LibrarySqlValue[]): { toArray(): Record<string, unknown>[] };
  };
  /** Runs `closure` in one transaction, rolled back if it throws. */
  transactionSync<T>(closure: () => T): T;
}

/** The largest package the library stores, as JSON: under one SQLite value's 2 MB. */
export const MAX_LIBRARY_PACKAGE_BYTES = 1_900_000;

/** The table published versions are kept in. Exported so tests and migrations can name it. */
export const OCS_LIBRARY_TABLE = "educateos_ocs_library";

/** The table published activity exports (OCS 1.1) are kept in, under the same rules. */
export const OCS_EXPORT_TABLE = "educateos_ocs_activity_exports";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ${OCS_LIBRARY_TABLE} (
    package_id TEXT NOT NULL,
    version TEXT NOT NULL,
    digest TEXT NOT NULL,
    files_json TEXT NOT NULL,
    signature_json TEXT,
    published_at TEXT NOT NULL,
    PRIMARY KEY (package_id, version)
  )`,
  // A published version never changes and is never withdrawn: courses lock to it by digest.
  `CREATE TRIGGER IF NOT EXISTS ${OCS_LIBRARY_TABLE}_no_update BEFORE UPDATE ON ${OCS_LIBRARY_TABLE}
    BEGIN SELECT RAISE(ABORT, 'published course packages are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${OCS_LIBRARY_TABLE}_no_delete BEFORE DELETE ON ${OCS_LIBRARY_TABLE}
    BEGIN SELECT RAISE(ABORT, 'published course packages are immutable'); END`,
  `CREATE TABLE IF NOT EXISTS ${OCS_EXPORT_TABLE} (
    export_id TEXT NOT NULL,
    version TEXT NOT NULL,
    digest TEXT NOT NULL,
    export_json TEXT NOT NULL,
    signature_json TEXT,
    published_at TEXT NOT NULL,
    PRIMARY KEY (export_id, version)
  )`,
  `CREATE TRIGGER IF NOT EXISTS ${OCS_EXPORT_TABLE}_no_update BEFORE UPDATE ON ${OCS_EXPORT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'published activity exports are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${OCS_EXPORT_TABLE}_no_delete BEFORE DELETE ON ${OCS_EXPORT_TABLE}
    BEGIN SELECT RAISE(ABORT, 'published activity exports are immutable'); END`,
];

/** One version as the library holds it: its files, digest, and the publisher signature it was accepted with. */
export interface LibraryEntry extends PublishedPackage {
  /** The signature envelope, as it was accepted, or undefined for a package published unsigned. */
  signature: unknown;
}

/** One export version as the library holds it, with the signature it was accepted with. */
export interface LibraryExportEntry extends PublishedActivityExport {
  /** The signature envelope, as it was accepted, or undefined for an export published unsigned. */
  signature: unknown;
}

/**
 * A district's immutable course library in a SQLite-backed Durable Object: a {@link PackageSource}
 * the resolver reads, and the one place packages are published to.
 *
 * Publishing reads and checks the package, then puts it to the district's {@link PublicationPolicy}:
 * with `publisherPolicy`, the district's own domains publish unsigned and every other publisher must
 * sign with a key the district approved for that domain. A version, once published,
 * is fixed. Publishing it again succeeds only with identical content, and the table refuses any
 * update or delete. The recorded digest is returned with the files, so a row altered beneath the
 * library fails the resolver's own digest check rather than being trusted.
 *
 * A version's files are kept in one SQLite value, which holds at most 2 MB; a larger package is
 * refused. Course packages are JSON references, far below that.
 */
export class DurableObjectPackageLibrary implements PackageSource, ActivityExportSource {
  readonly #storage: LibrarySqlStorage;
  readonly #policy: PublicationPolicy;
  readonly #exportPolicy: ExportPublicationPolicy | undefined;
  readonly #now: () => Date;
  #ready = false;

  /**
   * `exportPolicy` admits activity exports (OCS 1.1), normally `publisherExportPolicy` over the
   * same trust as `policy`. Without one, the library refuses every export.
   */
  constructor(storage: LibrarySqlStorage, options: { policy: PublicationPolicy; exportPolicy?: ExportPublicationPolicy; now?: () => Date }) {
    this.#storage = storage;
    this.#policy = options.policy;
    this.#exportPolicy = options.exportPolicy;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Publishes a package version.
   *
   * @throws OcsError `invalid-package` for invalid files; whatever the policy throws (with
   *   `publisherPolicy`, EducateOsError `unauthenticated` for a missing or unaccepted signature); and
   *   EducateOsError `conflict` if the version was already published with different content.
   */
  async publish(files: OcsFiles, signature?: unknown): Promise<PublishedPackage> {
    const pkg = await readPackage(files);
    const { signed } = await this.#policy(pkg, signature);
    const filesJson = JSON.stringify(files);
    if (new TextEncoder().encode(filesJson).byteLength > MAX_LIBRARY_PACKAGE_BYTES) {
      throw new EducateOsError("policy-violation", `the package is larger than the library's ${MAX_LIBRARY_PACKAGE_BYTES} bytes`);
    }
    this.#ensureSchema();
    return this.#storage.transactionSync(() => {
      const existing = this.#storage.sql.exec(`SELECT digest FROM ${OCS_LIBRARY_TABLE} WHERE package_id = ? AND version = ?`, pkg.manifest.id, pkg.manifest.version).toArray()[0];
      if (existing !== undefined) {
        if (existing.digest === pkg.digest) return { files: { ...files }, digest: pkg.digest };
        throw new EducateOsError("conflict", `${pkg.manifest.id} ${pkg.manifest.version} is already published with different content; publish a new version instead`);
      }
      this.#storage.sql.exec(
        `INSERT INTO ${OCS_LIBRARY_TABLE} (package_id, version, digest, files_json, signature_json, published_at) VALUES (?, ?, ?, ?, ?, ?)`,
        pkg.manifest.id,
        pkg.manifest.version,
        pkg.digest,
        filesJson,
        signed ? JSON.stringify(signature) : null,
        this.#now().toISOString(),
      );
      return { files: { ...files }, digest: pkg.digest };
    });
  }

  async listVersions(id: OcsPackageId): Promise<readonly string[]> {
    this.#ensureSchema();
    return this.#storage.sql.exec(`SELECT version FROM ${OCS_LIBRARY_TABLE} WHERE package_id = ?`, id).toArray().map((row) => String(row.version));
  }

  async getPackage(id: OcsPackageId, version: string): Promise<PublishedPackage | undefined> {
    const entry = await this.getEntry(id, version);
    return entry === undefined ? undefined : { files: entry.files, digest: entry.digest };
  }

  /**
   * A version with the signature it was accepted with. The digest returned is the one recorded at
   * publication; the resolver checks the files against it.
   */
  async getEntry(id: OcsPackageId, version: string): Promise<LibraryEntry | undefined> {
    this.#ensureSchema();
    const row = this.#storage.sql.exec(`SELECT digest, files_json, signature_json FROM ${OCS_LIBRARY_TABLE} WHERE package_id = ? AND version = ?`, id, version).toArray()[0];
    if (row === undefined) return undefined;
    let files: OcsFiles;
    let signature: unknown;
    try {
      files = JSON.parse(String(row.files_json)) as OcsFiles;
      signature = row.signature_json === null ? undefined : JSON.parse(String(row.signature_json));
    } catch {
      throw new EducateOsError("unavailable", `the library's copy of ${id} ${version} is unreadable`);
    }
    return { files, digest: String(row.digest), signature };
  }

  /** Whether a stored version's files still have the digest it was published with. */
  async verifyEntry(id: OcsPackageId, version: string): Promise<boolean> {
    const entry = await this.getEntry(id, version);
    if (entry === undefined) return false;
    try {
      return (await packageDigest(entry.files)) === entry.digest;
    } catch {
      return false;
    }
  }

  /**
   * Publishes an activity export version (OCS 1.1) under the package rules: read and checked, put
   * to the export policy, and immutable once stored.
   *
   * @throws OcsError `invalid-export` for an invalid file; EducateOsError `policy-violation` if the
   *   library has no export policy; whatever the policy throws; and EducateOsError `conflict` if the
   *   version was already published with different content.
   */
  async publishExport(text: string, signature?: unknown): Promise<PublishedActivityExport> {
    const parsed = await readActivityExport(text);
    if (this.#exportPolicy === undefined) throw new EducateOsError("policy-violation", "this course library does not accept shared activities");
    const { signed } = await this.#exportPolicy(parsed, signature);
    if (new TextEncoder().encode(text).byteLength > MAX_LIBRARY_PACKAGE_BYTES) {
      throw new EducateOsError("policy-violation", `the activity is larger than the library's ${MAX_LIBRARY_PACKAGE_BYTES} bytes`);
    }
    const { id, version } = parsed.export;
    this.#ensureSchema();
    return this.#storage.transactionSync(() => {
      const existing = this.#storage.sql.exec(`SELECT digest FROM ${OCS_EXPORT_TABLE} WHERE export_id = ? AND version = ?`, id, version).toArray()[0];
      if (existing !== undefined) {
        if (existing.digest === parsed.digest) return { text, digest: parsed.digest };
        throw new EducateOsError("conflict", `${id} ${version} is already published with different content; publish a new version instead`);
      }
      this.#storage.sql.exec(
        `INSERT INTO ${OCS_EXPORT_TABLE} (export_id, version, digest, export_json, signature_json, published_at) VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        version,
        parsed.digest,
        text,
        signed ? JSON.stringify(signature) : null,
        this.#now().toISOString(),
      );
      return { text, digest: parsed.digest };
    });
  }

  async listExportVersions(id: string): Promise<readonly string[]> {
    this.#ensureSchema();
    return this.#storage.sql.exec(`SELECT version FROM ${OCS_EXPORT_TABLE} WHERE export_id = ?`, id).toArray().map((row) => String(row.version));
  }

  async getExport(id: string, version: string): Promise<PublishedActivityExport | undefined> {
    const entry = await this.getExportEntry(id, version);
    return entry === undefined ? undefined : { text: entry.text, digest: entry.digest };
  }

  /** An export version with the signature it was accepted with. The digest is the one recorded at publication. */
  async getExportEntry(id: string, version: string): Promise<LibraryExportEntry | undefined> {
    this.#ensureSchema();
    const row = this.#storage.sql.exec(`SELECT digest, export_json, signature_json FROM ${OCS_EXPORT_TABLE} WHERE export_id = ? AND version = ?`, id, version).toArray()[0];
    if (row === undefined) return undefined;
    let signature: unknown;
    try {
      signature = row.signature_json === null ? undefined : JSON.parse(String(row.signature_json));
    } catch {
      throw new EducateOsError("unavailable", `the library's copy of ${id} ${version} is unreadable`);
    }
    return { text: String(row.export_json), digest: String(row.digest), signature };
  }

  /** Whether a stored export's text still has the digest it was published with. */
  async verifyExportEntry(id: string, version: string): Promise<boolean> {
    const entry = await this.getExportEntry(id, version);
    if (entry === undefined) return false;
    try {
      return (await activityExportDigest(entry.text)) === entry.digest;
    } catch {
      return false;
    }
  }

  #ensureSchema(): void {
    if (this.#ready) return;
    this.#storage.transactionSync(() => {
      for (const statement of SCHEMA) this.#storage.sql.exec(statement);
      // Publications from before the rename (SCHO-232); one published since under the same version wins.
      migrateLegacyTables(this.#storage.sql, [{ table: OCS_LIBRARY_TABLE, merge: { kind: "keyed" } }]);
    });
    this.#ready = true;
  }
}
