#!/usr/bin/env node

// Mirrors a built release directory (see build-release.ts) to R2 via the S3 API.
//
// Blobs are content-addressed, so unchanged files dedupe across releases: each key is HEAD'd
// first and skipped if present. The manifest is uploaded LAST — its presence under
// releases/<id>/manifest.json is what marks a release complete, so a crashed upload never
// leaves a manifest pointing at missing blobs.
//
// With --candidate the manifest lands under candidates/<id>/manifest.json instead — invisible
// to the deploy service (which scans only releases/) until promote-release.ts copies it over
// after the e2e gate passes. Blob handling is identical either way.
//
// A manifest.signed.json beside the manifest (build-release.ts signed it) is uploaded to the same
// prefix just before the manifest, so the manifest never appears without its statement.
//
// Env: R2_ENDPOINT (https://<account>.r2.cloudflarestorage.com), R2_BUCKET,
//      R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
// Usage: node scripts/release/upload-release.ts --release <dir> [--candidate]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { AwsClient } from "aws4fetch";
import { assetR2Key, moduleR2Key, type ReleaseManifest } from "./manifest-lib.ts";
import { SIGNED_MANIFEST_FILE } from "./release-signing.ts";

const UPLOAD_CONCURRENCY = 8;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

function parseArgs(argv: string[]): { release: string; candidate: boolean } {
  let release: string | undefined;
  let candidate = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--release") release = resolve(argv[++i]);
    else if (argv[i] === "--candidate") candidate = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!release) throw new Error("--release <dir> is required");
  return { release, candidate };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = requireEnv("R2_ENDPOINT").replace(/\/$/, "");
  const bucket = requireEnv("R2_BUCKET");
  const client = new AwsClient({
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto",
  });
  const keyUrl = (key: string) => `${endpoint}/${bucket}/${key}`;

  const manifest = JSON.parse(
      readFileSync(join(args.release, "manifest.json"), "utf8")) as ReleaseManifest;

  const blobs = [
    ...readdirSync(join(args.release, "modules")).map((sha256) => ({
      key: moduleR2Key(sha256),
      path: join(args.release, "modules", sha256),
    })),
    ...readdirSync(join(args.release, "assets")).map((hash) => ({
      key: assetR2Key(hash),
      path: join(args.release, "assets", hash),
    })),
  ];

  let uploaded = 0;
  let skipped = 0;
  const queue = [...blobs];
  async function worker() {
    for (;;) {
      const blob = queue.shift();
      if (!blob) return;
      const head = await client.fetch(keyUrl(blob.key), { method: "HEAD" });
      if (head.status === 200) {
        skipped++;
        continue;
      }
      if (head.status !== 404) {
        throw new Error(`HEAD ${blob.key}: unexpected status ${head.status}`);
      }
      const put = await client.fetch(keyUrl(blob.key), {
        method: "PUT",
        body: readFileSync(blob.path),
      });
      if (!put.ok) {
        throw new Error(`PUT ${blob.key}: ${put.status} ${await put.text()}`);
      }
      uploaded++;
    }
  }
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  console.log(`blobs: ${uploaded} uploaded, ${skipped} already present`);

  const prefix = `${args.candidate ? "candidates" : "releases"}/${manifest.releaseId}`;
  const signedPath = join(args.release, SIGNED_MANIFEST_FILE);
  if (existsSync(signedPath)) {
    const signedKey = `${prefix}/${SIGNED_MANIFEST_FILE}`;
    const putSigned = await client.fetch(keyUrl(signedKey), {
      method: "PUT",
      body: readFileSync(signedPath),
      headers: { "Content-Type": "application/json" },
    });
    if (!putSigned.ok) {
      throw new Error(`PUT ${signedKey}: ${putSigned.status} ${await putSigned.text()}`);
    }
  }

  const manifestKey = `${prefix}/manifest.json`;
  const put = await client.fetch(keyUrl(manifestKey), {
    method: "PUT",
    body: readFileSync(join(args.release, "manifest.json")),
    headers: { "Content-Type": "application/json" },
  });
  if (!put.ok) {
    throw new Error(`PUT ${manifestKey}: ${put.status} ${await put.text()}`);
  }
  console.log(args.candidate
    ? `candidate uploaded (not yet visible to the deploy service): ${manifestKey}`
    : `release complete: ${manifestKey}`);
}

await main();
