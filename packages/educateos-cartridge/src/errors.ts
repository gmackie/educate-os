import { EducateOsError } from "@educateos/contracts";
import { ZipRefusalReason } from "@educateos/zip";
import { z } from "zod";

/** Why a cartridge package was refused before anything in it was used. */
export const CartridgeRefusalReason = z.enum([
  // The archive.
  ...ZipRefusalReason.options,
  // The manifest.
  "manifest-missing",
  "xml-doctype",
  "xml-malformed",
  "xml-too-deep",
  "xml-too-large",
  "not-a-cartridge",
]);
/** A refusal reason. */
export type CartridgeRefusalReason = z.infer<typeof CartridgeRefusalReason>;

/**
 * A package refused as unsafe or malformed. It is a `policy-violation`, and {@link reason} says
 * which check refused it, so a teacher sees why and tests can tell the checks apart.
 */
export class CartridgeRefusedError extends EducateOsError {
  /** The check that refused the package. */
  readonly reason: CartridgeRefusalReason;

  constructor(reason: CartridgeRefusalReason, message: string) {
    super("policy-violation", `the cartridge was refused (${reason}): ${message}`);
    this.name = "EducateOsError";
    this.reason = reason;
  }
}
