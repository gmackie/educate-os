import { describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT } from "jose";
import { z } from "zod";
import { NORTHFIELD } from "@educateos/fixtures";
import { createDirectoryPrincipalResolver } from "@educateos/identity";
import { InMemoryToolApprovalStore, SchoolToolRunner, defineSchoolTool } from "@educateos/policy";
import { InMemoryAcademicStore } from "@educateos/academics";
import {
  DistrictId,
  PrincipalId,
  type PolicySettings,
  type ResourceKind,
} from "@educateos/contracts";
import {
  directoryPolicyInformation,
  PolicyEngine,
  InMemoryPolicyAuditSink,
  type ToolTarget,
} from "@educateos/policy";

const subject = (id: string) => ({
  districtId: DistrictId.parse("dst_northfield"),
  principalId: PrincipalId.parse(id),
});
const P = {
  morgan: subject("prn_nf-morgan-lee"),
  amara: subject("prn_nf-student-amara"),
  elena: subject("prn_nf-student-elena"),
  chidi: subject("prn_nf-student-chidi"),
};
const floor: PolicySettings = {
  aiSpending: "capped",
  promptsInGatewayLogs: "prohibited",
  studentPersonalConversations: "shared-by-student",
  teacherObservation: "assigned-work-and-shared-conversations",
  automatedSelProfiling: "prohibited",
  aiMonthlyCapCentsPerPrincipal: 500,
};
function engineFor() {
  const store = InMemoryAcademicStore.seeded(NORTHFIELD);
  const engine = new PolicyEngine({
    information: directoryPolicyInformation(store, { effectivePolicy: async () => floor }),
    audit: new InMemoryPolicyAuditSink(),
  });
  return { store, engine };
}
function courseResource(
  offeringId: string,
  kind: ResourceKind,
  _classification: string,
  options: { owner: string; id?: string },
): ToolTarget {
  const offering = NORTHFIELD.offerings.find((o) => o.id === offeringId)!;
  return {
    resource: {
      kind,
      classification: "course",
      id: options.id,
      ownerPrincipalId: PrincipalId.parse(options.owner),
      scope: {
        level: "offering",
        districtId: offering.districtId,
        schoolId: offering.schoolId,
        offeringId: offering.id,
      },
    },
    termState: NORTHFIELD.terms.find((t) => t.id === offering.termId)!.state,
  };
}
import {
  createSchoolMcpApi,
  SchoolTokenAuthority,
  type AccessGrant,
  type TokenStore,
} from "../src/index.ts";

async function world() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const snapshot = structuredClone(NORTHFIELD);
  const issuer = snapshot.principals.find((p) => p.id === P.morgan.principalId)!
    .externalIdentities[0]!.issuer;
  const claims = new Set<string>();
  const grants = new Map<string, AccessGrant>();
  const store: TokenStore = {
    async claimAssertion(key) {
      if (claims.has(key)) return false;
      claims.add(key);
      return true;
    },
    async putAccess(key, value) {
      grants.set(key, value);
    },
    async getAccess(key) {
      return grants.get(key);
    },
  };
  let now = Date.now();
  const tokens = new SchoolTokenAuthority({
    issuers: [
      {
        issuer,
        audience: "https://school.example/mcp",
        exchangeAudience: "https://school.example/token",
        keys: async () => publicKey,
        algorithms: ["RS256"],
        credential: "person",
      },
    ],
    store,
    resolver: async () => createDirectoryPrincipalResolver(snapshot),
    now: () => now,
    requiredScopes: ["mcp:tools"],
  });
  async function token(
    principal = P.morgan,
    overrides: Record<string, unknown> = {},
    exchange = false,
  ) {
    const externalSubject = snapshot.principals
      .find((p) => p.id === principal.principalId)!
      .externalIdentities.find((i) => i.issuer === issuer)!.subject;
    return new SignJWT({ scope: "mcp:tools", ...overrides })
      .setProtectedHeader({ alg: "RS256", typ: exchange ? "JWT" : "at+jwt" })
      .setIssuer(typeof overrides.iss === "string" ? overrides.iss : issuer)
      .setSubject(externalSubject)
      .setAudience(
        typeof overrides.aud === "string"
          ? overrides.aud
          : `https://school.example/${exchange ? "token" : "mcp"}`,
      )
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(
        typeof overrides.exp === "number" ? overrides.exp : Math.floor(now / 1000) + 120,
      )
      .setJti("assertion-one")
      .sign(privateKey);
  }
  const { engine, store: directory } = engineFor();
  const handled = vi.fn(async () => "class record");
  const target = async () =>
    courseResource("off_nf-bio-fall-p2", "artifact", "course", {
      owner: P.amara.principalId,
      id: "art_lab",
    });
  const runner = new SchoolToolRunner({
    engine,
    approvals: { store: new InMemoryToolApprovalStore() },
    tools: [
      defineSchoolTool({
        name: "class_read",
        description: "Read class work",
        inputSchema: z.strictObject({}),
        action: "read",
        resource: target,
        handler: handled,
      }),
      defineSchoolTool({
        name: "class_edit",
        description: "Edit own work",
        inputSchema: z.strictObject({}),
        action: "update",
        annotations: { readOnlyHint: true },
        resource: target,
        handler: handled,
      }),
      defineSchoolTool({
        name: "class_grade",
        description: "Grade work",
        inputSchema: z.strictObject({ score: z.number().min(0).max(100) }),
        action: "grade",
        annotations: { readOnlyHint: true },
        resource: async () =>
          courseResource("off_nf-bio-fall-p2", "official-grade", "course", {
            owner: P.amara.principalId,
          }),
        handler: handled,
      }),
    ],
  });
  const api = createSchoolMcpApi({
    districtId: P.morgan.districtId,
    runner,
    tokens,
    allowedOrigins: ["https://school.example"],
    resource: { origin: "https://school.example", authorizationServers: [issuer], scopes: ["mcp:tools"] },
  });
  async function post(
    body: unknown,
    bearer?: string,
    path = "/mcp",
    headers: Record<string, string> = {},
  ) {
    return api.fetch(
      new Request(`https://school.example${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  }
  async function call(bearer: string, name = "class_read", args = {}) {
    const response = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      bearer,
    );
    const body = (await response.json()) as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text);
  }
  return {
    api,
    post,
    call,
    token,
    tokens,
    handled,
    runner,
    directory,
    snapshot,
    grants,
    advance: () => {
      now += 301_000;
    },
  };
}

describe("external MCP integration", () => {
  it("initializes, lists strict schemas and permits the assigned teacher's class read", async () => {
    const w = await world();
    const bearer = await w.token();
    const response = await w.post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      bearer,
    );
    expect(await response.json()).toMatchObject({
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
    });
    expect(
      await (await w.post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, bearer)).json(),
    ).toMatchObject({
      result: { tools: [{ inputSchema: { additionalProperties: false } }, {}, {}] },
    });
    expect(await w.call(bearer)).toMatchObject({ status: "ok", value: "class record" });
  });
  it("denies a student another student's records and rejects identity injection", async () => {
    const w = await world();
    const bearer = await w.token(P.elena);
    expect(await w.call(bearer)).toMatchObject({ status: "error", error: { code: "not-found" } });
    expect(await w.call(bearer, "class_read", { role: "teacher" })).toMatchObject({
      status: "error",
      error: { code: "validation-failed" },
    });
    expect(await w.call(await w.token(P.chidi))).toMatchObject({
      status: "error",
      error: { code: "not-found" },
    });
    expect(w.handled).not.toHaveBeenCalled();
  });
  it("rechecks current directory authorization on every request", async () => {
    const w = await world();
    const bearer = await w.token();
    expect(await w.call(bearer)).toMatchObject({ status: "ok" });
    const { snapshot, version } = await w.directory.load();
    snapshot.roleAssignments = snapshot.roleAssignments.filter(
      (r) => r.principalId !== P.morgan.principalId,
    );
    snapshot.enrollments
      .filter((e) => e.principalId === P.morgan.principalId)
      .forEach((e) => {
        e.status = "inactive";
      });
    await w.directory.commit(snapshot, version);
    expect(await w.call(bearer)).toMatchObject({ status: "error" });
  });
  it("queues writes despite readOnlyHint and never publishes them", async () => {
    const w = await world();
    const bearer = await w.token();
    expect(await w.call(bearer, "class_grade", { score: 92 })).toMatchObject({
      status: "approval-required",
      approvalId: expect.any(String),
    });
    expect(w.handled).not.toHaveBeenCalled();
    expect(await w.runner.pendingFor({ principal: P.morgan, channel: "http" })).toHaveLength(1);
    expect(await w.call(await w.token(P.amara), "class_edit")).toMatchObject({
      status: "approval-required",
      needs: "confirmation",
    });
    expect(w.handled).not.toHaveBeenCalled();
  });
  it("exchanges an assertion once, including concurrent replay, and expires the access grant", async () => {
    const w = await world();
    const assertion = await w.token(P.morgan, {}, true);
    const body = {
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: assertion,
    };
    const responses = await Promise.all([
      w.post(body, undefined, "/token"),
      w.post(body, undefined, "/token"),
    ]);
    expect(responses.map((r) => r.status).toSorted()).toEqual([200, 400]);
    const grant = (await responses.find((r) => r.status === 200)!.json()) as {
      access_token: string;
    };
    expect(await w.call(grant.access_token)).toMatchObject({ status: "ok" });
    w.advance();
    await expect(w.tokens.authenticate(grant.access_token)).rejects.toThrow();
  });
  it("rejects wrong audience, expired, unknown issuer, tampered and exchange-only tokens", async () => {
    const w = await world();
    for (const overrides of [{ aud: "other" }, { exp: 1 }, { iss: "https://unknown.example" }]) {
      const bearer = await w.token(P.morgan, overrides);
      expect((await w.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer)).status).toBe(
        401,
      );
      await expect(w.tokens.exchange(await w.token(P.morgan, overrides, true))).rejects.toThrow();
    }
    await expect(w.tokens.authenticate(await w.token(P.morgan, {}, true))).rejects.toThrow();
    const bearer = await w.token();
    await expect(w.tokens.authenticate(bearer.slice(0, -10) + "tamperedxx")).rejects.toThrow();
  });
  it("revokes an exchanged grant immediately without storing its bearer secret", async () => {
    const w = await world();
    const grant = await w.tokens.exchange(await w.token(P.morgan, {}, true));
    expect(await w.call(grant.access_token)).toMatchObject({ status: "ok" });
    expect(JSON.stringify([...w.grants])).not.toContain(grant.access_token);
    w.grants.clear();
    await expect(w.tokens.authenticate(grant.access_token)).rejects.toThrow();
  });
  it("refuses a valid token at another district's API", async () => {
    const w = await world();
    const api = createSchoolMcpApi({
      districtId: DistrictId.parse("dst_riverbend"),
      runner: w.runner,
      tokens: w.tokens,
      allowedOrigins: [],
    });
    const response = await api.fetch(
      new Request("https://school.example/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await w.token()}`,
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(w.handled).not.toHaveBeenCalled();
  });
  it("ignores forged roles and resolves the directory again after identity unlinking", async () => {
    const w = await world();
    const bearer = await w.token(P.elena, { role: "teacher", principalId: P.morgan.principalId });
    expect(await w.call(bearer)).toMatchObject({ status: "error" });
    const principal = w.snapshot.principals.find((p) => p.id === P.elena.principalId)!;
    principal.externalIdentities = principal.externalIdentities.map((i) => ({
      ...i,
      subject: `${i.subject}-unlinked`,
    }));
    await expect(w.tokens.authenticate(bearer)).rejects.toThrow();
  });
  it("rejects malformed envelopes, unsupported versions, unsafe origins and oversized bodies", async () => {
    const w = await world();
    const bearer = await w.token();
    for (const body of [
      [],
      { jsonrpc: "2.0", id: 1, method: "tools/list", principalId: "admin" },
    ]) {
      expect(await (await w.post(body, bearer)).json()).toMatchObject({ error: { code: -32600 } });
    }
    expect((await w.post({}, bearer, "/mcp", { origin: "https://evil.example" })).status).toBe(403);
    expect(
      (
        await w.post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer, "/mcp", {
          "mcp-protocol-version": "unknown",
        })
      ).status,
    ).toBe(400);
    expect(await (await w.post("x".repeat(65537), bearer)).json()).toMatchObject({
      error: { code: -32700 },
    });
    expect(
      (
        await w.post(
          {
            jsonrpc: "2.0",
            method: "tools/call",
            params: { name: "class_grade", arguments: { score: 99 } },
          },
          bearer,
        )
      ).status,
    ).toBe(202);
    expect(w.handled).not.toHaveBeenCalled();
  });
});


describe("OAuth resource and browser profile", () => {
  it("publishes metadata, resource hints and exact-origin CORS", async () => {
    const w = await world();
    const metadata = await w.api.fetch(new Request("https://school.example/.well-known/oauth-protected-resource/mcp"));
    expect(await metadata.json()).toMatchObject({ resource: "https://school.example/mcp", scopes_supported: ["mcp:tools"] });
    const unauthorized = await w.post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("www-authenticate")).toContain('resource_metadata="https://school.example/.well-known/oauth-protected-resource/mcp"');
    expect(await unauthorized.text()).toBe("");
    const preflight = await w.api.fetch(new Request("https://school.example/mcp", { method: "OPTIONS", headers: {
      origin: "https://school.example", "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type, mcp-protocol-version",
    } }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://school.example");
    expect(preflight.headers.get("access-control-allow-credentials")).toBeNull();
    for (const origin of ["null", "https://evil.example", "https://school.example.evil.example"]) {
      const denied = await w.post({}, undefined, "/mcp", { origin });
      expect(denied.status).toBe(403);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect((await w.api.fetch(new Request("https://evil.example/mcp"))).status).toBe(403);
  });
  it("requires signed scopes and denies refresh grants and revoked identity after reissuance", async () => {
    const w = await world();
    for (const scope of [undefined, "", "other", ["mcp:tools"]]) {
      await expect(w.tokens.authenticate(await w.token(P.morgan, { scope }))).rejects.toThrow();
      await expect(w.tokens.exchange(await w.token(P.morgan, { scope }, true))).rejects.toThrow();
    }
    expect((await w.post({ grant_type: "refresh_token", refresh_token: "private" }, undefined, "/token")).status).toBe(400);
    expect((await w.post({}, await w.token(P.morgan, { exp: 1 }))).status).toBe(401);
    expect(await w.call(await w.token())).toMatchObject({ status: "ok" });
    const reissued = await w.token();
    w.snapshot.principals.find((p) => p.id === P.morgan.principalId)!.externalIdentities = [];
    await expect(w.tokens.authenticate(reissued)).rejects.toThrow();
  });
});
