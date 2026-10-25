import { DistrictId, PrincipalId, Scope, EducateOsError } from "@educateos/contracts";
import { z } from "zod";
import { CartridgeMetadata, CartridgeProfile } from "./manifest.ts";
import { CartridgeLink, ExternalToolReference, OutlineNode, PackageDigest, SkippedReport } from "./plan.ts";

/**
 * Identifies one cartridge import. It follows the `<prefix>_<body>` convention of
 * `@educateos/contracts`, and may belong there once another package needs it.
 */
export const CartridgeImportId = z
  .string()
  .regex(/^cci_[a-z0-9][a-z0-9-]{0,62}$/, "expected a cartridge import ID (cci_…)")
  .brand<"cartridgeImport">();
/** A cartridge import identifier. */
export type CartridgeImportId = z.infer<typeof CartridgeImportId>;

/**
 * One imported package, as stored: what it holds and where each part came from, but none of its
 * file content. Only the links' review status changes after import.
 */
export const CartridgeImport = z.strictObject({
  id: CartridgeImportId,
  districtId: DistrictId,
  /** Incremented on every write; storage refuses a write based on a stale read. */
  revision: z.number().int().positive(),
  targetScope: Scope,
  fileName: z.string().min(1).max(255),
  importedBy: PrincipalId,
  importedAt: z.iso.datetime({ offset: true }),
  packageDigest: PackageDigest,
  profile: CartridgeProfile,
  schemaVersion: z.string().max(20),
  manifestIdentifier: z.string().max(200),
  metadata: CartridgeMetadata,
  links: z.array(CartridgeLink),
  tools: z.array(ExternalToolReference),
  outline: z.array(OutlineNode),
  skipped: SkippedReport,
  ignoredEntries: z.array(z.strictObject({ path: z.string().max(1024), reason: z.string().max(100) })),
});
/** A stored cartridge import. */
export type CartridgeImport = z.infer<typeof CartridgeImport>;

/** Where a district keeps its cartridge imports: district-local D1 or a Durable Object in production. */
export interface CartridgeImportStorage {
  getImport(id: CartridgeImportId): Promise<CartridgeImport | undefined>;
  listImports(): Promise<CartridgeImport[]>;
  /**
   * Stores `record` if the stored revision is `record.revision - 1` (absent when it is 1).
   *
   * @throws EducateOsError `conflict` otherwise.
   */
  putImport(record: CartridgeImport): Promise<void>;
}

/** {@link CartridgeImportStorage} in memory, for tests and development. Stores copies, never references. */
export class InMemoryCartridgeImportStorage implements CartridgeImportStorage {
  readonly #imports = new Map<string, CartridgeImport>();

  async getImport(id: CartridgeImportId): Promise<CartridgeImport | undefined> {
    const record = this.#imports.get(id);
    return record === undefined ? undefined : structuredClone(record);
  }

  async listImports(): Promise<CartridgeImport[]> {
    return [...this.#imports.values()].map((record) => structuredClone(record));
  }

  async putImport(record: CartridgeImport): Promise<void> {
    if ((this.#imports.get(record.id)?.revision ?? 0) !== record.revision - 1) {
      throw new EducateOsError("conflict", `${record.id} changed since it was read`);
    }
    this.#imports.set(record.id, structuredClone(record));
  }
}
