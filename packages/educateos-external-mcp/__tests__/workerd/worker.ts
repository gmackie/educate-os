import { generateKeyPair, type GenerateKeyPairResult } from "jose";
import { McpDistrict } from "../../src/worker.ts";
import worker from "../../src/worker.ts";
/** Route production ctx.exports to the test subclass without changing production authority. */
export default { fetch(request, env, ctx) {
  return worker.fetch(request, env, { ...ctx, exports: { McpDistrict: env.MCP_DISTRICT } });
} };
let pair: Promise<GenerateKeyPairResult> | undefined;
/** The synthetic issuer's key pair, made on first use (workerd forbids crypto at global scope). */
export function testIssuerKeys(): Promise<GenerateKeyPairResult> {
  return (pair ??= generateKeyPair("RS256"));
}
/** Synthetic issuer injected only by the workerd harness. */
export class TestMcpDistrict extends McpDistrict {
  protected override issuerKeys() { return async () => (await testIssuerKeys()).publicKey; }
}
