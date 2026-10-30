// The browser side of phone pairing (SCHO-260, pairing contract v2, ADR-0014): the signed-in web
// session opens a room on the district, shows its QR to the phone, watches the room, and approves
// or denies the phone that claims it. The phone's side (claim, collect) is the mobile app's.
//
// These routes are not in the district app's route table: the district serves them at
// `/api/pair/*` beside it, so their shapes are written down here, exactly as the contract has them.
import { z } from "zod";
import { EducateOsErrorBody, type ErrorCode } from "@educateos/contracts";
import { DistrictApiError, type DistrictApiClientOptions, type RouteResponse } from "./client.ts";

/** One of a person's signed-in devices, as Your devices lists it (`me.devices`, SCHO-261). */
export type DeviceView = RouteResponse<"me.devices">["devices"][number];

const ROOM = /^[A-Za-z0-9_-]{8,128}$/;

/** A room the web session opened: what the QR carries, and when the room closes unclaimed. */
export const PairingRoom = z.object({
  room: z.string().regex(ROOM),
  secret: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/),
  /** The full QR URL: `https://mobile.educateos.io/j#o=<origin>&r=<room>&s=<secret>`. */
  qr: z.url({ protocol: /^https$/ }),
  expiresAt: z.iso.datetime({ offset: true }),
});
/** A room the web session opened. */
export type PairingRoom = z.infer<typeof PairingRoom>;

/** Where a room is. */
export const PairingState = z.enum(["waiting", "claimed", "approved", "denied", "expired"]);
/** Where a room is. */
export type PairingState = z.infer<typeof PairingState>;

/** The phone that claimed a room, as it describes itself. */
export const PairingDevice = z.object({
  label: z.string(),
  platform: z.string(),
  model: z.string(),
  appVersion: z.string(),
});
/** The phone that claimed a room. */
export type PairingDevice = z.infer<typeof PairingDevice>;

/** A room's status, as its creator sees it. */
export const PairingStatus = z.object({
  state: PairingState,
  /** The 8-character code both screens show, once a phone has claimed the room. */
  code: z.string().regex(/^[A-Z0-9]{8}$/).optional(),
  device: PairingDevice.optional(),
});
/** A room's status. */
export type PairingStatus = z.infer<typeof PairingStatus>;

/** What approving a phone answers: the device it became. */
export const PairingApproval = z.object({ deviceId: z.string().min(1) });
/** What approving a phone answers. */
export type PairingApproval = z.infer<typeof PairingApproval>;

/** The web session's pairing calls. Each rejects with a {@link DistrictApiError}. */
export interface PairingClient {
  /** Opens a room, closing any room this person still had open. */
  createRoom(): Promise<PairingRoom>;
  /** Where the room is, and which phone claimed it. */
  status(room: string): Promise<PairingStatus>;
  /** Lets the phone that claimed the room in: the district registers it as one of this person's devices. */
  approve(room: string): Promise<PairingApproval>;
  /** Turns the phone that claimed the room away. */
  deny(room: string): Promise<void>;
}

/** The error code a status stands for, when the body is not a district error. */
const codeForStatus = (status: number): ErrorCode => {
  if (status === 0 || (status >= 300 && status < 400) || status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404 || status === 410) return "not-found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "validation-failed";
  return "unavailable";
};

/** Creates the pairing client for the district at `options.baseUrl`, signed in as `options` says. */
export function createPairingClient(options: DistrictApiClientOptions): PairingClient {
  const send = options.fetch ?? ((request: Request) => fetch(request));

  const request = async <T>(method: "GET" | "POST", path: string, schema: z.ZodType<T> | undefined): Promise<T> => {
    const headers = new Headers({ accept: "application/json" });
    const token = typeof options.token === "function" ? await options.token() : options.token;
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    if (method === "POST") headers.set("content-type", "application/json");
    // Not following redirects: on a district host the only one is Access sending an ended session
    // to its login page, which is a sign-in to report, not a pairing answer to parse.
    const response = await send(new Request(new URL(path, options.baseUrl), {
      method,
      headers,
      redirect: "manual",
      ...(method === "POST" ? { body: "{}" } : {}),
    }));
    const body: unknown = await response.json().catch(() => undefined);
    const correlationId = response.headers.get("x-correlation-id")?.slice(0, 128);
    const correlation = correlationId === undefined || correlationId === "" ? {} : { correlationId };
    if (!response.ok) {
      const error = EducateOsErrorBody.safeParse(body);
      throw new DistrictApiError(response.status, error.success
        ? error.data
        : { code: codeForStatus(response.status), message: `The district answered ${response.status}.`, ...correlation });
    }
    if (schema === undefined) return undefined as T;
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new DistrictApiError(response.status, { code: "unavailable", message: `The district's pairing answer to ${method} ${path} did not match the contract.`, ...correlation });
    }
    return parsed.data;
  };

  const roomPath = (room: string, action?: string) => {
    if (!ROOM.test(room)) throw new DistrictApiError(400, { code: "validation-failed", message: "That pairing room is not one the district opened." });
    return `/api/pair/rooms/${room}${action === undefined ? "" : `/${action}`}`;
  };

  return {
    createRoom: () => request("POST", "/api/pair/rooms", PairingRoom),
    status: async (room) => request("GET", roomPath(room, "status"), PairingStatus),
    approve: async (room) => request("POST", roomPath(room, "approve"), PairingApproval),
    deny: async (room) => {
      await request("POST", roomPath(room, "deny"), undefined);
    },
  };
}
