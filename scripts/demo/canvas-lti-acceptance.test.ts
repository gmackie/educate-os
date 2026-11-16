import assert from "node:assert/strict";
import { test } from "node:test";
import { acceptedLaunch, isContentPicker, LaunchBrowser, pageForms } from "./canvas-lti-acceptance.ts";

/** The district's launch page, as packages/educateos-district-worker/src/lti.ts renders it. */
const launchPage = (activity?: string) => [
  "<!doctype html><html><head><style>h1{font-size:1.4rem}</style></head><body>",
  "<h1>Phones in the Classroom</h1>",
  "<p>Signed in to EducateOS as <strong>Kofi Mensah</strong> (student), in English 8, Period 2.</p>",
  activity === undefined ? "<p>This link does not open an EducateOS activity.</p>" : `<p>Activity <code>${activity}</code>.</p>`,
  '<p class="meta">Launch accepted: LtiResourceLinkRequest; offering <code>off_nf-eng8-fall-p2</code>;',
  " course services: gradebook (AGS) roster (NRPS)</p></body></html>",
].join("");

test("reads what EducateOS accepted, including the activity a deep link opened", () => {
  assert.deepEqual(acceptedLaunch(launchPage("act_33c0")), { name: "Kofi Mensah", kind: "student", messageType: "LtiResourceLinkRequest", offeringId: "off_nf-eng8-fall-p2", activityId: "act_33c0", services: ["AGS", "NRPS"] });
  assert.equal(acceptedLaunch(launchPage())!.activityId, undefined);
  assert.equal(acceptedLaunch("<p>Canvas Login</p>"), undefined);
});

test("parses protocol forms and the picker's labelled checkboxes", () => {
  const [picker] = pageForms('<form method="post" action="https://district.schoolos.gmac.io/lti/deep-link?a=1&amp;b=2"><input type="hidden" name="session" value="s&amp;1"><ul><li><label><input type="checkbox" name="activity" value="act_1"> Tide &amp; Pools</label></li></ul></form>');
  assert.ok(isContentPicker(picker!));
  // Canvas's own login form has a checkbox too ("Stay signed in"); it is not the picker.
  const [login] = pageForms('<form action="/login/canvas" method="post"><input name="pseudonym_session[unique_id]"><input type="checkbox" name="pseudonym_session[remember_me]" value="1"></form>');
  assert.equal(isContentPicker(login!), false);
  assert.deepEqual(picker, { action: "https://district.schoolos.gmac.io/lti/deep-link?a=1&b=2", method: "post", fields: [["session", "s&1"]], boxes: [{ name: "activity", value: "act_1", label: "Tide & Pools" }] });
});

test("follows a launch through OIDC forms and redirects, carrying each host's own cookies", async () => {
  const seen: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const cookie = new Headers(init?.headers).get("cookie") ?? "";
    seen.push(`${init?.method} ${url.hostname}${url.pathname} ${cookie.includes("CF_Authorization") ? "access" : ""}`.trim());
    if (url.pathname === "/courses/10/external_tools/11") {
      return new Response('<form action="https://district.schoolos.gmac.io/lti/login" method="post"><input name="iss" value="https://canvas.mackie.house"><input name="login_hint" value="h"></form>', { headers: { "set-cookie": "_normandy_session=abc; path=/" } });
    }
    if (url.pathname === "/lti/login") return new Response(null, { status: 302, headers: { location: "https://canvas.mackie.house/api/lti/authorize_redirect?state=s" } });
    if (url.pathname === "/api/lti/authorize_redirect") {
      assert.match(cookie, /_normandy_session=abc/);
      return new Response('<form action="https://district.schoolos.gmac.io/lti/launch" method="post"><input name="id_token" value="jwt"><input name="state" value="s"></form>');
    }
    if (url.pathname === "/lti/launch") { assert.equal(String(init?.body), "id_token=jwt&state=s"); assert.equal(cookie, ""); return new Response(launchPage()); }
    throw new Error(`unexpected ${url}`);
  };
  const { page, reached } = await new LaunchBrowser("access-cookie", transport)
    .follow("https://canvas.mackie.house/courses/10/external_tools/11?launch_type=course_navigation", (p) => acceptedLaunch(p) !== undefined);
  assert.ok(reached);
  assert.equal(acceptedLaunch(page)!.name, "Kofi Mensah");
  assert.deepEqual(seen, ["GET canvas.mackie.house/courses/10/external_tools/11 access", "POST district.schoolos.gmac.io/lti/login", "GET canvas.mackie.house/api/lti/authorize_redirect access", "POST district.schoolos.gmac.io/lti/launch"]);
});

test("refuses to follow a launch anywhere but Canvas and the district tool", async () => {
  const transport: typeof fetch = async () => new Response('<form action="https://evil.example/collect" method="post"><input name="id_token" value="jwt"></form>');
  await assert.rejects(new LaunchBrowser("c", transport).follow("https://canvas.mackie.house/x", () => false), /Refusing to visit evil.example/);
  await assert.rejects(new LaunchBrowser("c", transport).follow("http://canvas.mackie.house/x", () => false), /Refusing/);
});

test("fills the content picker with the chosen activities and posts the session", async () => {
  let posted = "";
  const transport: typeof fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/lti/deep-link") { posted = String(init?.body); return new Response("<p>New Content From App</p>"); }
    return new Response('<form method="post" action="https://district.schoolos.gmac.io/lti/deep-link"><input type="hidden" name="session" value="s1"><label><input type="checkbox" name="activity" value="a1"> One</label><label><input type="checkbox" name="activity" value="a2"> Two</label><label><input type="checkbox" name="activity" value="a3"> Three</label></form>');
  };
  const { reached } = await new LaunchBrowser("c", transport).follow("https://canvas.mackie.house/picker", (p) => p.includes("New Content"), (form) => form.boxes.slice(0, 2));
  assert.ok(reached);
  assert.equal(posted, "session=s1&activity=a1&activity=a2");
});

test("retries a connection that never opened, but not a failure after the request was sent", async () => {
  const failing = (code: string, times: number) => {
    let calls = 0;
    const transport: typeof fetch = async () => {
      calls++;
      if (calls <= times) throw Object.assign(new TypeError("fetch failed"), { cause: { code } });
      return new Response("<p>done</p>");
    };
    return { transport, calls: () => calls };
  };
  const flaky = failing("ETIMEDOUT", 2);
  assert.ok((await new LaunchBrowser("c", flaky.transport).follow("https://canvas.mackie.house/x", (p) => p.includes("done"))).reached);
  assert.equal(flaky.calls(), 3);
  const down = failing("UND_ERR_CONNECT_TIMEOUT", 3);
  await assert.rejects(new LaunchBrowser("c", down.transport).follow("https://canvas.mackie.house/x", () => true), /UND_ERR_CONNECT_TIMEOUT/);
  const reset = failing("ECONNRESET", 1);
  await assert.rejects(new LaunchBrowser("c", reset.transport).follow("https://canvas.mackie.house/x", () => true), /ECONNRESET/);
  assert.equal(reset.calls(), 1);
});
