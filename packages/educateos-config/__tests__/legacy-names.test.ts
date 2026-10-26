// SCHO-232: configuration documents and revisions written before the EducateOS rename carry the
// `schoolos.dev/v1alpha1` apiVersion, the `schoolos-lti` pack ID and the `schoolos-catalog` (rename-educateos: keep)
// imported source. They are read as the current names, stored revisions still verify as stored,
// and anything compiled or rolled back from them is written with the current names.
import { ConfigurationRevision, PrincipalId } from "@educateos/contracts";
import { describe, expect, it } from "vitest";
import {
  CONFIG_API_VERSION,
  DesiredState,
  LEGACY_CONFIG_API_VERSION,
  SHIPPED_REGISTRY,
  canonicalJson,
  createDraftRevision,
  createRollbackRevision,
  revisionContentHash,
  revisionLineage,
} from "../src/index.ts";
import { northfieldDocument } from "./support.ts";

const ADMIN = PrincipalId.parse("prn_nf-district-admin");
const LTI = { state: "enabled", config: { platforms: [{ issuer: "https://lms.northfield.example", clientId: "nf-lms", deploymentId: "1" }] } };

function currentDocument(): Record<string, any> {
  const document = northfieldDocument();
  document.modules["educateos-lti"] = LTI;
  document.curriculum.importedSources = ["district-approved", "educateos-catalog"];
  return document;
}

function legacyDocument(): Record<string, any> {
  const document = northfieldDocument();
  document.apiVersion = LEGACY_CONFIG_API_VERSION;
  document.modules["schoolos-lti"] = LTI; // rename-educateos: keep
  document.curriculum.importedSources = ["district-approved", "schoolos-catalog"]; // rename-educateos: keep
  return document;
}

async function draft(document: unknown, previous?: ConfigurationRevision) {
  const result = await createDraftRevision({ document, registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN, ...(previous ? { previous } : {}) });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result;
}

/** `desired` with the names of before the rename, as the old code compiled and stored it. */
function asLegacy(desired: Record<string, any>): Record<string, any> {
  const { "educateos-lti": lti, ...modules } = desired.modules;
  return {
    ...desired,
    apiVersion: LEGACY_CONFIG_API_VERSION,
    modules: { ...modules, "schoolos-lti": lti }, // rename-educateos: keep
    curriculum: { ...desired.curriculum, importedSources: desired.curriculum.importedSources.map((s: string) => s.replace("educateos-", "schoolos-")) }, // rename-educateos: keep
  };
}

/** A first revision exactly as the code before the rename would have stored it. */
async function legacyRevision(desired: Record<string, unknown>): Promise<ConfigurationRevision> {
  const revision = { scope: { districtId: "dst_northfield" }, schemaVersion: LEGACY_CONFIG_API_VERSION, desired, status: "applied", actorPrincipalId: ADMIN };
  const hash = await revisionContentHash(ConfigurationRevision.parse({ ...revision, id: `cfg_${"0".repeat(32)}` }));
  const bytes = new TextEncoder().encode(canonicalJson({ contentHash: hash, previousRevisionId: null }));
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return ConfigurationRevision.parse({ ...revision, id: `cfg_${digest.slice(0, 32)}` });
}

describe("configuration from before the EducateOS rename", () => {
  it("compiles a legacy document to exactly what the current one compiles to", async () => {
    const current = await draft(currentDocument());
    const legacy = await draft(legacyDocument());
    expect(legacy.contentHash).toBe(current.contentHash);
    expect(legacy.revision.desired).toEqual(current.revision.desired);
    expect(legacy.revision.desired.apiVersion).toBe(CONFIG_API_VERSION);
    expect(Object.keys(legacy.revision.desired.modules as object)).toContain("educateos-lti");
  });

  it("reads a stored legacy desired state, verifies its lineage as stored, and rolls back to current names", async () => {
    const compiled = (await draft(currentDocument())).revision.desired as Record<string, any>;
    const stored = asLegacy(compiled);
    expect(DesiredState.parse(stored)).toEqual(DesiredState.parse(compiled));

    const first = await legacyRevision(stored);
    const changed = currentDocument();
    changed.modules["assessment-ci"] = "enabled";
    const second = (await draft(changed, first)).revision;
    expect(await revisionLineage(second, [first, second])).toEqual([second, first]);

    const rollback = await createRollbackRevision({ target: first, head: second, history: [first, second], actorPrincipalId: ADMIN });
    expect(rollback.revision.desired).toEqual(compiled);
    expect(rollback.revision.schemaVersion).toBe(CONFIG_API_VERSION);
    // The stored revision itself is unchanged.
    expect(first.desired).toEqual(stored);
  });

  it("refuses an apiVersion that was never either", () => {
    const compiled = { ...northfieldDocument(), apiVersion: "other.dev/v1alpha1" };
    expect(DesiredState.safeParse(compiled).success).toBe(false);
  });
});
