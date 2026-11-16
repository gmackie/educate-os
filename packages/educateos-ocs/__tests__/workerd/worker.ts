// Test worker for the workerd suite: a district's course library Durable Object over
// `DurableObjectPackageLibrary`, so publications arrive as separate requests and survive restarts.

import { DurableObject } from "cloudflare:workers";
import { EducateOsError } from "@educateos/contracts";
import type { PublishedActivityExport } from "../../src/activity-export.ts";
import { DurableObjectPackageLibrary, type ExportPublicationPolicy, type PublicationPolicy } from "../../src/durable-object-library.ts";
import type { OcsFiles } from "../../src/package.ts";
import type { PublishedPackage } from "../../src/resolver.ts";
import type { OcsPackageId } from "../../src/schema.ts";

/** A call's outcome, with a refusal's code carried across RPC rather than its error. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: string };

async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof EducateOsError) return { ok: false, code: error.code };
    throw error;
  }
}

/**
 * A stand-in for `publisherPolicy`, whose signature checks are tested in Node: Northfield's own
 * packages publish unsigned, and any other needs a signature marked as accepted.
 */
export const TEST_POLICY: PublicationPolicy = async (pkg, signature) => {
  if (pkg.manifest.id.startsWith("northfield.example/")) return { signed: false };
  if ((signature as { accepted?: unknown } | undefined)?.accepted === true) return { signed: true };
  throw new EducateOsError("unauthenticated", "the package's publisher signature was not accepted");
};

/** {@link TEST_POLICY} for activity exports. */
export const TEST_EXPORT_POLICY: ExportPublicationPolicy = async (parsed, signature) => {
  if (parsed.export.id.startsWith("northfield.example/")) return { signed: false };
  if ((signature as { accepted?: unknown } | undefined)?.accepted === true) return { signed: true };
  throw new EducateOsError("unauthenticated", "the shared activity's publisher signature was not accepted");
};

/** A district's course library. */
export class TestLibrary extends DurableObject {
  readonly #library = new DurableObjectPackageLibrary(this.ctx.storage, { policy: TEST_POLICY, exportPolicy: TEST_EXPORT_POLICY, now: () => new Date("2026-10-21T09:00:00Z") });

  /** Publishes an activity export version. */
  async publishExport(text: string, signature?: unknown): Promise<Result<PublishedActivityExport>> {
    return attempt(() => this.#library.publishExport(text, signature));
  }

  /** One export version's digest and accepted signature, as JSON, and whether it still verifies. */
  async exportEntry(id: string, version: string): Promise<{ digest: string; signature: string | undefined; verified: boolean } | undefined> {
    const entry = await this.#library.getExportEntry(id, version);
    if (entry === undefined) return undefined;
    return { digest: entry.digest, signature: entry.signature === undefined ? undefined : JSON.stringify(entry.signature), verified: await this.#library.verifyExportEntry(id, version) };
  }

  /** Every published version of an export. */
  async exportVersions(id: string): Promise<readonly string[]> {
    return this.#library.listExportVersions(id);
  }

  /** Publishes a package version. */
  async publish(files: OcsFiles, signature?: unknown): Promise<Result<PublishedPackage>> {
    return attempt(() => this.#library.publish(files, signature));
  }

  /** Every published version of a package. */
  async versions(id: OcsPackageId): Promise<readonly string[]> {
    return this.#library.listVersions(id);
  }

  /** One version's digest and accepted signature, as JSON. */
  async entry(id: OcsPackageId, version: string): Promise<{ digest: string; signature: string | undefined } | undefined> {
    const entry = await this.#library.getEntry(id, version);
    return entry === undefined ? undefined : { digest: entry.digest, signature: entry.signature === undefined ? undefined : JSON.stringify(entry.signature) };
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
