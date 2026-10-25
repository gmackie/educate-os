// Named identity scenarios the harness can replay, for tests and the CLI's `--check`.
import type { DistrictId, PrincipalId } from "@educateos/contracts";
import type { HarnessDistrict } from "./harness.ts";

/** Where one sign-in landed in one district. */
export interface DistrictSignIn {
  /** The district signed in to. */
  districtId: DistrictId;
  /** The principal the district's own IdP token resolved to there. */
  principalId: PrincipalId;
  /** That principal's display name. */
  displayName: string;
  /** How many of the other districts' tokens for the same subject this district refused. */
  foreignTokensRefused: number;
}

const me = (entry: HarnessDistrict, token: string) =>
  entry.district.fetch(new Request("http://district.harness/me", { headers: { authorization: `Bearer ${token}` } }));

/**
 * Signs one IdP subject in at every district through each district's own fake IdP and the full
 * sign-in path (`identityFromAccessPayload`, then `createDirectoryPrincipalResolver`), and also
 * presents each district with every other district's token for the same subject.
 *
 * With the synthetic fixtures and subject `user-1042` this is the Morgan Lee scenario (ADR-0003):
 * two teachers who share an email address and an IdP subject land on a different principal in
 * each district, and neither district accepts the other's token. Throws if a district refuses its
 * own IdP's token.
 */
export async function signInAcrossDistricts(districts: readonly HarnessDistrict[], subject: string): Promise<DistrictSignIn[]> {
  const tokens = await Promise.all(districts.map((entry) => entry.identity.issueToken(subject)));
  return Promise.all(districts.map(async (entry, i): Promise<DistrictSignIn> => {
    const response = await me(entry, tokens[i]!);
    if (response.status !== 200) throw new Error(`${entry.district.districtId} refused its own IdP's token for ${subject}`);
    const body = (await response.json()) as { principalId: PrincipalId; displayName: string };
    const foreign = tokens.filter((_, j) => j !== i);
    const refused = await Promise.all(foreign.map(async (token) => (await me(entry, token)).status === 401));
    return {
      districtId: entry.district.directory.district.id,
      principalId: body.principalId,
      displayName: body.displayName,
      foreignTokensRefused: refused.filter(Boolean).length,
    };
  }));
}

/** The fixtures' shared IdP subject for Morgan Lee, the teacher who works in both districts. */
export const MORGAN_LEE_SUBJECT = "user-1042";
