// The LTI client-side storage fallback (SCHO-58): a launch in an iframe whose browser blocks the
// tool's cookies is bound to the browser through the platform's storage instead, and the login CSRF
// defence still holds when the cookie is absent.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PLATFORM_STORAGE_SCRIPT, PLATFORM_STORAGE_SCRIPT_HASH, PLATFORM_STORAGE_TIMEOUT_MS } from "../src/index.ts";
import { cookiePair, createWorld, formPost, SHARED_SUB, TOOL, type World } from "./helpers.ts";

const TARGET = "post_message_forwarding";

/** The JSON settings a storage page passes its script. */
function pageConfig(html: string): Record<string, string> {
  const match = /<script type="application\/json" id="lti-storage-config">(.*?)<\/script>/.exec(html);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, string>;
}

/** Login initiation through the handler, as Canvas sends it when it offers platform storage. */
async function storageLogin(world: World) {
  const platform = world.platforms.nfCanvas;
  const query = new URLSearchParams({
    iss: platform.issuer,
    client_id: platform.clientId,
    login_hint: "opaque-login-hint",
    lti_deployment_id: platform.deploymentId,
    target_link_uri: `${TOOL}/lti/launch`,
    lti_storage_target: TARGET,
  });
  const response = (await world.handler(new Request(`${TOOL}/lti/login?${query}`)))!;
  const html = await response.text();
  const config = pageConfig(html);
  const redirect = new URL(config.next!);
  const state = redirect.searchParams.get("state")!;
  const idToken = await platform.idToken({
    sub: SHARED_SUB,
    contextId: "nf-canvas-course-bio-p2",
    resourceLinkId: "rl-cell-lab",
    nonce: redirect.searchParams.get("nonce")!,
    targetLinkUri: `${TOOL}/lti/launch`,
  });
  return { response, html, config, state, idToken, cookie: cookiePair(response.headers.get("set-cookie")) };
}

/** The storage page's own re-post of a launch: same-origin, as a browser sends it. */
function storagePost(idToken: string, state: string, value: string, origin = TOOL, site = "same-origin"): Request {
  const request = formPost(`${TOOL}/lti/launch`, [["id_token", idToken], ["state", state], ["lti_storage_target", TARGET], ["lti_storage_value", value]]);
  request.headers.set("origin", origin);
  request.headers.set("sec-fetch-site", site);
  return request;
}

describe("LTI platform storage fallback (SCHO-58)", () => {
  it("admits the page script by a hash that matches it", () => {
    const digest = createHash("sha256").update(PLATFORM_STORAGE_SCRIPT).digest("base64");
    expect(PLATFORM_STORAGE_SCRIPT_HASH).toBe(`'sha256-${digest}'`);
  });

  it("puts a per-login secret in the platform's frame before redirecting, and still sets the cookie", async () => {
    const world = await createWorld();
    const { response, html, config, state } = await storageLogin(world);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(`script-src ${PLATFORM_STORAGE_SCRIPT_HASH}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^__Host-lti-state-${state}=1;`));
    expect(config).toMatchObject({
      mode: "put",
      target: TARGET,
      origin: new URL(world.platforms.nfCanvas.authLoginUrl).origin,
      key: `educateos_lti_${state}`,
    });
    expect(config.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(`${new URL(config.next!).origin}${new URL(config.next!).pathname}`).toBe(world.platforms.nfCanvas.authLoginUrl);
    // The secret lives in the page and the platform's storage, never in the platform-bound URL.
    expect(config.next).not.toContain(config.value);
    // Only the hashed script runs: the settings element is JSON, which a browser never executes.
    expect(html.match(/<script>/g)).toHaveLength(1);
  });

  it("launches without the cookie by reading the secret back, and a replay fails", async () => {
    const world = await createWorld();
    const { config, state, idToken } = await storageLogin(world);

    // The platform posts the launch with no cookie: the tool answers with the read-back page and
    // consumes nothing yet.
    const first = (await world.handler(formPost(`${TOOL}/lti/launch`, [["id_token", idToken], ["state", state], ["lti_storage_target", TARGET]])))!;
    expect(first.status).toBe(200);
    const readBack = pageConfig(await first.clone().text());
    expect(readBack).toEqual({ mode: "get", target: TARGET, origin: config.origin, key: config.key });
    expect(first.headers.get("content-security-policy")).toContain("form-action 'self'");

    const launched = (await world.handler(storagePost(idToken, state, config.value!)))!;
    expect(launched.status).toBe(200);
    expect(await launched.json()).toMatchObject({ accepted: { principal: { principalId: "prn_nf-student-amara" }, offeringId: "off_nf-bio-fall-p2" } });

    const replayed = (await world.handler(storagePost(idToken, state, config.value!)))!;
    expect(replayed.status).toBe(401);
  });

  it("refuses an attacker's own launch posted from another site, though the attacker knows its secret", async () => {
    // The attacker starts a login in their own browser, so they see their secret and get an
    // id_token for their own account. Posting both from a victim's browser must not sign the victim
    // in as the attacker: the browser sends the attacker page's origin.
    const world = await createWorld();
    const { config, state, idToken } = await storageLogin(world);
    for (const forged of [
      storagePost(idToken, state, config.value!, "https://attacker.example", "cross-site"),
      storagePost(idToken, state, config.value!, TOOL, "cross-site"),
      formPost(`${TOOL}/lti/launch`, [["id_token", idToken], ["state", state], ["lti_storage_value", config.value!]]),
    ]) {
      const response = (await world.handler(forged))!;
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "unauthenticated" });
    }
    // None of those consumed the state: they were refused before the broker saw them.
    expect((await world.handler(storagePost(idToken, state, config.value!)))!.status).toBe(200);
  });

  it("refuses a wrong secret and burns the state", async () => {
    const world = await createWorld();
    const { config, state, idToken } = await storageLogin(world);
    expect((await world.handler(storagePost(idToken, state, "x".repeat(43))))!.status).toBe(401);
    expect((await world.handler(storagePost(idToken, state, config.value!)))!.status).toBe(401);
  });

  it("refuses a storage secret for a login that never used platform storage", async () => {
    const world = await createWorld();
    const platform = world.platforms.nfCanvas;
    const { state, redirectUrl } = await world.broker.login({
      iss: platform.issuer,
      client_id: platform.clientId,
      login_hint: "h",
      target_link_uri: `${TOOL}/lti/launch`,
    });
    const nonce = new URL(redirectUrl).searchParams.get("nonce")!;
    const idToken = await platform.idToken({ sub: SHARED_SUB, contextId: "nf-canvas-course-bio-p2", nonce, targetLinkUri: `${TOOL}/lti/launch` });
    expect((await world.handler(storagePost(idToken, state, "y".repeat(43))))!.status).toBe(401);
  });

  it("uses the cookie when the browser did accept it", async () => {
    const world = await createWorld();
    const { state, idToken, cookie } = await storageLogin(world);
    const response = (await world.handler(formPost(`${TOOL}/lti/launch`, [["id_token", idToken], ["state", state], ["lti_storage_target", TARGET]], cookie)))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: { offeringId: "off_nf-bio-fall-p2" } });
  });

  it("still refuses a launch with neither the cookie nor platform storage", async () => {
    const world = await createWorld();
    const { state, idToken } = await storageLogin(world);
    const response = (await world.handler(formPost(`${TOOL}/lti/launch`, [["id_token", idToken], ["state", state]])))!;
    expect(response.status).toBe(401);
  });

  it("answers a read-back request only for a registered platform", async () => {
    const world = await createWorld();
    const { state } = await storageLogin(world);
    const unsigned = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ iss: "https://lms.unknown.example", aud: "x" }))}.`;
    const response = (await world.handler(formPost(`${TOOL}/lti/launch`, [["id_token", unsigned], ["state", state], ["lti_storage_target", TARGET]])))!;
    expect(response.status).toBe(401);
  });
});

// The client script, run against a fake browser window.

interface FakeFrame {
  readonly sent: { message: Record<string, unknown>; origin: string }[];
  postMessage(message: Record<string, unknown>, origin: string): void;
}

function frame(): FakeFrame {
  const sent: FakeFrame["sent"] = [];
  return { sent, postMessage: (message, origin) => sent.push({ message, origin }) };
}

const PLATFORM = "https://sso.canvas.northfield.example";

function runScript(config: Record<string, string>, options: { framed?: boolean } = {}) {
  const target = frame();
  const parent = { ...frame(), frames: { [TARGET]: target } as Record<string, FakeFrame> };
  const listeners: ((event: { origin: string; source: unknown; data: unknown }) => void)[] = [];
  const timers: (() => void)[] = [];
  const input = { value: "" };
  const form = { elements: { namedItem: (name: string) => (name === "lti_storage_value" ? input : null) }, submit: vi.fn() };
  const failed = { hidden: true };
  const location = { replace: vi.fn() };
  const win: Record<string, unknown> = {
    location,
    addEventListener: (_type: string, listener: (typeof listeners)[number]) => listeners.push(listener),
  };
  // A top-level window is its own parent, with no frame of that name.
  win.parent = options.framed === false ? win : parent;
  win.frames = {};
  const elements: Record<string, unknown> = {
    "lti-storage-config": { textContent: JSON.stringify(config) },
    "lti-storage-form": form,
    "lti-storage-failed": failed,
  };
  const document = { getElementById: (id: string) => elements[id] };
  new Function("window", "document", "crypto", "setTimeout", PLATFORM_STORAGE_SCRIPT)(win, document, globalThis.crypto, (fn: () => void, ms: number) => {
    expect(ms).toBe(PLATFORM_STORAGE_TIMEOUT_MS);
    timers.push(fn);
  });
  const reply = (data: unknown, origin = PLATFORM, source: unknown = target) => {
    for (const listener of listeners) listener({ origin, source, data });
  };
  return { target, parent, reply, timeout: () => timers.forEach((fn) => fn()), input, form, failed, location };
}

const PUT = { mode: "put", target: TARGET, origin: PLATFORM, key: "educateos_lti_s1", value: "secret-1", next: `${PLATFORM}/authorize?state=s1` };
const GET = { mode: "get", target: TARGET, origin: PLATFORM, key: "educateos_lti_s1" };

describe("platform storage client script", () => {
  it("puts the secret into the named frame, only for the platform's origin, then follows the redirect", () => {
    const run = runScript(PUT);
    expect(run.target.sent).toHaveLength(1);
    const [{ message, origin }] = run.target.sent as [FakeFrame["sent"][number]];
    expect(origin).toBe(PLATFORM);
    expect(message).toMatchObject({ subject: "lti.put_data", key: "educateos_lti_s1", value: "secret-1" });
    expect(message.message_id).toMatch(/^[0-9a-f]{32}$/);

    // Replies that are not the platform's answer to this request are ignored.
    run.reply({ ...message, subject: "lti.put_data.response" }, "https://attacker.example");
    run.reply({ ...message, subject: "lti.put_data.response" }, PLATFORM, run.parent);
    run.reply({ ...message, subject: "lti.put_data.response", message_id: "other" });
    expect(run.location.replace).not.toHaveBeenCalled();

    run.reply({ subject: "lti.put_data.response", message_id: message.message_id, key: "educateos_lti_s1", value: "secret-1" });
    expect(run.location.replace).toHaveBeenCalledWith(PUT.next);
    run.timeout();
    expect(run.location.replace).toHaveBeenCalledTimes(1);
  });

  it("follows the redirect anyway when the platform does not answer, so a cookie can still carry the launch", () => {
    const run = runScript(PUT);
    run.timeout();
    expect(run.location.replace).toHaveBeenCalledWith(PUT.next);
  });

  it("uses the parent window for `_parent`, and skips storage when the page is not framed", () => {
    const parented = runScript({ ...PUT, target: "_parent" });
    expect(parented.parent.sent).toHaveLength(1);
    const top = runScript(PUT, { framed: false });
    expect(top.location.replace).toHaveBeenCalledWith(PUT.next);
  });

  it("reads the secret back and re-posts the launch with it", () => {
    const run = runScript(GET);
    const [{ message, origin }] = run.target.sent as [FakeFrame["sent"][number]];
    expect(origin).toBe(PLATFORM);
    expect(message).toEqual({ subject: "lti.get_data", message_id: message.message_id, key: "educateos_lti_s1" });

    run.reply({ subject: "lti.get_data.response", message_id: message.message_id, key: "educateos_lti_s1", value: "forged" }, "https://attacker.example");
    run.reply({ subject: "lti.get_data.response", message_id: message.message_id, key: "another-key", value: "forged" });
    expect(run.form.submit).not.toHaveBeenCalled();

    run.reply({ subject: "lti.get_data.response", message_id: message.message_id, key: "educateos_lti_s1", value: "secret-1" });
    expect(run.input.value).toBe("secret-1");
    expect(run.form.submit).toHaveBeenCalledOnce();
  });

  it("shows the new-window notice when the platform reports an error or never answers", () => {
    const errored = runScript(GET);
    const [{ message }] = errored.target.sent as [FakeFrame["sent"][number]];
    errored.reply({ subject: "lti.get_data.response", message_id: message.message_id, key: "educateos_lti_s1", error: { code: "bad_request" } });
    expect(errored.failed.hidden).toBe(false);
    expect(errored.form.submit).not.toHaveBeenCalled();

    const silent = runScript(GET);
    silent.timeout();
    expect(silent.failed.hidden).toBe(false);
    expect(silent.form.submit).not.toHaveBeenCalled();
  });
});
