// An approval is a transaction (RFC 0002 §6, SCHO-175): it runs only the exact call a person
// reviewed, against the record and version it was queued for, and only while the source of record
// still accepts it. An operation whose approval policy is `approver` always waits for one.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ArtifactId, EducateOsError } from "@educateos/contracts";
import { InMemoryToolApprovalStore, SchoolToolRunner, defineSchoolTool, type SchoolToolOutcome } from "../src/index.ts";
import { courseResource, engineFor, P } from "./setup.ts";

const BIO = "off_nf-bio-fall-p2";

function runnerFor() {
  const { engine } = engineFor();
  const store = new InMemoryToolApprovalStore();
  const artifacts = new Map([["art_amara-lab", { offeringId: BIO, owner: "prn_nf-student-amara", text: "v1", revision: 1 }]]);
  const resources = new Map([["rsc_cells", { offeringId: BIO, title: "Cells" }]]);
  const ran: string[] = [];
  const roster = { ownsArtifacts: false, ownsResources: false };
  const artifactsOwned = () => new EducateOsError("conflict", "Artifacts are owned by external:oneroster; change them there and let its sync update EducateOS.");

  const editArtifact = defineSchoolTool({
    name: "edit_artifact",
    description: "Replace an artifact's text.",
    inputSchema: z.strictObject({ artifactId: ArtifactId, text: z.string().max(1000) }),
    action: "update",
    resource: async ({ artifactId }) => {
      const artifact = artifacts.get(artifactId);
      if (artifact === undefined) return undefined;
      return { ...courseResource(artifact.offeringId, "artifact", "course", { id: artifactId, owner: artifact.owner }), version: String(artifact.revision) };
    },
    recheck: async () => {
      if (roster.ownsArtifacts) throw artifactsOwned();
    },
    handler: async ({ artifactId, text }) => {
      // As a directory operation does, once the runner has authorized the caller for the record.
      if (roster.ownsArtifacts) throw artifactsOwned();
      ran.push(`edit ${artifactId}`);
      const artifact = artifacts.get(artifactId)!;
      artifacts.set(artifactId, { ...artifact, text, revision: artifact.revision + 1 });
      return { ok: true };
    },
  });
  const retitleResource = defineSchoolTool({
    name: "retitle_resource",
    description: "Retitle a learning resource.",
    inputSchema: z.strictObject({ resourceId: z.string().regex(/^rsc_[a-z-]+$/), title: z.string().max(100) }),
    action: "update",
    approval: "approver",
    recheck: async () => {
      if (roster.ownsResources) throw new EducateOsError("conflict", "Learning resources are owned by lms:canvas.");
    },
    resource: async ({ resourceId }) => {
      const resource = resources.get(resourceId);
      return resource && courseResource(resource.offeringId, "learning-resource", "teacher-only", { id: resourceId });
    },
    handler: async ({ resourceId, title }) => {
      ran.push(`retitle ${resourceId}`);
      resources.set(resourceId, { ...resources.get(resourceId)!, title });
      return { title };
    },
  });
  const runner = new SchoolToolRunner({ tools: [editArtifact, retitleResource], engine, approvals: { store } });
  return { runner, store, artifacts, ran, roster };
}

const agent = (principal: typeof P.amara) => ({ principal, channel: "agent" as const });
const person = (principal: typeof P.amara) => ({ principal, channel: "http" as const });

function approvalIdOf(outcome: SchoolToolOutcome): string {
  if (outcome.status !== "approval-required" || outcome.approvalId === undefined) throw new Error(`expected a queued action, got ${JSON.stringify(outcome)}`);
  return outcome.approvalId;
}

describe("an approval as a transaction", () => {
  it("pins the call's target and version, and runs only the digest the person reviewed", async () => {
    const { runner, store, ran } = runnerFor();
    const outcome = await runner.invoke(agent(P.amara), "edit_artifact", { artifactId: "art_amara-lab", text: "v2" }, { confirmWrites: true });
    const id = approvalIdOf(outcome);
    const queued = (await store.get(id as never))!;
    expect(queued.target).toMatchObject({ resource: { kind: "artifact", id: "art_amara-lab" }, version: "1" });
    expect(queued.digest).toMatch(/^[0-9a-f]{64}$/);
    // The outcome names the pin, for whoever decides it to review.
    expect(outcome).toMatchObject({ target: queued.target, digest: queued.digest });

    // An approval naming another digest runs nothing and leaves the request waiting.
    expect(await runner.approve(person(P.amara), id, { digest: "0".repeat(64) })).toMatchObject({ status: "error", error: { code: "conflict" } });
    expect((await store.get(id as never))!.state).toBe("pending");
    expect(ran).toEqual([]);
    expect(await runner.approve(person(P.amara), id, { digest: queued.digest! })).toMatchObject({ status: "applied" });
    expect(ran).toEqual(["edit art_amara-lab"]);
  });

  it("declines a call whose record changed after it was queued, so a stale review never applies", async () => {
    const { runner, store, artifacts, ran } = runnerFor();
    const id = approvalIdOf(await runner.invoke(agent(P.amara), "edit_artifact", { artifactId: "art_amara-lab", text: "v2" }, { confirmWrites: true }));
    // Someone edits the artifact directly in the meantime: its version moves on.
    artifacts.set("art_amara-lab", { ...artifacts.get("art_amara-lab")!, text: "edited", revision: 2 });
    expect(await runner.approve(person(P.amara), id)).toMatchObject({
      status: "error",
      error: { code: "conflict", message: "What the request would change has changed since it was made." },
    });
    expect((await store.get(id as never))!.state).toBe("declined");
    expect(ran).toEqual([]);
  });

  it("declines a call whose stored input was altered after it was queued", async () => {
    const { runner, store, ran } = runnerFor();
    const id = approvalIdOf(await runner.invoke(agent(P.amara), "edit_artifact", { artifactId: "art_amara-lab", text: "v2" }, { confirmWrites: true }));
    const queued = (await store.get(id as never))!;
    await store.transition(id as never, "pending", { ...queued, input: { artifactId: "art_amara-lab", text: "something else" } });
    expect(await runner.approve(person(P.amara), id)).toMatchObject({ status: "error", error: { code: "conflict" } });
    expect(ran).toEqual([]);
  });

  it("rechecks the source of record for an approver before it runs, declining a write the source has since taken over", async () => {
    const { runner, store, roster, ran } = runnerFor();
    const id = approvalIdOf(await runner.invoke(agent(P.morgan), "retitle_resource", { resourceId: "rsc_cells", title: "Cell biology" }));
    roster.ownsResources = true;
    expect(await runner.approve(person(P.morgan), id)).toMatchObject({
      status: "error",
      error: { code: "conflict", message: "Learning resources are owned by lms:canvas." },
    });
    expect((await store.get(id as never))!.state).toBe("declined");
    expect(ran).toEqual([]);
  });

  it("never runs the recheck when a call is made, leaving the source of record to the handler", async () => {
    const { runner, roster, ran } = runnerFor();
    roster.ownsResources = true;
    // An approver operation still queues: nothing about its source of record is said to the caller.
    expect(await runner.invoke(agent(P.morgan), "retitle_resource", { resourceId: "rsc_cells", title: "Cell biology" }))
      .toMatchObject({ status: "approval-required", needs: "approval" });
    roster.ownsArtifacts = true;
    // A caller the engine refuses is told nothing more than that.
    expect(await runner.invoke(agent(P.chidi), "edit_artifact", { artifactId: "art_amara-lab", text: "v2" }))
      .toMatchObject({ status: "error", error: { code: "not-found" } });
    // An authorized one hears it from the handler.
    expect(await runner.invoke(agent(P.amara), "edit_artifact", { artifactId: "art_amara-lab", text: "v2" }))
      .toMatchObject({ status: "error", error: { code: "conflict", message: expect.stringContaining("owned by external:oneroster") } });
    expect(ran).toEqual([]);
  });

  it("declines a confirmed call the handler refuses once the recheck says it can no longer be made here", async () => {
    const { runner, store, roster, ran } = runnerFor();
    const id = approvalIdOf(await runner.invoke(agent(P.amara), "edit_artifact", { artifactId: "art_amara-lab", text: "v2" }, { confirmWrites: true }));
    roster.ownsArtifacts = true;
    expect(await runner.approve(person(P.amara), id)).toMatchObject({
      status: "error",
      error: { code: "conflict", message: expect.stringContaining("owned by external:oneroster") },
    });
    expect((await store.get(id as never))!).toMatchObject({ state: "declined", declineReason: "The change can no longer be made here." });
    expect(ran).toEqual([]);
  });

  it("queues every call of an approver operation for someone who may approve it, though the engine allows it", async () => {
    const { runner, ran } = runnerFor();
    const outcome = await runner.invoke(agent(P.morgan), "retitle_resource", { resourceId: "rsc_cells", title: "Cell biology" });
    expect(outcome).toMatchObject({ status: "approval-required", needs: "approval" });
    const id = approvalIdOf(outcome);
    expect(ran).toEqual([]);
    // A teacher of another class cannot approve it; the class's teacher, as a person, can.
    expect(await runner.approve(person(P.rivera), id)).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(await runner.approve(agent(P.morgan) as never, id)).toMatchObject({ status: "error" });
    expect(await runner.approve(person(P.morgan), id)).toMatchObject({ status: "applied", value: { title: "Cell biology" } });
    expect(ran).toEqual(["retitle rsc_cells"]);
  });
});
