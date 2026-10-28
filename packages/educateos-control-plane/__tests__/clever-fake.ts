// A stand-in for Clever's token and identity endpoints, as the launch handler calls them. A code
// `launch-<district>` signs in a user of that Clever district; `launch-teacher-<district>` signs one
// in through a teacher's authorization, whose /me names no district, so it is read from /users; and
// `launch-demo-<district>` is a sandbox demo login: a teacher who authorized the app themselves, for
// whom Clever has no district at all (the user record's roles carry only a legacy ID, and the
// district record is a 404), whatever the code names. Any
// other code is refused, as an expired or reused one would be. The token it issues names the code,
// so a suite can look for it.
import { CLEVER_LAUNCH_REDIRECT_URI, CLEVER_ME_URL, CLEVER_TOKEN_URL, CLEVER_USERS_URL } from "../src/clever-launch.ts";

/** The Clever user ID the fake signs in. */
export const CLEVER_USER = "1".repeat(24);

/** The test Clever app's client. */
export const CLEVER_CLIENT = { clientId: "test-clever-client", clientSecret: "test-clever-secret" };

/** The access token the fake issues for a code. */
export const tokenFor = (code: string) => `clever-access-token-${code}`;

/** A Clever that answers as the documented endpoints do, checking what the handler sends. */
export async function fakeClever(input: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (input === CLEVER_TOKEN_URL && init.method === "POST") {
    const basic = `Basic ${btoa(`${CLEVER_CLIENT.clientId}:${CLEVER_CLIENT.clientSecret}`)}`;
    const form = new URLSearchParams(String(init.body));
    const code = form.get("code") ?? "";
    if (headers.get("authorization") !== basic || form.get("grant_type") !== "authorization_code" ||
        form.get("redirect_uri") !== CLEVER_LAUNCH_REDIRECT_URI || !code.startsWith("launch-")) {
      return Response.json({ error: "invalid_grant" }, { status: 401 });
    }
    return Response.json({ access_token: tokenFor(code), token_type: "bearer" });
  }
  const match = /^Bearer clever-access-token-launch-(teacher-|demo-)?(.+)$/.exec(headers.get("authorization") ?? "");
  if ((input === CLEVER_ME_URL || input.startsWith(`${CLEVER_USERS_URL}/`)) && init.method === "GET" && match === null) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (input === CLEVER_ME_URL && init.method === "GET") {
    const [, kind, district] = match!;
    const data = kind === undefined
      ? { id: CLEVER_USER, district, type: "user", authorized_by: "district" }
      : { id: CLEVER_USER, type: "user", authorized_by: "teacher" };
    return Response.json({ type: "user", data, links: [{ rel: "self", uri: "/me" }, { rel: "canonical", uri: `/v3.0/users/${CLEVER_USER}` }] });
  }
  if (input === `${CLEVER_USERS_URL}/${CLEVER_USER}` && init.method === "GET") {
    const [, kind, district] = match!;
    return Response.json({
      data: { id: CLEVER_USER, email: "teacher@example.org", name: {}, roles: { teacher: kind === "demo-" ? { legacy_id: CLEVER_USER } : { district } } },
      links: [{ rel: "self", uri: `/v3.0/users/${CLEVER_USER}` }],
    });
  }
  return new Response("not found", { status: 404 });
}
