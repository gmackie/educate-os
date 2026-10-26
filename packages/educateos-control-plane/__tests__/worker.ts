// The test Worker: the site Worker as `sites/educateos-io/worker.ts` composes it, with a fixed
// shell, the run's own Access key in place of the team's published certs, and a fake Clever.
import { createLocalJWKSet, type JWK } from "jose";
import { siteWorker } from "../src/worker.ts";
import { fakeClever } from "./clever-fake.ts";

export { ControlPlane } from "../src/worker.ts";

// An installation's address names what its probe sees, so no test reaches the network.
async function probe(hostname: string) {
  return hostname.startsWith("down") ? { state: "unreachable" as const } : { state: "responding" as const };
}

const SHELL = { header: "<header>site header</header>", footer: "<footer>site footer</footer>" };

export default {
  fetch(request, env, ctx) {
    const keys = createLocalJWKSet({ keys: [JSON.parse(env.TEST_ACCESS_PUBLIC_JWK) as JWK] });
    return siteWorker(SHELL, { accessKeys: keys, probe, cleverFetch: fakeClever }).fetch!(request, env, ctx);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
