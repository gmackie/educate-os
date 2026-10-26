// A district backup through its stores' own interfaces: `snapshot` reads back everything the stores
// let a backup read, and `restore` writes it into fresh stores through their ordinary write calls.
// The H01 rehearsal (restore.test.ts) and every demo district's export-and-restore scenario
// (district-scenarios.ts) use it. Three stores offer no way to write back what they hold (see
// restore.test.ts); callers re-create or omit those.
import { expect } from "vitest";
import type { DistrictDirectorySnapshot } from "@educateos/contracts";
import { InMemoryAcademicStore } from "@educateos/academics";
import type { LedgerEntry } from "@educateos/ai-governance";
import { inMemoryDistrictStores, InMemoryPolicyAuditLog, type DistrictAppStores } from "@educateos/district-app";

type Loaded<T extends { load(): Promise<unknown> }> = Awaited<ReturnType<T["load"]>>;

/** Everything a district holds that its stores let a backup read back. */
export interface DistrictSnapshot {
  directory: DistrictDirectorySnapshot;
  rosterSources: Awaited<ReturnType<DistrictAppStores["rosterSources"]["load"]>>;
  workspaces: Loaded<DistrictAppStores["workspaces"]>["state"];
  artifactRecords: Loaded<DistrictAppStores["artifactRecords"]>["state"];
  /** Every held revision's bytes, by digest. */
  artifactContent: Map<string, { backend: "text" | "r2"; bytes: Uint8Array<ArrayBuffer> }>;
  assessment: Loaded<DistrictAppStores["assessment"]>["state"];
  rubrics: NonNullable<Awaited<ReturnType<DistrictAppStores["rubrics"]["get"]>>>[];
  releases: Awaited<ReturnType<DistrictAppStores["contentStudio"]["listReleases"]>>;
  bindings: Awaited<ReturnType<DistrictAppStores["contentStudio"]["listBindings"]>>;
  definitions: Awaited<ReturnType<DistrictAppStores["curriculum"]["listVersions"]>>;
  installations: NonNullable<Awaited<ReturnType<DistrictAppStores["curriculum"]["getInstallation"]>>>[];
  ledger: LedgerEntry[];
  config: Awaited<ReturnType<DistrictAppStores["config"]["list"]>>;
  audit: ReturnType<InMemoryPolicyAuditLog["events"]>;
}

/** Reads a district's state back out of its stores. */
export async function snapshot(stores: DistrictAppStores): Promise<DistrictSnapshot> {
  const artifactRecords = (await stores.artifactRecords.load()).state;
  const artifactContent = new Map<string, { backend: "text" | "r2"; bytes: Uint8Array<ArrayBuffer> }>();
  for (const revision of artifactRecords.revisions) {
    // External and registered content is held outside these stores, by its link or its provider.
    if (revision.content.backend === "external" || revision.content.backend === "registered") continue;
    artifactContent.set(revision.content.digest, { backend: revision.content.backend, bytes: await stores.artifactContent.read(revision.content) });
  }
  const assessment = (await stores.assessment.load()).state;
  const rubrics = [];
  for (const assignment of assessment.assignments) {
    if (assignment.rubric === undefined) continue;
    const release = await stores.rubrics.get(assignment.rubric);
    if (release !== undefined) rubrics.push(release);
  }
  const installations = [];
  for (const assignment of assessment.assignments) {
    const installation = await stores.curriculum.getInstallation(assignment.activityId);
    if (installation !== undefined) installations.push(installation);
  }
  const definitions = [];
  for (const id of new Set(installations.map((i) => i.definitionId))) definitions.push(...await stores.curriculum.listVersions(id));
  if (!(stores.audit instanceof InMemoryPolicyAuditLog)) throw new Error("the rehearsal reads the in-memory audit log");
  return {
    directory: (await stores.directory.load()).snapshot,
    rosterSources: await stores.rosterSources.load(),
    workspaces: (await stores.workspaces.load()).state,
    artifactRecords,
    artifactContent,
    assessment,
    rubrics,
    releases: await stores.contentStudio.listReleases(),
    bindings: await stores.contentStudio.listBindings(),
    definitions,
    installations,
    ledger: [...(await stores.ledger.read()).entries],
    config: await stores.config.list(),
    audit: stores.audit.events(),
  };
}

/** Writes a snapshot into fresh stores, through their ordinary write interfaces. */
export async function restore(backup: DistrictSnapshot): Promise<DistrictAppStores> {
  const audit = new InMemoryPolicyAuditLog();
  const stores: DistrictAppStores = { ...inMemoryDistrictStores(backup.directory), directory: InMemoryAcademicStore.seeded(backup.directory), audit };
  await stores.rosterSources.save(backup.rosterSources);
  await stores.workspaces.commit(backup.workspaces, 0);
  for (const [digest, { backend, bytes }] of backup.artifactContent) {
    const ref = await stores.artifactContent.write(backend, bytes, digest as never);
    expect(ref.digest).toBe(digest);
  }
  await stores.artifactRecords.commit(backup.artifactRecords, 0);
  for (const rubric of backup.rubrics) await stores.rubrics.put(rubric);
  await stores.assessment.commit(backup.assessment, 0);
  for (const release of backup.releases) await stores.contentStudio.addRelease(release);
  for (const binding of backup.bindings) await stores.contentStudio.addBinding(binding);
  for (const definition of backup.definitions) await stores.curriculum.putVersion(definition);
  for (const installation of backup.installations) await stores.curriculum.addInstallation(installation);
  await stores.ledger.transact(() => ({ append: backup.ledger, result: undefined }));
  let head: string | undefined;
  for (const revision of backup.config) {
    await stores.config.append(revision, head as never);
    head = revision.id;
  }
  for (const event of backup.audit) await audit.record(event);
  return stores;
}
