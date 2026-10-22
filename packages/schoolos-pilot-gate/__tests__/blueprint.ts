// A native Workshop Blueprint submitted to a district app's own Content Studio. The district app has
// no Blueprint import route yet, so the studio is built here over the app's Content Studio storage
// and policy engine: the release lands in the same review queue a URL import does.
import { blueprintTreeId, catalogAlignmentSource, ContentStudio, snapshotReleaseCommit, type BlueprintReleaseInput } from "@schoolos/content-studio";
import type { Authorizer } from "@schoolos/contracts";
import { callerOf, offeringScope, type PilotDistrict } from "./support.ts";

/**
 * A synthetic bundled blueprint, laid out as `packages/bundled-blueprints/blueprints/<name>/` is:
 * its presentation from `blueprint.json`, and its built files.
 */
export const SYNTHETIC_BLUEPRINT = {
  name: "osmosis-explorer",
  manifest: { title: "Osmosis Explorer (synthetic)", description: "Drag water molecules across a membrane.", version: 3 },
  files: {
    "README.md": "# Osmosis Explorer (synthetic)\n\nA gadget for exploring osmosis.\n",
    "client.js": "export function render(root) { root.textContent = 'osmosis-explorer-client'; }\n",
    "server.js": "export default { fetch() { return new Response('osmosis-explorer-server'); } };\n",
  },
} as const;

/** The snapshot release a deployment installs the synthetic blueprint as, named by its commit. */
export async function syntheticBlueprintRelease(): Promise<BlueprintReleaseInput> {
  const files = { ...SYNTHETIC_BLUEPRINT.files };
  const tree = await blueprintTreeId(new Map(Object.entries(files)));
  const commit = new TextEncoder().encode(snapshotReleaseCommit(tree));
  const header = new TextEncoder().encode(`commit ${commit.byteLength}\0`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array([...header, ...commit])));
  return {
    name: SYNTHETIC_BLUEPRINT.name,
    fileName: SYNTHETIC_BLUEPRINT.name,
    title: SYNTHETIC_BLUEPRINT.manifest.title,
    description: SYNTHETIC_BLUEPRINT.manifest.description,
    version: SYNTHETIC_BLUEPRINT.manifest.version,
    commitId: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""),
    files,
  };
}

/** Submits the synthetic blueprint's release for review in one of a teacher's classes. */
export async function submitSyntheticBlueprint(district: PilotDistrict, teacherId: string, offeringId: string) {
  const { app, stores } = district;
  const authorizer: Authorizer = { authorize: async (request) => (await app.engine.decide(request)).decision };
  const studio = new ContentStudio({
    districtId: app.districtId,
    storage: stores.contentStudio,
    authorizer,
    channel: "http",
    fetch: district.web.fetch,
    scanner: undefined,
    alignments: catalogAlignmentSource(app.catalog),
  });
  const release = await syntheticBlueprintRelease();
  const item = await studio.submitBlueprint(callerOf(district, teacherId).principal, { release, targetScope: offeringScope(offeringId) });
  return { item, release };
}
