import { createExecutionContext, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type {
  AuthenticatedApi, ExternalWorkspaceRequest, PublicApi,
} from "@gadgets/workshop-shared/api";
import { describe, expect, it } from "vitest";
import server from "../src/server";
import type { GadgetRecord, UserStorage } from "../src/storage-schema/user-storage";
import type { UserDurableObject } from "../src/user";

// AuthenticatedApi.ensureExternalWorkspace(): the seam an external system (SchoolOS) uses to give
// one of its workspaces a Workshop workspace, acting only as that workspace's owner.

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await server.fetch(new Request("https://workshop.invalid/api", {
    headers: { Upgrade: "websocket" },
  }), env, createExecutionContext());
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return newWebSocketRpcSession<PublicApi>(socket);
}

async function authenticate(publicApi: RpcStub<PublicApi>, prefix: string)
    : Promise<{ username: string; api: RpcStub<AuthenticatedApi> }> {
  const username = prefix + crypto.randomUUID().replaceAll("-", "");
  const token = await publicApi.createAccount(username, username, new Uint8Array([1, 2, 3]));
  if (token === null) throw new Error(`Failed to create ${username}.`);
  return { username, api: await publicApi.authenticate(token) };
}

function request(owner: string, overrides: Partial<ExternalWorkspaceRequest> = {})
    : ExternalWorkspaceRequest {
  return { externalId: "ws_course_1", owner, kind: "course", title: "Algebra I", ...overrides };
}

// The user's own record of workspace `id`, read from their Durable Object's storage.
function storedRecord(username: string, id: string): Promise<GadgetRecord | undefined> {
  const user = exports.UserDurableObject.get(exports.UserDurableObject.idFromName(username));
  return runInDurableObject(user, (instance: UserDurableObject) =>
    (instance as unknown as { storage: UserStorage }).storage.gadgets.get(id));
}

describe("ensureExternalWorkspace", () => {
  it("returns the same workspace for the same external ID, and records its kind", async () => {
    using publicApi = await connect();
    const { username, api } = await authenticate(publicApi, "extowner");
    using owner = api;

    const first = await owner.ensureExternalWorkspace(request(username));
    const retry = await owner.ensureExternalWorkspace(request(username, { title: "Renamed" }));
    const personal = await owner.ensureExternalWorkspace(
        request(username, { externalId: "ws_personal_1", kind: "personal" }));

    expect(retry).toBe(first);
    expect(personal).not.toBe(first);
    expect(await storedRecord(username, first)).toMatchObject({
      id: first, title: "Algebra I", external: { externalId: "ws_course_1", kind: "course" },
    });
    expect((await storedRecord(username, personal))?.external)
        .toEqual({ externalId: "ws_personal_1", kind: "personal" });
  });

  it("refuses a retry that names a different kind", async () => {
    using publicApi = await connect();
    const { username, api } = await authenticate(publicApi, "extkind");
    using owner = api;

    await owner.ensureExternalWorkspace(request(username));
    await expect(owner.ensureExternalWorkspace(request(username, { kind: "personal" })))
        .rejects.toThrow("different kind");
  });

  it("refuses to create a workspace for anyone but the caller", async () => {
    using publicApi = await connect();
    const caller = await authenticate(publicApi, "extcaller");
    const victim = await authenticate(publicApi, "extvictim");
    using callerApi = caller.api;
    using victimApi = victim.api;

    await expect(callerApi.ensureExternalWorkspace(request(victim.username)))
        .rejects.toThrow("only be created by the user it belongs to");
    // Nothing was recorded for either of them.
    const victimOwn = await victimApi.ensureExternalWorkspace(request(victim.username));
    expect(await storedRecord(caller.username, victimOwn)).toBeUndefined();
  });

  it("gives each owner their own workspace and shares it with no one", async () => {
    using publicApi = await connect();
    const a = await authenticate(publicApi, "extalice");
    const b = await authenticate(publicApi, "extbob");
    using alice = a.api;
    using bob = b.api;

    const aliceRef = await alice.ensureExternalWorkspace(request(a.username));
    const bobRef = await bob.ensureExternalWorkspace(request(b.username));
    expect(bobRef).not.toBe(aliceRef);

    // The owner can open it, as its owner, with no collaborators.
    using workspace = alice.openGadget(aliceRef);
    expect((await workspace.getMetadata()).owner).toBeUndefined();
    expect(await workspace.listCollaborators()).toEqual([]);

    // Anyone else, knowing its ID, is denied, and it never appears in their listing.
    using intruderView = bob.openGadget(aliceRef);
    await expect(intruderView.getMetadata()).rejects.toThrow("You don't have access to this workspace.");
    expect((await bob.listGadgets()).map(g => g.id)).not.toContain(aliceRef);
    expect(await storedRecord(b.username, aliceRef)).toBeUndefined();
  });
});
