import { createLocalJWKSet } from "jose";
import { McpDistrict } from "../../src/worker.ts";
import worker from "../../src/worker.ts";
/** Route production ctx.exports to the test subclass without changing production authority. */
export default { fetch(request, env, ctx) {
  return worker.fetch(request, env, { ...ctx, exports: { McpDistrict: env.MCP_DISTRICT } });
} };
/** Synthetic issuer injected only by the workerd harness. */
export class TestMcpDistrict extends McpDistrict {
  protected override issuerKeys() { return createLocalJWKSet({ keys: [] }); }
}
