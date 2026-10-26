// The test Worker: the site Worker as `sites/educateos-io/worker.ts` composes it, with a fixed
// shell and the run's own Access key in place of the team's published certs.
import { createLocalJWKSet, type JWK } from "jose";
import { siteWorker } from "../src/worker.ts";

export { ControlPlane } from "../src/worker.ts";

const SHELL = { header: "<header>site header</header>", footer: "<footer>site footer</footer>" };

export default {
  fetch(request, env, ctx) {
    const keys = createLocalJWKSet({ keys: [JSON.parse(env.TEST_ACCESS_PUBLIC_JWK) as JWK] });
    return siteWorker(SHELL, { accessKeys: keys }).fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
