// What the Learning Home knows about the district origin it is served on (SCHO-260): the school's
// manifest, which frames every screen in the shared SchoolShell, and the pairing client the Connect
// phone page opens rooms with. A host that embeds the app (the Workshop's School app, the public
// demo) passes neither: it keeps its own frame, and nothing here is offered.
import { createContext, use, type ReactNode } from "react";
import type { PairingClient } from "@educateos/api-client";
import type { SchoolManifest } from "@educateos/shell";

/** The district origin around the app. */
export interface DistrictShell {
  /** The school's manifest (`useSchoolManifest().manifest`): its name, branding and features. */
  school: SchoolManifest;
}

const ShellContext = createContext<DistrictShell | undefined>(undefined);
const PairingContext = createContext<PairingClient | undefined>(undefined);

/** Provides the district shell and the pairing client, where the app has them. */
export const ShellProvider = ({ shell, pairing, children }: { shell: DistrictShell | undefined; pairing: PairingClient | undefined; children: ReactNode }) => (
  <ShellContext value={shell}>
    <PairingContext value={pairing}>{children}</PairingContext>
  </ShellContext>
);

/** The district shell, or undefined where a host embeds the app. */
export const useDistrictShell = (): DistrictShell | undefined => use(ShellContext);

/** The school's features, all off where a host embeds the app. */
export const useSchoolFeatures = (): SchoolManifest["features"] =>
  use(ShellContext)?.school.features ?? { ai: false, mobile: false, family: false };

/** The pairing client, or undefined where the app cannot pair phones. */
export const usePairing = (): PairingClient | undefined => use(PairingContext);
