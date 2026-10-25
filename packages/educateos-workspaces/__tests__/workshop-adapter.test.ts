import { describe, expect, it } from "vitest";
import { PrincipalId, WorkspaceId } from "@educateos/contracts";
import {
  attachStorageHandle,
  provisionWorkshopWorkspace,
  type WorkshopOwnerSession,
  type WorkshopWorkspaceRequest,
  type WorkshopWorkspaceSeam,
} from "../src/index.ts";
import { O, P, rejectsWith, setup } from "./setup.ts";

/**
 * Behaves as the kernel's seam does for one signed-in Workshop account: workspaces keyed by the
 * account and external ID, a request for any other owner refused, and the kind recorded.
 */
class FakeKernel {
  readonly workspaces = new Map<string, { ref: string; kind: string; owner: string }>();
  calls = 0;

  sessionFor(principalId: string, profileId: string): WorkshopOwnerSession {
    const seam: WorkshopWorkspaceSeam = {
      ensureExternalWorkspace: async (request: WorkshopWorkspaceRequest) => {
        this.calls++;
        if (request.owner !== profileId) throw new Error("A workspace can only be created by the user it belongs to.");
        const key = `${profileId}:${request.externalId}`;
        const existing = this.workspaces.get(key);
        if (existing) return existing.ref;
        const ref = `ref-${this.workspaces.size + 1}`;
        this.workspaces.set(key, { ref, kind: request.kind, owner: profileId });
        return ref;
      },
    };
    return { principalId: PrincipalId.parse(principalId), profileId, seam };
  }
}

describe("attachStorageHandle", () => {
  it("attaches once, accepts the same handle again, and refuses a different one", async () => {
    const { workspaces, store } = setup();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const handle = { backend: "workshop", ref: "ref-a" } as const;

    expect((await attachStorageHandle(store, personal.id, handle)).storageHandle).toEqual(handle);
    const { version } = await store.load();
    await attachStorageHandle(store, personal.id, handle);
    expect((await store.load()).version).toBe(version);

    await rejectsWith(attachStorageHandle(store, personal.id, { backend: "workshop", ref: "ref-b" }), "conflict");
    expect((await workspaces.getWorkspace(P.amara, personal.id)).storageHandle).toEqual(handle);
  });

  it("refuses an unknown workspace", async () => {
    const { store } = setup();
    await rejectsWith(attachStorageHandle(store, WorkspaceId.parse("wsp_unknown"), { backend: "workshop", ref: "ref-a" }), "not-found");
  });
});

describe("provisionWorkshopWorkspace", () => {
  it("returns the same reference however often it runs, calling the kernel only until it is attached", async () => {
    const { workspaces, store } = setup();
    const kernel = new FakeKernel();
    const amara = kernel.sessionFor(P.amara.principal.principalId, "amara@northfield.example");
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);

    // A first attempt that reached the kernel but failed before attaching is simply repeated.
    await amara.seam.ensureExternalWorkspace({ externalId: bio.id, owner: amara.profileId, kind: "course", title: "Biology" });
    const first = await provisionWorkshopWorkspace(store, bio.id, amara, "Biology");
    const again = await provisionWorkshopWorkspace(store, bio.id, amara, "Biology");

    expect(again).toEqual(first);
    expect(kernel.workspaces.size).toBe(1);
    expect(kernel.calls).toBe(2);
    expect((await workspaces.getWorkspace(P.amara, bio.id)).storageHandle).toEqual(first);
  });

  it("carries each workspace's kind into the kernel", async () => {
    const { workspaces, store } = setup();
    const kernel = new FakeKernel();
    const amara = kernel.sessionFor(P.amara.principal.principalId, "amara@northfield.example");
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);

    await provisionWorkshopWorkspace(store, personal.id, amara, "My work");
    await provisionWorkshopWorkspace(store, bio.id, amara, "Biology");

    expect([...kernel.workspaces.values()].map((w) => w.kind)).toEqual(["personal", "course"]);
  });

  it("refuses to create storage for anyone but the workspace's owner, without calling the kernel", async () => {
    const { workspaces, store } = setup();
    const kernel = new FakeKernel();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    const teacher = kernel.sessionFor(P.rivera.principal.principalId, "rivera@northfield.example");

    await rejectsWith(provisionWorkshopWorkspace(store, bio.id, teacher, "Biology"), "forbidden");
    expect(kernel.calls).toBe(0);
    expect((await store.load()).state.workspaces.find((w) => w.id === bio.id)?.storageHandle).toBeUndefined();
  });

  it("fails without attaching anything when the kernel refuses the owner", async () => {
    const { workspaces, store } = setup();
    const kernel = new FakeKernel();
    const personal = await workspaces.ensurePersonalWorkspace(P.amara);
    // The session's principal is the owner, but its Workshop account is someone else's.
    const mismatched = { ...kernel.sessionFor(P.amara.principal.principalId, "amara@northfield.example"), profileId: "chidi@northfield.example" };

    await expect(provisionWorkshopWorkspace(store, personal.id, mismatched, "My work")).rejects.toThrow("only be created by the user");
    expect(kernel.workspaces.size).toBe(0);
    expect((await store.load()).state.workspaces[0]?.storageHandle).toBeUndefined();
  });

  it("shares nothing: staff who can see the workspace never get its storage handle", async () => {
    const { workspaces, store } = setup();
    const kernel = new FakeKernel();
    const amara = kernel.sessionFor(P.amara.principal.principalId, "amara@northfield.example");
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.eng9);
    await provisionWorkshopWorkspace(store, bio.id, amara, "English 9");

    const teacherView = (await workspaces.listOfferingWorkspaces(P.rivera, O.eng9)).find((w) => w.id === bio.id);
    expect(teacherView).toBeDefined();
    expect(teacherView).not.toHaveProperty("storageHandle");
    expect([...kernel.workspaces.values()].map((w) => w.owner)).toEqual(["amara@northfield.example"]);
  });
});
