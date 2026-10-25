// Node-only: kept out of the package index so a Worker can use the library without node:fs.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EducateOsError } from "@educateos/contracts";
import type { ReleaseArtifacts } from "./artifacts.ts";

/**
 * {@link ReleaseArtifacts} read from a `build-release.ts` output directory (or its R2 mirror
 * downloaded to disk): `modules/<sha256>` and `assets/<hash>`.
 */
export class DirectoryReleaseArtifacts implements ReleaseArtifacts {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async blob(sha256: string) {
    return await this.#read("modules", sha256, /^[0-9a-f]{64}$/);
  }

  async asset(hash: string) {
    return await this.#read("assets", hash, /^[0-9a-f]{32}$/);
  }

  async #read(subdir: string, name: string, pattern: RegExp): Promise<Uint8Array<ArrayBuffer>> {
    // The name comes from the manifest; the pattern keeps it a plain file name.
    if (!pattern.test(name)) throw new EducateOsError("validation-failed", "malformed release blob name");
    try {
      const buffer = await readFile(join(this.#dir, subdir, name));
      return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    } catch {
      throw new EducateOsError("not-found", `release blob ${subdir}/${name} is missing`);
    }
  }
}
