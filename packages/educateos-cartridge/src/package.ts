import { snapshotDigest } from "@educateos/content-studio";
import { CartridgeRefusedError } from "./errors.ts";
import { type CartridgeManifest, parseManifest } from "./manifest.ts";
import { DEFAULT_XML_LIMITS, type XmlLimits } from "./xml.ts";
import { DEFAULT_ZIP_LIMITS, type IgnoredZipEntry, readZip, type ZipLimits } from "./zip.ts";

/** The caps on reading one package. */
export interface CartridgeLimits {
  /** The largest package accepted, in bytes, before it is opened. */
  maxPackageBytes: number;
  zip: ZipLimits;
  xml: XmlLimits;
}

/** The caps used unless a district sets its own. */
export const DEFAULT_CARTRIDGE_LIMITS: CartridgeLimits = {
  maxPackageBytes: 16 * 1024 * 1024,
  zip: DEFAULT_ZIP_LIMITS,
  xml: DEFAULT_XML_LIMITS,
};

/** A package that was read safely: its digest, its parsed manifest, and its files by path. */
export interface CartridgePackage {
  /** The `sha256:` digest of the package bytes, which every import record's provenance names. */
  packageDigest: string;
  manifest: CartridgeManifest;
  files: ReadonlyMap<string, Uint8Array>;
  ignoredEntries: IgnoredZipEntry[];
}

const MANIFEST = "imsmanifest.xml";

/**
 * Reads an `.imscc` package: a bounded unzip ({@link readZip}), then the root `imsmanifest.xml`
 * through the DTD-free parser ({@link parseManifest}).
 *
 * @throws CartridgeRefusedError naming the check that refused the package.
 */
export async function readCartridge(bytes: Uint8Array, limits: CartridgeLimits = DEFAULT_CARTRIDGE_LIMITS): Promise<CartridgePackage> {
  if (bytes.byteLength > limits.maxPackageBytes) {
    throw new CartridgeRefusedError("package-too-large", `the package is larger than ${limits.maxPackageBytes} bytes`);
  }
  const archive = await readZip(bytes, limits.zip);
  const manifestBytes = archive.files.get(MANIFEST);
  if (manifestBytes === undefined) throw new CartridgeRefusedError("manifest-missing", `the package has no root ${MANIFEST}`);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(manifestBytes);
  } catch {
    throw new CartridgeRefusedError("xml-malformed", `${MANIFEST} is not UTF-8`);
  }
  return {
    packageDigest: await snapshotDigest(bytes),
    manifest: parseManifest(source, limits.xml),
    files: archive.files,
    ignoredEntries: archive.ignored,
  };
}
