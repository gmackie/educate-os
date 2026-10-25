// Test worker for the workerd suite: a Durable Object that hosts one district's catalog mirror over
// `DurableObjectCatalogMirrorStorage`, the way the district Worker will. Concurrent calls arrive as
// separate requests to one object.
//
// Its `verifyRelease` accepts every release. Signature verification (`catalogReleaseVerifier`) is
// covered in the Node suite: `@educateos/releases` and `@educateos/fleet` type-check against the
// web-standard surface, not the Workers typings this suite compiles under (ADR-0009).

import { DurableObject } from "cloudflare:workers";
import { EducateOsError } from "@educateos/contracts";
import { type Actor, CatalogMirror } from "../../src/mirror.ts";
import { DurableObjectCatalogMirrorStorage } from "../../src/durable-object-storage.ts";

/** An RPC-safe outcome: EducateOS error codes do not survive the RPC boundary as error properties. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; code: string };

async function outcome<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof EducateOsError) return { ok: false, code: error.code };
    throw error;
  }
}

/** One district's catalog mirror. */
export class TestMirror extends DurableObject {
  readonly #storage: DurableObjectCatalogMirrorStorage;
  readonly #mirror: CatalogMirror;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#storage = new DurableObjectCatalogMirrorStorage(ctx.storage);
    this.#mirror = new CatalogMirror({ storage: this.#storage, verifyRelease: async () => true });
  }

  /** Selects a framework, returning the state's revision. */
  async select(key: string, actor: Actor): Promise<Outcome<number>> {
    return outcome(async () => (await this.#mirror.select(key, actor)).revision);
  }

  async install(release: unknown, actor: Actor): Promise<Outcome<string>> {
    return outcome(async () => (await this.#mirror.install(release, actor)).release.status);
  }

  async approve(key: string, version: string, actor: Actor): Promise<Outcome<number>> {
    return outcome(async () => (await this.#mirror.approve(key, version, actor)).added.length);
  }

  /** The framework's stored state as JSON, so the RPC stub's type stays shallow. */
  async state(key: string): Promise<string | undefined> {
    const state = await this.#mirror.get(key);
    return state === undefined ? undefined : JSON.stringify(state);
  }

  async approvedDigest(key: string): Promise<string | undefined> {
    return (await this.#mirror.approvedRelease(key))?.contentDigest;
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(null, { status: 404 });
  },
};
