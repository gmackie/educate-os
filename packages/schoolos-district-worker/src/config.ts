// The district Worker's deployment configuration, read from the `DISTRICT_CONFIG` var (a JSON
// document) and validated strictly, so a malformed deployment fails closed rather than guessing.
// It holds what `DistrictAppOptions` takes from the deployment rather than from the district's
// stores. Everything administrators change later (configuration, funding allocations, the roster)
// is stored in the district's Durable Object, not here.
import { z } from "zod";
import { AuthorityMap, DistrictDirectorySnapshot } from "@schoolos/contracts";
import { CloudflareAccountFacts, FundingPoolSet, GovernedModel, UsdNano } from "@schoolos/ai-governance";
import { RetentionPolicy } from "@schoolos/workspaces";

/** The district Worker's configuration. */
export const DistrictWorkerConfig = z.strictObject({
  /**
   * The directory the district's object is seeded with the first time it starts: the district
   * itself, and at least the administrators who will import the roster. Once the object holds a
   * directory this is ignored, apart from the district's ID, which must still match it.
   */
  directory: DistrictDirectorySnapshot,
  /** Which system owns each directory record type. Defaults to the OneRoster roster for every type. */
  authority: AuthorityMap.optional(),
  /** The district's AI funding pools. Defaults to none, so no AI request is funded. */
  fundingPools: FundingPoolSet.optional(),
  /** The district's monthly cap on its course and personal pools' allocations together. */
  aiMonthlyDistrictCapUsdNano: UsdNano.optional(),
  /** The Cloudflare account the district's AI usage is billed to, for the net cost estimate. */
  cloudflareAccount: CloudflareAccountFacts.optional(),
  /** The district gateway's model catalog. */
  modelCatalog: z.array(GovernedModel).optional(),
  /** Hosts students may save links to as external artifacts. */
  approvedExternalHosts: z.array(z.string().min(1).max(253)).max(100).optional(),
  /** How long course workspaces are kept after their term closes. */
  retention: RetentionPolicy.optional(),
});
/** The district Worker's configuration. */
export type DistrictWorkerConfig = z.infer<typeof DistrictWorkerConfig>;

let cached: { text: string; config: DistrictWorkerConfig } | undefined;

/** Parses `DISTRICT_CONFIG`. The error names invalid fields only, never their values, which may be personal data. */
export function readDistrictWorkerConfig(text: string | undefined): DistrictWorkerConfig {
  if (text === undefined || text === "") throw new Error("DISTRICT_CONFIG is not set");
  if (cached?.text === text) return cached.config;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("DISTRICT_CONFIG is not JSON");
  }
  const parsed = DistrictWorkerConfig.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(root)"))].slice(0, 10);
    throw new Error(`DISTRICT_CONFIG is invalid at: ${fields.join(", ")}`);
  }
  cached = { text, config: parsed.data };
  return parsed.data;
}
