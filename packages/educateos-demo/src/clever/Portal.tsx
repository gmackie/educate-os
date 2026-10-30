import { useState } from "react";
import { Banner, Button, Loader, Text } from "@cloudflare/kumo";
import { BookOpenTextIcon, CalculatorIcon, GraduationCapIcon, SignOutIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { DistrictState } from "../DemoApp.tsx";
import type { CedarValleyDistrict } from "../districts/cedarvalley.ts";
import type { DistrictInfo, PersonaId } from "../districts/index.ts";
import { cleverFor, instantLogin, type InstantLoginHop, type InstantLoginResult } from "./instantLogin.ts";
import { UnderTheHood } from "./UnderTheHood.tsx";

/** A persona's sign-in through the portal: the district session it started, and how. */
export interface PortalSignIn {
  session: string;
  hops: readonly InstantLoginHop[];
}

interface CleverPortalProps {
  info: DistrictInfo;
  district: DistrictState;
  /** Who is signed in to the portal when it opens, as "Sign in as Elaine Park" opens hers. */
  initialPersonaId?: PersonaId;
  /** Called once the EducateOS tile has signed the persona in to the district. */
  onSignedIn: (persona: PersonaId, signIn: PortalSignIn) => void;
  /** Called when the visitor signs in to the portal as someone, for the tour. */
  onPortalSignIn?: (persona: PersonaId) => void;
  /** Called when the visitor clicks the EducateOS tile, for the tour. */
  onTileClick?: (persona: PersonaId) => void;
  /** Called with each hop of the launch as it happens, for the tour. */
  onHop?: (hop: InstantLoginHop) => void;
}

type LaunchState =
  | { status: "idle" }
  | { status: "launching" }
  | { status: "refused"; result: Extract<InstantLoginResult, { outcome: "refused" }> }
  | { status: "failed" };

/** Apps on the portal that aren't part of the demo, so EducateOS isn't alone on it. */
const PLACEHOLDER_TILES = [
  { name: "Reading app", icon: BookOpenTextIcon },
  { name: "Math practice", icon: CalculatorIcon },
] as const;

/**
 * Cedar Valley's way in: a neutral stand-in for the district's Clever portal. The visitor picks who
 * they are in Clever, then opens EducateOS from the portal's tiles, which runs Clever Instant Login
 * for real in the page (see `instantLogin.ts`). It deliberately looks like no particular portal.
 */
export const CleverPortal = ({ info, district, initialPersonaId, onSignedIn, onPortalSignIn, onTileClick, onHop }: CleverPortalProps) => {
  const [personaId, setPersonaId] = useState(initialPersonaId);
  const [launch, setLaunch] = useState<LaunchState>({ status: "idle" });
  const persona = info.personas.find((p) => p.id === personaId);

  const signInToPortal = (id: PersonaId | undefined) => {
    setPersonaId(id);
    setLaunch({ status: "idle" });
    if (id !== undefined) onPortalSignIn?.(id);
  };

  const open = async () => {
    if (persona === undefined || district.status !== "ready") return;
    onTileClick?.(persona.id);
    setLaunch({ status: "launching" });
    const booted = district.district as CedarValleyDistrict;
    try {
      const result = await instantLogin(cleverFor(booted), persona.subject, booted, onHop === undefined ? {} : { onHop });
      if (result.outcome === "signed-in") onSignedIn(persona.id, { session: result.session, hops: result.hops });
      else setLaunch({ status: "refused", result });
    } catch {
      setLaunch({ status: "failed" });
    }
  };

  return (
    <section aria-labelledby="clever-portal-heading" className="flex flex-col gap-4 rounded-lg border border-kumo-line bg-kumo-elevated p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Text as="h2" variant="heading">
          <span id="clever-portal-heading">{`${info.name} portal (simulated Clever portal)`}</span>
        </Text>
        {persona !== undefined && (
          <div className="flex items-center gap-2">
            <Text size="sm" variant="secondary">{`Signed in to the portal as ${persona.name}`}</Text>
            <Button size="sm" variant="ghost" icon={<SignOutIcon aria-hidden />} onClick={() => signInToPortal(undefined)}>
              Sign out of the portal
            </Button>
          </div>
        )}
      </div>
      {persona === undefined ? (
        <PortalSignInList info={info} onChoose={signInToPortal} />
      ) : (
        <>
          <Text variant="secondary">
            {`${persona.name}'s apps. Opening EducateOS signs ${persona.name} in with Clever Instant Login, run in your browser against simulated Clever.`}
          </Text>
          <ul aria-label="Apps" className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <li className="flex">
              <button
                type="button"
                onClick={() => void open()}
                disabled={district.status !== "ready" || launch.status === "launching"}
                aria-describedby="clever-portal-launch-status"
                className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base p-4 text-center hover:border-kumo-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:cursor-default disabled:opacity-70"
              >
                <GraduationCapIcon aria-hidden size={40} className="text-kumo-brand" />
                <Text as="span" variant="heading">EducateOS</Text>
              </button>
            </li>
            {PLACEHOLDER_TILES.map(({ name, icon: TileIcon }) => (
              <li key={name} aria-disabled="true" className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-kumo-line p-4 text-center opacity-60">
                <TileIcon aria-hidden size={40} className="text-kumo-subtle" />
                <Text as="span" size="sm" variant="secondary">{name}</Text>
                <Text as="span" size="xs" variant="secondary">Not part of the demo</Text>
              </li>
            ))}
          </ul>
          <div id="clever-portal-launch-status" role="status">
            {district.status === "booting" && <Text size="sm" variant="secondary">EducateOS opens once the district is set up.</Text>}
            {launch.status === "launching" && (
              <span className="flex items-center gap-2">
                <Loader size="sm" />
                <Text size="sm" variant="secondary">Signing in with Clever…</Text>
              </span>
            )}
          </div>
          {launch.status === "refused" && (
            <>
              <Banner variant="error" icon={<WarningCircleIcon aria-hidden />} title="EducateOS didn't sign you in" description={launch.result.reason} />
              <UnderTheHood hops={launch.result.hops} defaultOpen />
            </>
          )}
          {launch.status === "failed" && (
            <Banner variant="error" icon={<WarningCircleIcon aria-hidden />} title="The launch didn't run" description="Something went wrong in the page. Try again, or reset the demo." />
          )}
        </>
      )}
    </section>
  );
};

/** Who the visitor can be in Clever, to sign in to the portal as. */
const PortalSignInList = ({ info, onChoose }: { info: DistrictInfo; onChoose: (persona: PersonaId) => void }) => (
  <div className="flex flex-col gap-2">
    <Text as="h3" variant="heading">Who are you in Clever?</Text>
    <ul className="grid gap-3 sm:grid-cols-3">
      {info.personas.map((persona) => (
        <li key={persona.id} className="flex">
          <button
            type="button"
            onClick={() => onChoose(persona.id)}
            className="flex w-full cursor-pointer flex-col items-start gap-1 rounded-lg border border-kumo-line bg-kumo-base p-3 text-left hover:border-kumo-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
          >
            <Text as="span" variant="heading">{persona.role}</Text>
            <Text as="span" variant="secondary" size="sm">{persona.name}</Text>
          </button>
        </li>
      ))}
    </ul>
  </div>
);
