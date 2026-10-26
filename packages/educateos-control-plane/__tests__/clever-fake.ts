// A stand-in for Clever's token and identity endpoints, as the launch handler calls them. A code
// `launch-<district>` signs in a user of that Clever district; any other code is refused, as an
// expired or reused one would be. The token it issues names the code, so a suite can look for it.
import { CLEVER_LAUNCH_REDIRECT_URI, CLEVER_ME_URL, CLEVER_TOKEN_URL } from "../src/clever-launch.ts";

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
  if (input === CLEVER_ME_URL && init.method === "GET") {
    const match = /^Bearer clever-access-token-launch-(.+)$/.exec(headers.get("authorization") ?? "");
    if (match === null) return Response.json({ error: "unauthorized" }, { status: 401 });
    const district = match[1]!;
    return Response.json({
      type: "user",
      data: { id: "1".repeat(24), district, type: "user", authorized_by: "district" },
      links: [{ rel: "self", uri: "/me" }],
    });
  }
  return new Response("not found", { status: 404 });
}
