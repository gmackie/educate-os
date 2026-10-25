import type { RightsMode } from "@educateos/registry";
import type { LicenseHint } from "./html.ts";

/** A license the studio recognizes from its evidence. */
export interface RecognizedLicense {
  /** A short name such as `CC BY-SA 4.0`. */
  name: string;
  /** The license's canonical URL. */
  uri: string;
  /** The widest rights mode this license supports, before any district decision. */
  supports: RightsMode;
}

/**
 * What the importer concluded from a source's license evidence.
 *
 * - `recognized`: every hint names the same recognized license.
 * - `conflicting`: hints name different licenses, so none can be relied on.
 * - `unrecognized`: there are hints, but none the studio can interpret.
 * - `absent`: the source gave no license evidence.
 */
export type LicenseEvidence =
  | { status: "recognized"; license: RecognizedLicense; hints: LicenseHint[] }
  | { status: "conflicting"; licenses: RecognizedLicense[]; hints: LicenseHint[] }
  | { status: "unrecognized"; hints: LicenseHint[] }
  | { status: "absent"; hints: [] };

/**
 * The widest rights mode each Creative Commons license element permits a district to propose.
 * Deliberately conservative, because the studio cannot judge commercial use or adaptation:
 * `ND` licenses forbid adaptation, so only the unchanged work is embedded; `NC` licenses are
 * excerpted rather than copied, since a district's use is not always non-commercial (contracted
 * tutoring, for example). A curriculum admin can widen either after checking.
 */
function ccSupports(elements: string): RightsMode {
  if (elements.includes("nd")) return "embed";
  if (elements.includes("nc")) return "excerpt";
  return "licensed-copy";
}

const CC_LICENSE = /^\/licenses\/(by(?:-nc)?(?:-sa|-nd)?)\/(\d\.\d)\/?/;
const CC_BADGE = /^\/l\/(by(?:-nc)?(?:-sa|-nd)?)\/(\d\.\d)\//;
const CC_PUBLIC_DOMAIN = /^\/(?:publicdomain|p)\/(zero|mark)\/(1\.0)\/?/;

/** The Creative Commons license a URL names: a license deed or a license badge image. */
function recognizeCcUrl(value: string): RecognizedLicense | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const isCc = host === "creativecommons.org" || host.endsWith(".creativecommons.org") || host === "licensebuttons.net";
  if (!isCc) return undefined;
  const license = CC_LICENSE.exec(url.pathname) ?? CC_BADGE.exec(url.pathname);
  if (license) {
    const elements = license[1]!;
    const version = license[2]!;
    return {
      name: `CC ${elements.toUpperCase()} ${version}`,
      uri: `https://creativecommons.org/licenses/${elements}/${version}/`,
      supports: ccSupports(elements),
    };
  }
  const publicDomain = CC_PUBLIC_DOMAIN.exec(url.pathname);
  if (publicDomain) {
    const kind = publicDomain[1]!;
    const version = publicDomain[2]!;
    return {
      name: kind === "zero" ? `CC0 ${version}` : `Public Domain Mark ${version}`,
      uri: `https://creativecommons.org/publicdomain/${kind}/${version}/`,
      supports: "licensed-copy",
    };
  }
  return undefined;
}

/** Recognizes a license from one hint. Text statements are matched only when they name a CC license exactly. */
function recognize(hint: LicenseHint): RecognizedLicense | undefined {
  const fromUrl = recognizeCcUrl(hint.value);
  if (fromUrl !== undefined) return fromUrl;
  const text = /^CC[ -](BY(?:-NC)?(?:-SA|-ND)?)[ -](\d\.\d)$/i.exec(hint.value.trim());
  if (text) return recognizeCcUrl(`https://creativecommons.org/licenses/${text[1]!.toLowerCase()}/${text[2]}/`);
  if (/^CC0(?:[ -]1\.0)?$/i.test(hint.value.trim())) return recognizeCcUrl("https://creativecommons.org/publicdomain/zero/1.0/");
  return undefined;
}

/** Interprets a source's license hints. */
export function interpretLicenseHints(hints: readonly LicenseHint[]): LicenseEvidence {
  if (hints.length === 0) return { status: "absent", hints: [] };
  const recognized = new Map<string, RecognizedLicense>();
  for (const hint of hints) {
    const license = recognize(hint);
    if (license !== undefined) recognized.set(license.uri, license);
  }
  const licenses = [...recognized.values()];
  if (licenses.length === 0) return { status: "unrecognized", hints: [...hints] };
  if (licenses.length > 1) return { status: "conflicting", licenses, hints: [...hints] };
  return { status: "recognized", license: licenses[0]!, hints: [...hints] };
}
