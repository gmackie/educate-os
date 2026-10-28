// The test Worker: the admin Worker with the run's own Access key in place of the team's certs.
// Its district calls go nowhere (the API flows are driven through `handleAdminRequest` with a fake
// district in support.ts); this entry exercises sign-in, the edition and the routes' gates.
import { createLocalJWKSet, type JWK } from "jose";
import { adminWorker, type AdminEnv } from "../src/worker/index.ts";

export default {
  fetch(request, env, ctx) {
    const keys = createLocalJWKSet({ keys: [JSON.parse((env as Cloudflare.Env).TEST_ACCESS_PUBLIC_JWK) as JWK] });
    return adminWorker({ accessKeys: keys, fetchDistrict: async () => new Response(null, { status: 503 }) }).fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<AdminEnv>;
