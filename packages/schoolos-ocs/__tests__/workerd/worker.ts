// Test worker for the workerd suite: a district's course library Durable Object over
// `DurableObjectPackageLibrary`, so publications arrive as separate requests and survive restarts.

import { DurableObject } from "cloudflare:workers";
import { SchoolOsError } from "@schoolos/contracts";
import { DurableObjectPackageLibrary, type PublicationPolicy } from "../../src/durable-object-library.ts";
import type { OcsFiles } from "../../src/package.ts";
import type { PublishedPackage } from "../../src/resolver.ts";
import type { OcsPackageId } from "../../src/schema.ts";

/** A call's outcome, with a refusal's code carried across RPC rather than its error. */
export type Result<T> = { ok: true; value: T } | { ok: false; code: string };

async function attempt<T>(run: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof SchoolOsError) return { ok: false, code: error.code };
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
  throw new SchoolOsError("unauthenticated", "the package's publisher signature was not accepted");
};

/** A district's course library. */
export class TestLibrary extends DurableObject {
  readonly #library = new DurableObjectPackageLibrary(this.ctx.storage, { policy: TEST_POLICY, now: () => new Date("2026-10-21T09:00:00Z") });

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
