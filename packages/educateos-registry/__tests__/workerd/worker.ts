import { DurableObject } from "cloudflare:workers";
import { DistrictId, Principal, RoleAssignment } from "@educateos/contracts";
import { blueprintCatalogApi, PersistentBlueprintCatalog, type BlueprintReviewActor } from "../../src/index.ts";

const district = DistrictId.parse("dst_demo");
// Test-only trusted credential directory. Production composes Access verification + district resolver.
const actors = new Map<string, BlueprintReviewActor>(["author", "reviewer", "admin", "foreign"].map((key) => {
  const districtId = key === "foreign" ? "dst_other" : district;
  const id = `prn_${key}`;
  return [key, {
    principal: Principal.parse({ id, districtId, kind: "staff", status: "active", displayName: "Private name", externalIdentities: [{ districtId, issuer: "https://identity.example", subject: id }] }),
    assignments: [RoleAssignment.parse({ principalId: id, role: key === "admin" ? "district-admin" : "teacher", scope: { level: "district", districtId }, source: "local-grant" })],
  }];
}));
/** Real SQLite host for request, restart and transactional tests. */
export class TestBlueprints extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    const catalog = new PersistentBlueprintCatalog(this.ctx.storage, district);
    return blueprintCatalogApi(catalog, async (r) => actors.get(r.headers.get("Authorization") ?? ""), () => new Date("2026-10-30T12:00:00Z"))(request);
  }
  async foreignStorage(): Promise<boolean> {
    try {
      new PersistentBlueprintCatalog(this.ctx.storage, DistrictId.parse("dst_other")).entries(actors.get("foreign")!);
      return true;
    } catch { return false; }
  }
  async rewrite(): Promise<boolean> {
    try { this.ctx.storage.sql.exec("DELETE FROM educateos_blueprint_commands"); return true; } catch { return false; }
  }
}
export default { fetch: () => new Response(null, { status: 404 }) };
