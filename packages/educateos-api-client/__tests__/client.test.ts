import { describe, expect, it } from "vitest";
import { NORTHFIELD } from "@educateos/fixtures";
import { createDistrictApp, inMemoryDistrictStores } from "@educateos/district-app";
import { createDistrictApiClient, DistrictApiError, unlinkedSignInOf } from "../src/index.ts";

/** A Northfield app whose IdP accepts `token-<subject>` and nothing else. */
async function northfield() {
  const issuer = NORTHFIELD.district.trustedIssuers[0]!;
  const app = await createDistrictApp({
    stores: inMemoryDistrictStores(NORTHFIELD),
    importFetch: async () => new Response("not found", { status: 404 }),
    verifyRequest: async (request) => {
      const token = request.headers.get("authorization")?.replace(/^Bearer token-/, "");
      return token === undefined || token === request.headers.get("authorization") ? undefined : { issuer, subject: token, credential: "person" };
    },
  });
  return (token?: string) => createDistrictApiClient({ baseUrl: "https://learn.northfield.example", ...(token === undefined ? {} : { token }), fetch: (request) => app.fetch(request) });
}

describe("the district API client", () => {
  it("calls routes by name with typed input and returns schema-parsed responses", async () => {
    const client = (await northfield())("token-nf-s-2001");
    const me = await client.call("me.get");
    expect(me).toMatchObject({ principalId: "prn_nf-student-amara", kind: "student" });
    const workspace = await client.call("student.openCourseWorkspace", { params: { offeringId: "off_nf-eng9-fall-p3" } });
    expect(workspace.kind).toBe("course");
    const created = await client.call("student.createArtifact", {
      body: { workspaceId: workspace.id, type: "document", title: "Draft", content: { kind: "text", mediaType: "text/plain", text: "Hello" } },
    });
    const read = await client.call("student.getArtifact", { params: { artifactId: created.artifact.id }, query: { revisionId: created.head.id } });
    expect(read.content).toStrictEqual({ kind: "text", text: "Hello" });
  });

  it("uploads a file as base64 and reads the same bytes back", async () => {
    const client = (await northfield())("token-nf-s-2001");
    const workspace = await client.call("student.openCourseWorkspace", { params: { offeringId: "off_nf-eng9-fall-p3" } });
    const base64 = btoa("%PDF-1.7\n%%EOF\n");
    const created = await client.call("student.createArtifact", {
      body: { workspaceId: workspace.id, type: "document", title: "Essay.pdf", content: { kind: "bytes", mediaType: "application/pdf", base64 } },
    });
    const read = await client.call("student.getArtifact", { params: { artifactId: created.artifact.id } });
    expect(read).toMatchObject({ revision: { mediaType: "application/pdf" }, content: { kind: "bytes", base64 } });
  });

  it("rejects with the server's error code, status and correlation ID", async () => {
    const connect = await northfield();
    await expect(connect().call("me.get")).rejects.toMatchObject({ name: "DistrictApiError", code: "unauthenticated", status: 401 });
    const error = await connect("token-nf-s-2001").call("admin.health").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DistrictApiError);
    expect(error).toMatchObject({ code: "forbidden", status: 403, correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect((error as DistrictApiError).unlinkedSignIn).toBeUndefined();
  });

  it("carries the caller's own sign-in when it verified but is linked to nobody", async () => {
    const connect = await northfield();
    const error = await connect("token-nf-new-teacher").call("me.get").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "unauthenticated", status: 401 });
    expect(unlinkedSignInOf(error)).toStrictEqual({ issuer: NORTHFIELD.district.trustedIssuers[0], subject: "nf-new-teacher" });
    // No credential at all proves no sign-in, so there is nothing to name.
    expect(unlinkedSignInOf(await connect().call("me.get").catch((e: unknown) => e))).toBeUndefined();
    expect(unlinkedSignInOf(new TypeError("Failed to fetch"))).toBeUndefined();
  });

  it("reads a token function on every call, so a refreshed credential is used", async () => {
    let current = "first";
    const seen: (string | null)[] = [];
    const client = createDistrictApiClient({
      baseUrl: "https://learn.northfield.example",
      token: () => current,
      fetch: async (request) => {
        seen.push(request.headers.get("authorization"));
        return new Response(JSON.stringify({ code: "unauthenticated", message: "no" }), { status: 401 });
      },
    });
    await client.call("me.get").catch(() => {});
    current = "second";
    await client.call("me.get").catch(() => {});
    expect(seen).toStrictEqual(["Bearer first", "Bearer second"]);
  });

  it("refuses a response that does not match the route's schema", async () => {
    const client = createDistrictApiClient({
      baseUrl: "https://learn.northfield.example",
      fetch: async () => new Response(JSON.stringify({ principalId: "someone", role: "district-admin" }), { status: 200, headers: { "x-correlation-id": "abc" } }),
    });
    await expect(client.call("me.get")).rejects.toMatchObject({ code: "unavailable", correlationId: "abc" });
  });
});
