// The test world: a signed release written to disk in build-release.ts's layout and served over
// HTTP as educateos.io's /releases/ mirror lays it out, and the installer's in-memory Cloudflare
// fake behind the launcher's loopback bridge.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { type FakeCloudflare, type ReleaseManifest, staticTokenProvider } from "@educateos/installer";
import { bridgeError } from "../src/cloudflare.ts";
import {
  accountFor,
  deriveRelease,
  goldenRelease,
  NORTHFIELD,
  ROOT_TRUST,
  signRelease,
  type TestRelease,
} from "../../educateos-installer/__tests__/support.ts";

export { accountFor, deriveRelease, goldenRelease, NORTHFIELD, ROOT_TRUST, signRelease, type TestRelease };

/** The same release, signed again as another version (support.ts's derived releases are all 0.2.0). */
export async function asVersion(release: TestRelease, version: string): Promise<TestRelease> {
  return { ...release, version, signedManifest: await signRelease(release.manifest.releaseId, version, release.sha256) };
}

/** The synthetic Northfield account's ID (support.ts's). */
export const ACCOUNT_ID = "a1".repeat(16);

/** Every blob a release's manifest names, by its release-directory path. */
async function blobsOf(release: TestRelease): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const manifest: ReleaseManifest = release.manifest;
  for (const worker of Object.values(manifest.workers)) {
    for (const module of worker.modules) files.set(`modules/${module.sha256}`, await release.artifacts.blob(module.sha256));
    for (const migration of worker.d1Migrations ?? []) files.set(`modules/${migration.sha256}`, await release.artifacts.blob(migration.sha256));
    for (const variant of Object.values(worker.assetsConfig?.variants ?? {})) {
      for (const entry of Object.values(variant.manifest)) {
        // Only the variants the fixture ships assets for; the installer reads only the one it serves.
        const bytes = await release.artifacts.asset(entry.hash).catch(() => undefined);
        if (bytes) files.set(`assets/${entry.hash}`, bytes);
      }
    }
  }
  return files;
}

/** Writes a release directory as build-release.ts lays one out. */
export async function writeReleaseDir(release: TestRelease, dir = mkdtempSync(join(tmpdir(), "launch-release-"))): Promise<string> {
  mkdirSync(join(dir, "modules"), { recursive: true });
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), release.bytes);
  writeFileSync(join(dir, "manifest.signed.json"), JSON.stringify(release.signedManifest));
  for (const [path, bytes] of await blobsOf(release)) writeFileSync(join(dir, path), bytes);
  return dir;
}

/** A trust file pinning the synthetic root's release key, for `--trust`. */
export function writeTrustFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "launch-trust-")), "trust.json");
  writeFileSync(path, JSON.stringify(ROOT_TRUST));
  return path;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The /releases/ mirror over a set of releases, with every file overridable for tamper tests. */
export interface ReleaseServer {
  /** The mirror's base URL, ending in `/releases/`. */
  base: string;
  /** Paths requested, in order. */
  requests: string[];
  /** Replaces what one path serves (relative to `/releases/`); null serves a 404. */
  override(path: string, bytes: Uint8Array | string | null): void;
  /** Points latest.json at another release. */
  setLatest(releaseId: string): void;
  close(): Promise<void>;
}

/** Serves releases as the site Worker's mirror does. The last one given is `latest`. */
export async function serveReleases(...releases: TestRelease[]): Promise<ReleaseServer> {
  const files = new Map<string, Uint8Array | string | null>();
  for (const release of releases) {
    const id = release.manifest.releaseId;
    files.set(`${id}/manifest.json`, release.bytes);
    files.set(`${id}/manifest.signed.json`, JSON.stringify(release.signedManifest));
    for (const [path, bytes] of await blobsOf(release)) files.set(`blobs/${path}`, bytes);
  }
  let latest = releases.at(-1)!.manifest.releaseId;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname.replace(/^\/releases\//, "");
    requests.push(path);
    const content = path === "latest.json" ? JSON.stringify({ releaseId: latest }) : files.get(path);
    if (content === undefined || content === null) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(content);
  });
  const origin = await listen(server);
  return {
    base: `${origin}/releases/`,
    requests,
    override: (path, bytes) => files.set(path, bytes),
    setLatest: (releaseId) => {
      latest = releaseId;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The fake Cloudflare behind the launcher's test bridge. */
export interface CloudflareBridge {
  url: string;
  fake: FakeCloudflare;
  /** A valid token for the fake account. */
  token: string;
  close(): Promise<void>;
}

/** Serves `fake` over the launcher's loopback bridge (LAUNCH_EDUCATE_OS_TEST_CLOUDFLARE_RPC). */
export async function serveCloudflare(fake: FakeCloudflare, options: { accountName?: string; zones?: string[] } = {}): Promise<CloudflareBridge> {
  const zones = options.zones ?? ["northfield.example"];
  const server = createServer(async (request, response) => {
    const { method, args } = deserialize(await body(request)) as { method: string; args: unknown[] };
    const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    const api = fake.api(staticTokenProvider("district-run", token)) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    let reply: unknown;
    try {
      let value: unknown;
      if (method === "listAccounts") {
        // Authenticated like any call: a refused token fails here as it would at Cloudflare.
        await api.getAccount!(ACCOUNT_ID);
        value = [{ id: ACCOUNT_ID, name: options.accountName ?? "Northfield Public Schools" }];
      } else if (method === "listZones") {
        const found = await Promise.all(zones.map((name) => api.findZone!(String(args[0]), name)));
        value = found.filter((zone) => zone !== undefined);
      } else {
        value = await api[method]!(...args);
      }
      reply = { ok: true, value };
    } catch (error) {
      reply = { ok: false, error: bridgeError(error) };
    }
    response.writeHead(200, { "content-type": "application/octet-stream" }).end(serialize(reply));
  });
  const url = await listen(server);
  return { url, fake, token: fake.issueToken(), close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** The answers a non-interactive Northfield install uses: support.ts's config, without its release. */
export function northfieldAnswers(overrides: Record<string, unknown> = {}) {
  return {
    format: "launch-educate-os/1",
    install: {
      instanceId: "ins_northfield",
      accountId: ACCOUNT_ID,
      baseDomain: "northfield.example",
      access: { teamName: "northfield", allowedEmailDomains: ["northfield.example"] },
      admins: ["it@northfield.example"],
      gatekeepers: ["gatekeeper-google"],
      aiGateway: true,
      ...overrides,
    },
    history: [],
  };
}

/** Synthetic Google OAuth app credentials, as the launcher reads them from the environment. */
export const GOOGLE_SECRETS = {
  EDUCATEOS_SECRET_GATEKEEPER_GOOGLE__CLIENT_ID: "synthetic-google-client-id-value",
  EDUCATEOS_SECRET_GATEKEEPER_GOOGLE__CLIENT_SECRET: "synthetic-google-client-secret-value",
};

/** A fresh, empty working directory. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "launch-cwd-"));
}

/** Writes an answers file into a fresh directory and returns both. */
export function writeAnswersFile(answers: unknown): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "launch-answers-"));
  const path = join(dir, "educateos-install.json");
  writeFileSync(path, JSON.stringify(answers));
  return { dir, path };
}
