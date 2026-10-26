import type { DistrictDirectorySnapshot } from "@educateos/contracts";
import { SYNTHETIC_DISTRICTS } from "@educateos/fixtures";
import { DistrictInstance, FakeRosterProvider } from "./district.ts";
import { FakeAiProvider } from "./fake-ai.ts";
import { FakeIdentityProvider } from "./fake-identity.ts";

/** A booted district with handles to its fake providers, so tests and the CLI can mint tokens. */
export interface HarnessDistrict {
  /** The running district. */
  district: DistrictInstance;
  /** Its IdP. */
  identity: FakeIdentityProvider;
  /** Its model provider. */
  ai: FakeAiProvider;
}

/**
 * Boots each snapshot as its own district, with its own providers and state. Defaults to the six
 * demo districts, in harness port order. Fails if any district fails to boot.
 */
export async function bootHarness(
  snapshots: readonly DistrictDirectorySnapshot[] = SYNTHETIC_DISTRICTS,
): Promise<HarnessDistrict[]> {
  return Promise.all(
    snapshots.map(async (snapshot) => {
      const identity = new FakeIdentityProvider(snapshot.district.trustedIssuers[0]!);
      const ai = new FakeAiProvider();
      const district = await DistrictInstance.boot({ roster: new FakeRosterProvider(snapshot), identity, ai });
      return { district, identity, ai };
    }),
  );
}
