import { DistrictId, ErrorCode, SchoolOsError, SchoolOsErrorBody, type Caller } from "@schoolos/contracts";
import { z } from "zod";
import type { PortableIdentityLinkStore } from "./identity-link.ts";
import type { SignedEnvelope } from "@schoolos/fleet";
import type { ImportResult, StudentArchiveImporter, TransferChannelKind } from "./importer.ts";
import { acceptConsentRevocationNotice, type RevocationAcceptance } from "./revocation.ts";
import { decodeTransfer, encodeTransfer, MAX_TRANSFER_BYTES, TRANSFER_FILE_MEDIA_TYPE, type TransferPackage } from "./transfer.ts";

/**
 * How a transfer package leaves the source district. Both channels go straight from the source to
 * the learner or to the destination: the root is never on the path (ADR-0001), and neither
 * channel is given a way to reach it.
 */
export interface TransferChannel {
  readonly kind: TransferChannelKind;
  /** Sends a package: hands the learner a file, or pushes it to the destination. */
  send(pkg: TransferPackage): Promise<TransferDelivery>;
}

/** What sending produced: a file for the learner to download, or the destination's answer to a push. */
export type TransferDelivery =
  | { kind: "file"; fileName: string; mediaType: string; bytes: Uint8Array<ArrayBuffer> }
  | { kind: "pushed"; outcome: ImportResult["outcome"]; imported: number; skipped: number };

/** The learner downloads the package as a file and uploads it at the destination. */
export class LearnerCarriedChannel implements TransferChannel {
  readonly kind = "learner-carried";

  async send(pkg: TransferPackage): Promise<TransferDelivery> {
    return { kind: "file", fileName: `transfer-${pkg.consent.exportId}.schoolos-transfer`, mediaType: TRANSFER_FILE_MEDIA_TYPE, bytes: encodeTransfer(pkg) };
  }
}

/**
 * Imports a file the learner uploaded at the destination, for the signed-in learner. An unsigned
 * file is accepted only where the destination's policy allows, and is marked `unverified-source`.
 */
export async function receiveLearnerCarriedTransfer(importer: StudentArchiveImporter, file: Uint8Array<ArrayBuffer>, learner: Caller): Promise<ImportResult> {
  const pkg = decodeTransfer(file);
  return importer.importStudentArchive(pkg.archive, pkg.signature, pkg.consent, { principal: learner, channel: "learner-carried" });
}

/** The destination's answer to a direct push. */
const PushResponse = z.strictObject({ outcome: z.enum(["imported", "already-imported"]), imported: z.int().nonnegative(), skipped: z.int().nonnegative() });

/** What a {@link DirectTransferChannel} is built from. */
export interface DirectTransferChannelOptions {
  /** The destination district's transfer endpoint, `https` only. */
  endpoint: string;
  /** How requests are made. Only `endpoint` is ever requested. */
  fetch: (request: Request) => Promise<Response>;
}

/**
 * Pushes a signed package from the source district straight to the destination's endpoint over
 * HTTPS. The destination authenticates the push by the signature, against the source key its admin
 * pinned, so an unsigned package is never pushed.
 */
export class DirectTransferChannel implements TransferChannel {
  readonly kind = "direct";
  readonly #endpoint: URL;
  readonly #fetch: (request: Request) => Promise<Response>;

  constructor(options: DirectTransferChannelOptions) {
    this.#endpoint = httpsEndpoint(options.endpoint);
    this.#fetch = options.fetch;
  }

  async send(pkg: TransferPackage): Promise<TransferDelivery> {
    if (pkg.signature === undefined) throw new SchoolOsError("validation-failed", "A direct transfer must be signed.");
    const response = await this.#fetch(new Request(this.#endpoint, {
      method: "POST",
      headers: { "content-type": TRANSFER_FILE_MEDIA_TYPE },
      body: encodeTransfer(pkg),
      redirect: "error",
    }));
    if (!response.ok) throw await failureOf(response, "The destination district did not accept the transfer.");
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = PushResponse.safeParse(body);
    if (!parsed.success) throw new SchoolOsError("unavailable", "The destination district gave an unexpected answer.");
    return { kind: "pushed", ...parsed.data };
  }
}

const STATUS: Readonly<Record<ErrorCode, number>> = {
  "unauthenticated": 401,
  "forbidden": 403,
  "not-found": 404,
  "conflict": 409,
  "validation-failed": 400,
  "policy-violation": 422,
  "budget-exceeded": 429,
  "unavailable": 503,
};

/** What a {@link DirectTransferEndpoint} is built from. */
export interface DirectTransferEndpointOptions {
  importer: StudentArchiveImporter;
  /** Confirmed portable identity links, which name the learner a push is for. */
  links: PortableIdentityLinkStore;
  /** This district. */
  districtId: DistrictId;
}

/**
 * The destination's endpoint for direct pushes. A push is for the learner its archive's pseudonym
 * is linked to by an admin-confirmed {@link PortableIdentityLink}; without one it is refused. The
 * importer then requires a valid signature from a pinned source. The response carries counts
 * only, never IDs or content.
 */
export class DirectTransferEndpoint {
  readonly #importer: StudentArchiveImporter;
  readonly #links: PortableIdentityLinkStore;
  readonly #districtId: DistrictId;

  constructor(options: DirectTransferEndpointOptions) {
    this.#importer = options.importer;
    this.#links = options.links;
    this.#districtId = DistrictId.parse(options.districtId);
  }

  /** Handles one push. */
  async handle(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") throw new SchoolOsError("validation-failed", "Transfers are pushed with POST.");
      const pkg = decodeTransfer(await readBounded(request, MAX_TRANSFER_BYTES, "This transfer is too large."));
      const link = await this.#links.find(pkg.consent.source.label, pkg.consent.subject);
      if (link === undefined) throw new SchoolOsError("forbidden", "A direct transfer needs an administrator-confirmed link to the learner.");
      const learner: Caller = { principal: { principalId: link.destinationPrincipalId, districtId: this.#districtId }, channel: "system" };
      const { outcome, record } = await this.#importer.importStudentArchive(pkg.archive, pkg.signature, pkg.consent, { principal: learner, channel: "direct" });
      return Response.json({ outcome, imported: record.imported.length, skipped: record.skipped.length });
    } catch (error) {
      return errorResponse(error, "The transfer could not be imported.");
    }
  }
}

/**
 * Pushes signed consent revocation notices (`issueConsentRevocationNotice`) from the source district
 * straight to a destination's revocation endpoint over HTTPS, as the source pushes a direct
 * transfer. The destination records a notice once it verifies against the key its admin pinned.
 */
export class ConsentRevocationChannel {
  readonly #endpoint: URL;
  readonly #fetch: (request: Request) => Promise<Response>;

  /** `endpoint` is the destination's revocation endpoint, `https` only. */
  constructor(options: DirectTransferChannelOptions) {
    this.#endpoint = httpsEndpoint(options.endpoint);
    this.#fetch = options.fetch;
  }

  /** Pushes one notice. */
  async send(notice: SignedEnvelope): Promise<void> {
    const response = await this.#fetch(new Request(this.#endpoint, {
      method: "POST",
      headers: { "content-type": REVOCATION_MEDIA_TYPE },
      body: JSON.stringify(notice),
      redirect: "error",
    }));
    if (!response.ok) throw await failureOf(response, "The destination district did not accept the revocation notice.");
  }
}

/** The media type of a pushed consent revocation notice: a signed envelope as JSON. */
export const REVOCATION_MEDIA_TYPE = "application/vnd.schoolos.consent-revocation+json";

/** The largest revocation notice body accepted, in bytes. */
export const MAX_REVOCATION_BYTES = 16 * 1024;

/**
 * The destination's endpoint for consent revocation notices pushed by source districts. A notice
 * is recorded only once it verifies against a key the admin pinned for its source (see
 * `acceptConsentRevocationNotice`); the importer then refuses that consent. The response carries
 * nothing about the learner.
 */
export class ConsentRevocationEndpoint {
  readonly #acceptance: RevocationAcceptance;

  constructor(acceptance: RevocationAcceptance) {
    this.#acceptance = acceptance;
  }

  /** Handles one push. */
  async handle(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") throw new SchoolOsError("validation-failed", "Revocation notices are pushed with POST.");
      const bytes = await readBounded(request, MAX_REVOCATION_BYTES, "This revocation notice is too large.");
      let envelope: unknown;
      try {
        envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new SchoolOsError("validation-failed", "This is not a revocation notice.");
      }
      await acceptConsentRevocationNotice(this.#acceptance, envelope);
      return Response.json({ outcome: "recorded" });
    } catch (error) {
      return errorResponse(error, "The revocation notice could not be recorded.");
    }
  }
}

/** An `https` endpoint without credentials, or `validation-failed`. */
function httpsEndpoint(raw: string): URL {
  const endpoint = new URL(raw);
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "") {
    throw new SchoolOsError("validation-failed", "A transfer endpoint is an https URL without credentials.");
  }
  return endpoint;
}

/** The error a destination answered with, or `unavailable` with `fallback` when its answer is not one. */
async function failureOf(response: Response, fallback: string): Promise<SchoolOsError> {
  const error = SchoolOsErrorBody.safeParse(await response.json().catch(() => undefined));
  return error.success ? new SchoolOsError(error.data.code, error.data.message) : new SchoolOsError("unavailable", fallback);
}

/** A SchoolOS error as a JSON response; anything else as `unavailable` with `fallback`. */
function errorResponse(error: unknown, fallback: string): Response {
  const failure = error instanceof SchoolOsError ? error : new SchoolOsError("unavailable", fallback);
  return Response.json(failure.toBody(), { status: STATUS[failure.code] });
}

/** Reads a request body, stopping as soon as it passes `limit` bytes. */
async function readBounded(request: Request, limit: number, tooLarge: string): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) throw new SchoolOsError("validation-failed", tooLarge);
  if (request.body === null) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of request.body) {
    total += chunk.byteLength;
    if (total > limit) throw new SchoolOsError("validation-failed", tooLarge);
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
