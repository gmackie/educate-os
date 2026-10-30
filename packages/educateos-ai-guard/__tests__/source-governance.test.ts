import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiCallDescriptor } from "@gadgets/workshop-shared/ai-call-guard";
import type { EvaluationRequest } from "@gmacko/hall-monitor-contracts";
import { AiPrincipal } from "@educateos/ai-governance";
import { readGuardConfig, type GuardConfig } from "../src/config.ts";
import { configuredGuardDirectory, DistrictGuardContextResolver } from "../src/context.ts";
import { fakeHallMonitor } from "../src/fake-hall-monitor.ts";
import { AiCallGuardService } from "../src/guard.ts";
import { hallMonitorClient } from "../src/hall-monitor.ts";
import { sourceGovernanceContext } from "../src/source-governance.ts";
import { TEST_CONFIG, USERS } from "./fixtures.ts";

const now = () => Math.floor(Date.now() / 1000);
const principalId = "prn_nf-student-amara";
function configuration(eligibility: Record<string, unknown> = {}, config: Record<string, unknown> = {}): GuardConfig {
  const at = now();
  return readGuardConfig(JSON.stringify({ ...TEST_CONFIG, ...config, moderation: { ...TEST_CONFIG.moderation, governance: {
    institutionId: "synthetic-northfield", policyRevision: "synthetic-policy-1", maxEligibilityAgeSeconds: 300,
    purposes: { input: "moderation.input", output: "moderation.output" },
    eligibility: [{ principalId, dataClass: "student", ageEligibility: "13-plus", eligibilityRef: "synthetic-eligibility-1",
      issuedAt: at - 10, expiresAt: at + 600, revoked: false, ...eligibility }],
  } } }));
}
function descriptor(user: string = USERS.student): AiCallDescriptor {
  return { callId: crypto.randomUUID(), logicalRequestId: "synthetic-logical", kind: "language-model", callSite: "chat.message",
    initiator: { type: "user", id: user }, model: { provider: "anthropic", id: "claude-sonnet-example" },
    maxOutputTokens: 1000, newMessages: [{ id: "message-1", role: "user", parts: [{ type: "text", text: "synthetic private text" }] }] };
}
const resolver = (config: GuardConfig) => new DistrictGuardContextResolver(configuredGuardDirectory(config), config);
let ledgers = 0;
function guard(config: GuardConfig, bindingEnv = env) {
  const ledger = env.AI_LEDGER.getByName(`source-governance-${ledgers++}`);
  const client = hallMonitorClient(bindingEnv, config);
  return { ledger, client, service: new AiCallGuardService({ config, ledger, resolver: resolver(config), hallMonitor: client }) };
}
type Claims = { jti: string; exp: number; hm_governance: ReturnType<typeof sourceGovernanceContext> };
function decode(token: string): Claims {
  return JSON.parse(new TextDecoder().decode(Uint8Array.fromBase64(token.split(".")[1]!, { alphabet: "base64url" }))) as Claims;
}
async function signedEnvironment(algorithm: "Ed25519" | "P-256" = "Ed25519") {
  const pair = await crypto.subtle.generateKey(algorithm === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const tokens: string[] = [], requests: EvaluationRequest[] = [], paths: string[] = [];
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const bindingEnv: Cloudflare.Env = { ...env, HALL_MONITOR_ISSUER: "synthetic-educateos", HALL_MONITOR_SIGNING_KEY: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
    HALL_MONITOR: { async fetch(incoming: Request) {
      const token = incoming.headers.get("authorization")!.slice(7);
      const [header, body, signature] = token.split(".") as [string, string, string];
      expect(await crypto.subtle.verify(algorithm === "Ed25519" ? { name: "Ed25519" } : { name: "ECDSA", hash: "SHA-256" }, pair.publicKey,
        Uint8Array.fromBase64(signature, { alphabet: "base64url" }), new TextEncoder().encode(`${header}.${body}`))).toBe(true);
      tokens.push(token); requests.push(await incoming.clone().json() as EvaluationRequest); paths.push(new URL(incoming.url).pathname);
      return handler === undefined ? governedFake(incoming) : handler(incoming);
    } } as Fetcher };
  return { bindingEnv, tokens, requests, paths, setHandler(next: typeof handler) { handler = next; } };
}
// Explicit test-only bridge to the legacy fake. It exercises transport routing and claim binding,
// not the real receiver's enrollment/approval checks, which live in Hall Monitor's Worker suite.
async function governedFake(incoming: Request): Promise<Response> {
  expect(new URL(incoming.url).pathname).toBe("/v1/evaluations:governed");
  const url = new URL(incoming.url); url.pathname = "/v1/evaluations";
  return fakeHallMonitor(new Request(url, incoming));
}
async function request(config: GuardConfig): Promise<EvaluationRequest> {
  const context = (await resolver(config).resolve(descriptor()))!;
  return { schemaVersion: "1.0", requestId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
    source: { product: "educateos", tenantId: config.moderation.tenantId, surface: config.moderation.surface },
    policy: { profileId: context.profile.hallMonitorProfileId, revision: context.profile.revision },
    context: { audience: context.audience, costCenterId: config.moderation.costCenterId }, evaluationKind: "interaction.input",
    content: { type: "text", text: "synthetic private text" } };
}
afterEach(() => vi.restoreAllMocks());

describe("opt-in EducateOS source governance", () => {
  it.each(["Ed25519", "P-256"] as const)("binds signed input/output claims to district-resolved checks with %s", async (algorithm) => {
    const config = configuration(), signed = await signedEnvironment(algorithm);
    const { service } = guard(config, signed.bindingEnv), call = descriptor();
    expect(await service.beforeModelCall(call)).toEqual({ action: "proceed", screenOutput: true });
    expect(await service.screenModelOutput(call.callId, { parts: [{ type: "text", text: "synthetic response" }] })).toEqual({ action: "release" });
    expect(signed.tokens).toHaveLength(2);
    expect(signed.paths).toEqual(["/v1/evaluations:governed", "/v1/evaluations:governed"]);
    expect(new Set(signed.tokens.map((t) => decode(t).jti)).size).toBe(2);
    signed.tokens.forEach((token, i) => {
      const claims = decode(token), sent = signed.requests[i]!;
      expect(claims.hm_governance).toEqual({ schemaVersion: "1.0", institutionId: "synthetic-northfield", requestId: sent.requestId,
        product: "educateos", surface: "educateos.workshop", purpose: i === 0 ? "moderation.input" : "moderation.output",
        dataClass: "student", ageEligibility: "13-plus", eligibilityRef: "synthetic-eligibility-1", policyRevision: "synthetic-policy-1",
        issuedAt: config.moderation.governance!.eligibility[0]!.issuedAt, expiresAt: claims.exp });
      for (const secret of [principalId, USERS.student, "synthetic private text", "synthetic response"])
        expect(JSON.stringify(claims.hm_governance)).not.toContain(secret);
      expect(sent).not.toHaveProperty("hm_governance");
    });
  });

  it("uses the required-governance route over HTTPS with the same signed request binding", async () => {
    const config = configuration(), signed = await signedEnvironment();
    const { HALL_MONITOR: binding, ...rest } = signed.bindingEnv;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => binding!.fetch(new Request(input, init)));
    const { service } = guard(config, { ...rest, HALL_MONITOR_URL: "https://synthetic-hall-monitor.test" });
    expect(await service.beforeModelCall(descriptor())).toMatchObject({ action: "proceed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signed.paths).toEqual(["/v1/evaluations:governed"]);
  });

  it.each([
    { name: "missing principal", principalId: "prn_nf-student-felix" },
    { name: "unknown age", ageEligibility: "unknown" },
    { name: "ineligible", ageEligibility: "ineligible" },
    { name: "revoked", revoked: true },
    { name: "expired", issuedAt: 1, expiresAt: 2 },
    { name: "not yet issued", issuedAt: 9_000_000_000, expiresAt: 9_000_000_100 },
    { name: "too old", issuedAt: 1, expiresAt: 9_000_000_000 },
    { name: "staff label on student", dataClass: "staff", ageEligibility: "adult" },
    { name: "synthetic age on student data", ageEligibility: "synthetic" },
  ])("refuses $name before funding or transferring content", async ({ name: _name, ...eligibility }) => {
    const config = configuration(eligibility), signed = await signedEnvironment();
    const { service, ledger } = guard(config, signed.bindingEnv), call = descriptor();
    expect(await service.beforeModelCall(call)).toMatchObject({ action: "deny", reason: "source_eligibility_unavailable" });
    expect(await ledger.request(call.callId)).toBeNull();
    expect(signed.tokens).toHaveLength(0);
  });

  it("requires a signing key even for service bindings and never uses an educator's proceed fallback", async () => {
    const config = configuration({ principalId: "prn_nf-morgan-lee", dataClass: "staff", ageEligibility: "adult" });
    const { service, client } = guard(config);
    expect(client).toBeNull();
    expect(await service.beforeModelCall(descriptor(USERS.teacher))).toMatchObject({ action: "deny", reason: "moderation_unavailable" });
  });

  it.each([403, 404, 503])("keeps a governed educator closed when Hall Monitor returns %s", async (status) => {
    const config = configuration({ principalId: "prn_nf-morgan-lee", dataClass: "staff", ageEligibility: "adult" });
    const signed = await signedEnvironment();
    signed.setHandler(async () => Response.json({ code: status === 403 ? "forbidden" : "unavailable", message: "unavailable", retryable: status === 503 }, { status }));
    const { service, ledger } = guard(config, signed.bindingEnv), call = descriptor(USERS.teacher);
    expect(await service.beforeModelCall(call)).toMatchObject({ action: "deny", reason: "moderation_unavailable" });
    expect((await ledger.request(call.callId))?.voided).toBeDefined();
    expect(signed.tokens).toHaveLength(status === 503 ? 2 : 1);
    expect(signed.paths.every((p) => p === "/v1/evaluations:governed")).toBe(true);
  });

  it.each(["allow", "coach", "support"] as const)("fails closed on degraded %s while preserving deterministic support", async (decision) => {
    const config = configuration(), signed = await signedEnvironment();
    signed.setHandler(async (incoming) => {
      const result = await (await governedFake(incoming)).json() as Record<string, unknown>;
      return Response.json({ ...result, decision, degraded: { reason: "classifier_unavailable" } });
    });
    const { service, ledger } = guard(config, signed.bindingEnv), call = descriptor();
    expect(await service.beforeModelCall(call)).toMatchObject({ action: "deny", reason: decision === "support" ? "moderation_support" : "moderation_unavailable" });
    expect((await ledger.request(call.callId))?.voided).toBeDefined();
    expect(signed.paths).toEqual(["/v1/evaluations:governed"]);
  });

  it("never applies the educator proceed fallback to a degraded allow", async () => {
    const config = configuration({ principalId: "prn_nf-morgan-lee", dataClass: "staff", ageEligibility: "adult" }), signed = await signedEnvironment();
    signed.setHandler(async (incoming) => {
      const result = await (await governedFake(incoming)).json() as Record<string, unknown>;
      return Response.json({ ...result, degraded: { reason: "classifier_unavailable" } });
    });
    expect(await guard(config, signed.bindingEnv).service.beforeModelCall(descriptor(USERS.teacher))).toMatchObject({ action: "deny", reason: "moderation_unavailable" });
  });

  it("withholds a degraded allow on output after a healthy governed input", async () => {
    const config = configuration(), signed = await signedEnvironment();
    const { service } = guard(config, signed.bindingEnv), call = descriptor();
    expect(await service.beforeModelCall(call)).toMatchObject({ action: "proceed", screenOutput: true });
    signed.setHandler(async (incoming) => {
      const result = await (await governedFake(incoming)).json() as Record<string, unknown>;
      return Response.json({ ...result, degraded: { reason: "classifier_unavailable" } });
    });
    expect(await service.screenModelOutput(call.callId, { parts: [{ type: "text", text: "synthetic response" }] })).toMatchObject({ action: "withhold", reason: "moderation_unavailable" });
  });

  it("refuses a configuration whose student profile skips input moderation (SCHO-307)", async () => {
    const profiles = { ...TEST_CONFIG.profiles, "student-9-12": { ...TEST_CONFIG.profiles["student-9-12"], moderateInput: false } };
    expect(() => configuration({}, { profiles })).toThrow(/profiles\.student-9-12/);
  });

  it("rechecks original eligibility on retry, mints a new jti, and keeps concurrent request claims separate", async () => {
    const config = configuration(), signed = await signedEnvironment(), client = hallMonitorClient(signed.bindingEnv, config)!;
    const context = (await resolver(config).resolve(descriptor()))!;
    let first = true;
    signed.setHandler(async (r) => {
      if (first) { first = false; return new Response(null, { status: 503 }); }
      return governedFake(r);
    });
    const one = await request(config), two = await request(config);
    await Promise.all([client.evaluate(one, { sourceContext: context }), client.evaluate(two, { sourceContext: context })]);
    expect(signed.tokens).toHaveLength(3);
    expect(new Set(signed.tokens.map((t) => decode(t).jti)).size).toBe(3);
    signed.tokens.forEach((t, i) => expect(decode(t).hm_governance.requestId).toBe(signed.requests[i]!.requestId));
    expect(new Set(signed.tokens.map((t) => decode(t).hm_governance.issuedAt))).toEqual(new Set([config.moderation.governance!.eligibility[0]!.issuedAt]));
  });

  it("does not send another attempt if eligibility expires during retry", async () => {
    const at = Date.now();
    let clock = at;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const config = configuration({ expiresAt: Math.floor(at / 1000) + 1 }), signed = await signedEnvironment();
    signed.setHandler(async () => { clock += 2000; return new Response(null, { status: 503 }); });
    const context = (await resolver(config).resolve(descriptor()))!;
    await expect(hallMonitorClient(signed.bindingEnv, config)!.evaluate(await request(config), { sourceContext: context })).rejects.toThrow();
    expect(signed.tokens).toHaveLength(1);
    expect(decode(signed.tokens[0]!).hm_governance.expiresAt).toBe(Math.floor(at / 1000) + 1);
  });

  it("rejects cross-district context, missing context and source/request mismatches before transfer", async () => {
    const config = configuration(), signed = await signedEnvironment(), client = hallMonitorClient(signed.bindingEnv, config)!;
    const context = (await resolver(config).resolve(descriptor()))!, evaluation = await request(config);
    await expect(client.evaluate(evaluation)).rejects.toThrow();
    const other = (await resolver(readGuardConfig(JSON.stringify(TEST_CONFIG))).resolve(descriptor(USERS.teacher)))!;
    await expect(client.evaluate(evaluation, { sourceContext: other })).rejects.toThrow();
    await expect(client.evaluate(evaluation, { sourceContext: { ...context,
      principal: AiPrincipal.parse({ principalId, districtId: "dst_other" }) } })).rejects.toThrow();
    for (const source of [{ ...evaluation.source, tenantId: "tenant_other" }, { ...evaluation.source, surface: "other.surface" }])
      await expect(client.evaluate({ ...evaluation, source }, { sourceContext: context })).rejects.toThrow();
    await expect(client.evaluateBatch([evaluation])).rejects.toThrow();
    expect(signed.tokens).toHaveLength(0);
  });

  it("withholds output when the original eligibility expires after input admission", async () => {
    const at = Date.now(), config = configuration({ expiresAt: Math.floor(at / 1000) + 60 });
    const signed = await signedEnvironment(), { service, ledger } = guard(config, signed.bindingEnv), call = descriptor();
    expect(await service.beforeModelCall(call)).toMatchObject({ action: "proceed", screenOutput: true });
    vi.spyOn(Date, "now").mockReturnValue(at + 61_000);
    expect(await service.screenModelOutput(call.callId, { parts: [{ type: "text", text: "synthetic response" }] })).toMatchObject({ action: "withhold", reason: "source_eligibility_unavailable" });
    expect(signed.tokens).toHaveLength(1);
    expect(await ledger.request(`${call.callId}.o.c0`)).toBeNull();
  });

  it("requires authoritative district context and refuses ambiguous installed records", () => {
    expect(() => configuration({}, { contextSource: "static" })).toThrow();
    const config = configuration(), g = config.moderation.governance!;
    expect(() => readGuardConfig(JSON.stringify({ ...config, moderation: { ...config.moderation,
      governance: { ...g, eligibility: [...g.eligibility, ...g.eligibility] } } }))).toThrow();
  });
});
