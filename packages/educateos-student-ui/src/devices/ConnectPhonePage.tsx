// Connect phone (SCHO-260, plan §4, pairing contract v2): opens a pairing room on the district,
// shows its QR for the EducateOS app to scan, and lets the person approve the phone that claims it
// once both screens show the same 8-character code. The district then registers the phone as one
// of this person's devices and seals its credential to the phone's key; nothing secret passes
// through this page beyond the room's QR.
//
//   waiting ──(phone scans)──▶ claimed ──Approve──▶ approved
//      │                          ├──────Deny────▶ denied
//      └──────(2 minutes)─────────┴──(2 minutes)─▶ expired ──Try again──▶ waiting
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Banner, Button, Empty, Link, LinkButton, Loader, Surface, Text } from "@cloudflare/kumo";
import { AndroidLogoIcon, AppleLogoIcon, CheckCircleIcon, ProhibitIcon, TimerIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { encode } from "uqr";
import { DistrictApiError, type PairingDevice, type PairingRoom, type PairingStatus } from "@educateos/api-client";
import { messageFor } from "../api.tsx";
import { useAnnounce } from "../AppContext.tsx";
import { DEVICES_PATH } from "./paths.ts";
import { useDistrictShell, usePairing } from "../shell.tsx";

/** How often the page asks the district where the room is, while the page is visible. */
export const PAIRING_POLL_MS = 1500;

/**
 * Where people without the app get it. Placeholders until the store listings are live: the
 * "get the app" page on mobile.educateos.io, which sends each platform to its store.
 */
export const APP_STORE_URL = "https://mobile.educateos.io/get?platform=ios";
export const PLAY_STORE_URL = "https://mobile.educateos.io/get?platform=android";

/** Where the page is in pairing a phone. */
export type PairingPhase =
  | { kind: "starting" }
  /** The district would not open a room. */
  | { kind: "failed"; message: string }
  | { kind: "waiting"; room: PairingRoom }
  | { kind: "claimed"; room: PairingRoom; code: string; device: PairingDevice | undefined; acting?: "approve" | "deny"; error?: string }
  | { kind: "approved"; device: PairingDevice | undefined }
  | { kind: "denied" }
  | { kind: "expired" };

/** The phase a room's status moves `phase` to. A phase the person already moved on from stays. */
export const advance = (phase: PairingPhase, status: PairingStatus): PairingPhase => {
  if (phase.kind !== "waiting" && phase.kind !== "claimed") return phase;
  // While an approval or denial is on its way, its answer decides what comes next.
  if (phase.kind === "claimed" && phase.acting !== undefined) return phase;
  switch (status.state) {
    case "waiting":
      return phase;
    case "claimed":
      if (status.code === undefined) return phase;
      return phase.kind === "claimed" && phase.code === status.code
        ? phase
        : { kind: "claimed", room: phase.room, code: status.code, device: status.device };
    case "approved":
      return { kind: "approved", device: phase.kind === "claimed" ? (phase.device ?? status.device) : status.device };
    case "denied":
      return { kind: "denied" };
    case "expired":
      return { kind: "expired" };
  }
};

/** A code as a screen reader should spell it: one character at a time. */
export const spellCode = (code: string): string => code.split("").join(" ");

const deviceName = (device: PairingDevice | undefined) => device?.label ?? "Your phone";

/** What the live region says as the page reaches each phase. */
const announcementFor = (phase: PairingPhase): string | undefined => {
  switch (phase.kind) {
    case "starting":
      return undefined;
    case "failed":
      return `We couldn't start connecting a phone. ${phase.message}`;
    case "waiting":
      return "Scan the code with the EducateOS app on your phone.";
    case "claimed":
      return `${deviceName(phase.device)} wants to connect. Check that it shows the code ${spellCode(phase.code)}, then approve it.`;
    case "approved":
      return `${deviceName(phase.device)} is connected`;
    case "denied":
      return "The phone was not connected.";
    case "expired":
      return "The code expired. Try again to get a new one.";
  }
};

/** A QR code drawn as one SVG path, from `uqr`'s module matrix. */
export const QrCode = ({ value, label }: { value: string; label: string }) => {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    let d = "";
    qr.data.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x},${y}h1v1h-1z`;
    }));
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" className="size-56 rounded-lg bg-white sm:size-64">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
};

/** The seconds left until `expiresAt`, counting down once a second. */
const useSecondsLeft = (expiresAt: string | undefined): number | undefined => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return expiresAt === undefined ? undefined : Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
};

const minutesAndSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const StoreLinks = () => (
  <div className="flex flex-col gap-2">
    <Text variant="secondary">Don't have the app yet?</Text>
    <div className="flex flex-wrap gap-2">
      <LinkButton href={APP_STORE_URL} variant="secondary" icon={<AppleLogoIcon aria-hidden />} target="_blank" rel="noopener noreferrer">
        Download on the App Store<span className="sr-only"> (opens in a new tab)</span>
      </LinkButton>
      <LinkButton href={PLAY_STORE_URL} variant="secondary" icon={<AndroidLogoIcon aria-hidden />} target="_blank" rel="noopener noreferrer">
        Get it on Google Play<span className="sr-only"> (opens in a new tab)</span>
      </LinkButton>
    </div>
  </div>
);

/** Connect phone. */
export const ConnectPhonePage = () => {
  const pairing = usePairing();
  const school = useDistrictShell()?.school.name ?? "your school";
  const announce = useAnnounce();
  const [phase, setPhase] = useState<PairingPhase>({ kind: "starting" });
  // Only the newest room counts: a room opened earlier (a double click, StrictMode's second mount)
  // was closed by the district when the next one opened.
  const attempt = useRef(0);

  const start = useCallback(async () => {
    if (pairing === undefined) return;
    const mine = ++attempt.current;
    setPhase({ kind: "starting" });
    try {
      const room = await pairing.createRoom();
      if (attempt.current === mine) setPhase({ kind: "waiting", room });
    } catch (error) {
      if (attempt.current === mine) setPhase({ kind: "failed", message: messageFor(error) });
    }
  }, [pairing]);

  useEffect(() => {
    void start();
    return () => {
      attempt.current += 1;
    };
  }, [start]);

  // Polls while there is a room to watch and the page is visible.
  const roomId = phase.kind === "waiting" || phase.kind === "claimed" ? phase.room.room : undefined;
  useEffect(() => {
    if (pairing === undefined || roomId === undefined) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          const status = await pairing.status(roomId);
          if (!stopped) setPhase((current) => (current.kind === "waiting" || current.kind === "claimed") && current.room.room === roomId ? advance(current, status) : current);
        } catch (error) {
          // A room the district no longer knows has expired; anything else is tried again next time.
          if (!stopped && error instanceof DistrictApiError && error.code === "not-found") {
            setPhase((current) => (current.kind === "waiting" || current.kind === "claimed") && current.room.room === roomId ? { kind: "expired" } : current);
          }
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), PAIRING_POLL_MS);
    };
    timer = setTimeout(() => void tick(), PAIRING_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pairing, roomId]);

  // An unclaimed room closes when its time is up, whether or not the district has said so yet.
  const secondsLeft = useSecondsLeft(phase.kind === "waiting" ? phase.room.expiresAt : undefined);
  useEffect(() => {
    if (secondsLeft === 0) setPhase((current) => (current.kind === "waiting" ? { kind: "expired" } : current));
  }, [secondsLeft]);

  // Each phase is announced once, as it is reached.
  const announcement = announcementFor(phase);
  const announced = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (announcement !== undefined && announcement !== announced.current) announce(announcement);
    announced.current = announcement;
  }, [announcement, announce]);

  const decide = async (decision: "approve" | "deny") => {
    if (pairing === undefined || phase.kind !== "claimed") return;
    const claimed = phase;
    setPhase({ ...claimed, acting: decision, error: undefined });
    try {
      if (decision === "approve") await pairing.approve(claimed.room.room);
      else await pairing.deny(claimed.room.room);
      setPhase(decision === "approve" ? { kind: "approved", device: claimed.device } : { kind: "denied" });
    } catch (error) {
      if (error instanceof DistrictApiError && error.code === "not-found") setPhase({ kind: "expired" });
      else setPhase({ ...claimed, acting: undefined, error: messageFor(error) });
    }
  };

  const heading = <Text variant="heading" size="lg" as="h1">Connect your phone</Text>;
  if (pairing === undefined) {
    return (
      <div className="flex flex-col gap-6">
        {heading}
        <Empty title="Connecting a phone isn't available here" description="Open your school's website on a computer to connect a phone." />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {heading}
      <Text variant="secondary">{`Get ${school} on your phone. Scan once and you're signed in, with no password on the phone.`}</Text>
      <Surface className="flex flex-col items-center gap-5 rounded-xl p-6 text-center" data-phase={phase.kind}>
        {phase.kind === "starting" ? (
          <div role="status" className="flex items-center gap-2">
            <Loader size="sm" />
            <Text>Getting a code for your phone</Text>
          </div>
        ) : phase.kind === "failed" ? (
          <div role="alert" className="flex w-full flex-col gap-3">
            <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title="We couldn't start connecting a phone" description={phase.message} />
            <div><Button onClick={() => void start()}>Try again</Button></div>
          </div>
        ) : phase.kind === "waiting" ? (
          <>
            <QrCode value={phase.room.qr} label="QR code for the EducateOS app to scan" />
            <ol className="flex max-w-md list-decimal flex-col gap-1 pl-6 text-left">
              <li>Open the EducateOS app on your phone.</li>
              <li>Choose <strong>Scan school code</strong>, or scan this with the phone's camera.</li>
              <li>Check that both screens show the same code, then approve the phone here.</li>
            </ol>
            <Text variant="secondary">
              <span className="flex items-center gap-1">
                <TimerIcon aria-hidden />
                {/* The countdown is read on demand, not announced every second. */}
                <span>{`This code expires in ${minutesAndSeconds(secondsLeft ?? 0)}`}</span>
              </span>
            </Text>
          </>
        ) : phase.kind === "claimed" ? (
          <>
            <Text variant="heading" as="h2">{`${deviceName(phase.device)} wants to connect`}</Text>
            {phase.device === undefined ? null : (
              <Text variant="secondary">{[phase.device.model, `app ${phase.device.appVersion}`].filter((part) => part !== "").join(" · ")}</Text>
            )}
            <div role="group" aria-labelledby="pairing-code-label" className="flex flex-col items-center gap-1">
              <Text variant="secondary"><span id="pairing-code-label">Check that your phone shows this code</span></Text>
              <p className="font-mono text-4xl font-semibold tracking-[0.2em] text-kumo-strong sm:text-5xl">
                <span aria-hidden>{`${phase.code.slice(0, 4)}·${phase.code.slice(4)}`}</span>
                <span className="sr-only">{spellCode(phase.code)}</span>
              </p>
            </div>
            {phase.error === undefined ? null : (
              <div role="alert" className="w-full">
                <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title="That didn't work" description={phase.error} />
              </div>
            )}
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" loading={phase.acting === "approve"} disabled={phase.acting !== undefined} onClick={() => void decide("approve")}>
                Approve
              </Button>
              <Button variant="secondary" loading={phase.acting === "deny"} disabled={phase.acting !== undefined} onClick={() => void decide("deny")}>
                Deny
              </Button>
            </div>
            <Text variant="secondary" size="sm">If the codes don't match, deny it: someone else may have scanned your code.</Text>
          </>
        ) : phase.kind === "approved" ? (
          <>
            <CheckCircleIcon aria-hidden size={48} weight="fill" className="text-kumo-success" />
            <Text variant="heading" as="h2">{`${deviceName(phase.device)} is connected`}</Text>
            <Text>You're signed in on your phone. You can sign it out any time from Your devices.</Text>
            <Link href={DEVICES_PATH}>Your devices</Link>
          </>
        ) : phase.kind === "denied" ? (
          <>
            <ProhibitIcon aria-hidden size={48} className="text-kumo-subtle" />
            <Text variant="heading" as="h2">The phone was not connected</Text>
            <Button onClick={() => void start()}>Connect a different phone</Button>
          </>
        ) : (
          <>
            <TimerIcon aria-hidden size={48} className="text-kumo-subtle" />
            <Text variant="heading" as="h2">This code expired</Text>
            <Text>Codes last two minutes, so no one else can use one later.</Text>
            <Button variant="primary" onClick={() => void start()}>Try again</Button>
          </>
        )}
      </Surface>
      {phase.kind === "approved" ? null : <StoreLinks />}
    </div>
  );
};
