// The public, read-only mirror of the signed releases (SCHO-341), for installers that run outside
// educateos.io, such as `npx launch-educate-os`. It serves the `educateos-releases` bucket exactly as
// `scripts/release/upload-release.ts` lays it out, under `/releases/`:
//
//   GET /releases/latest.json                       { "releaseId": "<id>" }, the newest published release
//   GET /releases/<id>/manifest.json                the release manifest
//   GET /releases/<id>/manifest.signed.json         the root's signed statement for it
//   GET /releases/blobs/modules/<sha256>            a worker module or D1 migration, content-addressed
//   GET /releases/blobs/assets/<hash>               a static asset, content-addressed
//
// Nothing here is trusted by its readers. The pointer only names an ID: an installer verifies the
// statement against the release keys it pins, the manifest bytes against the statement, and every
// blob against the manifest, so a tampered or substituted file fails there. Only `releases/` and
// `blobs/` are read, never `candidates/`: a candidate is unsigned until it passes the release gate.
import { latestRelease, type ReleaseBucket } from "./guided-install.ts";

/** The path prefix the release files are served under. */
export const RELEASE_FILES_PREFIX = "/releases/";

/** The R2 bucket as the mirror reads it. The Worker's `R2Bucket` binding satisfies it. */
export interface ReleaseFileBucket extends ReleaseBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; body: ReadableStream; size: number; httpEtag: string } | null>;
}

/** How long each kind of file may be cached, as a `Cache-Control` value. */
export const RELEASE_FILE_CACHING = {
  /** The pointer moves whenever a release is promoted. */
  latest: "public, max-age=60",
  /** A manifest never changes once published, but its statement can be re-signed to extend its expiry. */
  manifest: "public, max-age=300",
  /** A blob's name is its content's hash, so it can never change. */
  blob: "public, max-age=31536000, immutable",
} as const;

// Release IDs as `build-release.ts` names them in CI: `r<pipeline>-<sha>`, or a local `dev-…` build.
const RELEASE_ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
const MANIFEST_PATH = new RegExp(`^/releases/(${RELEASE_ID})/(manifest\\.json|manifest\\.signed\\.json)$`);
const MODULE_PATH = /^\/releases\/blobs\/modules\/([0-9a-f]{64})$/;
const ASSET_PATH = /^\/releases\/blobs\/assets\/([0-9a-f]{32})$/;

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

async function object(bucket: ReleaseFileBucket, key: string, contentType: string, caching: string, head: boolean): Promise<Response> {
  const found = await bucket.get(key);
  if (found === null) return notFound();
  const headers = {
    "content-type": contentType,
    "content-length": String(found.size),
    "cache-control": caching,
    "etag": found.httpEtag,
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": "*",
  };
  if (head) {
    await found.body.cancel();
    return new Response(null, { headers });
  }
  return new Response(found.body, { headers });
}

/**
 * Answers one request under {@link RELEASE_FILES_PREFIX}. Only GET and HEAD, only the five shapes
 * above, and every name is checked against its pattern before it becomes an R2 key.
 */
export async function serveReleaseFile(request: Request, bucket: ReleaseFileBucket | undefined): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "GET, HEAD", "cache-control": "no-store" },
    });
  }
  if (bucket === undefined) return notFound();
  const head = request.method === "HEAD";
  const { pathname } = new URL(request.url);

  if (pathname === "/releases/latest.json") {
    // The newest release whose manifest and statement are both present, as the guided install picks.
    const release = await latestRelease(bucket);
    if (release === undefined) return notFound();
    return new Response(head ? null : JSON.stringify({ releaseId: release.releaseId }), {
      headers: {
        "content-type": "application/json",
        "cache-control": RELEASE_FILE_CACHING.latest,
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": "*",
      },
    });
  }
  const manifest = MANIFEST_PATH.exec(pathname);
  if (manifest !== null) {
    return object(bucket, `releases/${manifest[1]}/${manifest[2]}`, "application/json", RELEASE_FILE_CACHING.manifest, head);
  }
  const module = MODULE_PATH.exec(pathname);
  if (module !== null) return object(bucket, `blobs/modules/${module[1]}`, "application/octet-stream", RELEASE_FILE_CACHING.blob, head);
  const asset = ASSET_PATH.exec(pathname);
  if (asset !== null) return object(bucket, `blobs/assets/${asset[1]}`, "application/octet-stream", RELEASE_FILE_CACHING.blob, head);
  return notFound();
}
