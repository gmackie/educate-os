// Test worker: the production fetch handler and district object with two seams replaced. Admin
// assertions are verified against this run's Access key rather than the team's published certs, and
// an LTI platform fetches the test tool's JWKS from the test's key rather than the internet.
import { createLocalJWKSet, type JWK } from "jose";
import { createWorker } from "../src/worker.ts";
import { DemoFakesDistrict as DeployedDistrict } from "../src/district.ts";
import { TOOL } from "./constants.ts";

/** The district object as deployed, apart from where a platform fetches tool keys. */
export class DemoFakesDistrict extends DeployedDistrict {
  protected override async toolFetch(input: RequestInfo | URL): Promise<Response> {
    const url = new Request(input).url;
    if (url === `${TOOL}/lti/jwks`) return Response.json({ keys: [JSON.parse((this.env as unknown as Cloudflare.Env).TEST_TOOL_PUBLIC_JWK) as JWK] });
    return new Response("not found", { status: 404 });
  }
}

export default {
  fetch(request, env, ctx) {
    const keys = createLocalJWKSet({ keys: [JSON.parse(env.TEST_ACCESS_PUBLIC_JWK) as JWK] });
    return createWorker({ accessKeys: keys }).fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
