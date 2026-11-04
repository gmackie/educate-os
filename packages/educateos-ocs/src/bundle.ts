// A course bundle: one course package version, the packages it includes, the activity exports it
// names (OCS 1.1), and their publisher signatures, in one JSON document. It is how a course is
// distributed: from a publisher's repository (`curriculum/bundles/` in this one), on a website, and
// into a district's import route, which opens it against the district's approved publisher keys
// and plans the installation from it. Every part is checked, so the bundle itself is not trusted.
import { EducateOsError } from "@educateos/contracts";
import { SignedEnvelope } from "@educateos/fleet";
import { z } from "zod";
import { activityExportDigest, readActivityExport } from "./activity-export.ts";
import { composeCourse } from "./composer.ts";
import { type CourseInstallPlan, planCourseInstall, resolveActivityExports } from "./install-plan.ts";
import { InMemoryPackageLibrary } from "./library.ts";
import { formatJson, packageDigest, readPackage } from "./package.ts";
import { resolveCourse } from "./resolver.ts";
import { ActivityExportId, OcsPackageId, Sha256Digest } from "./schema.ts";
import { SemVer } from "./semver.ts";
import { checkExportPublication, checkPublication, type PublisherTrust } from "./signatures.ts";

/** The bundle format this package reads and writes. */
export const OCS_BUNDLE_FORMAT = "educateos.ocs-bundle.v1";

/** One package version in a bundle: its files as published, its digest and its publisher signature. */
export const BundledPackage = z.strictObject({
  id: OcsPackageId,
  version: SemVer,
  digest: Sha256Digest,
  files: z.record(z.string(), z.string()),
  /** The `PackagePublication` envelope, once the publisher has signed. */
  signature: SignedEnvelope.optional(),
});
/** A bundled package. */
export type BundledPackage = z.infer<typeof BundledPackage>;

/** One activity export version in a bundle: its file as published, its digest and its signature. */
export const BundledExport = z.strictObject({
  id: ActivityExportId,
  version: SemVer,
  digest: Sha256Digest,
  text: z.string(),
  /** The `ActivityExportPublication` envelope, once the publisher has signed. */
  signature: SignedEnvelope.optional(),
});
/** A bundled export. */
export type BundledExport = z.infer<typeof BundledExport>;

/**
 * A course bundle. `course` names the package the bundle installs; `packages` holds it first, then
 * every package it includes, by ID; `exports` holds every export those packages name, by ID and
 * version.
 */
export const OcsBundle = z.strictObject({
  format: z.literal(OCS_BUNDLE_FORMAT),
  course: z.strictObject({ id: OcsPackageId, version: SemVer, digest: Sha256Digest }),
  packages: z.array(BundledPackage).min(1).max(100),
  exports: z.array(BundledExport).max(500),
});
/** A course bundle. */
export type OcsBundle = z.infer<typeof OcsBundle>;

async function bundlePackage({ files, signature }: { files: Record<string, string>; signature?: SignedEnvelope | undefined }): Promise<BundledPackage> {
  const pkg = await readPackage(files);
  return { id: pkg.manifest.id, version: pkg.manifest.version, digest: pkg.digest, files: { ...files }, ...(signature === undefined ? {} : { signature }) };
}

const byId = <T extends { id: string; version: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);

/**
 * Builds a bundle from a course's package files, the packages it includes and the exports they
 * name, computing every digest. The result is deterministic: the same inputs give the same bytes
 * under {@link formatJson}. Signatures are carried as given.
 *
 * @throws OcsError `invalid-package` or `invalid-export` for an invalid part.
 */
export async function buildBundle(input: {
  course: { files: Record<string, string>; signature?: SignedEnvelope | undefined };
  modules?: readonly { files: Record<string, string>; signature?: SignedEnvelope | undefined }[];
  exports: readonly { text: string; signature?: SignedEnvelope | undefined }[];
}): Promise<OcsBundle> {
  const root = await bundlePackage(input.course);
  const modules = await Promise.all((input.modules ?? []).map(bundlePackage));
  const exports = await Promise.all(input.exports.map(async ({ text, signature }): Promise<BundledExport> => {
    const parsed = await readActivityExport(text);
    return { id: parsed.export.id, version: parsed.export.version, digest: parsed.digest, text, ...(signature === undefined ? {} : { signature }) };
  }));
  return OcsBundle.parse({
    format: OCS_BUNDLE_FORMAT,
    course: { id: root.id, version: root.version, digest: root.digest },
    packages: [root, ...modules.toSorted(byId)],
    exports: exports.toSorted(byId),
  } satisfies OcsBundle);
}

/** A bundle's bytes: canonical, indented JSON. */
export function serializeBundle(bundle: OcsBundle): string {
  return formatJson(OcsBundle.parse(bundle));
}

/** A bundle that passed {@link openBundle}: a library holding its parts, and what was signed. */
export interface OpenedBundle {
  course: OcsBundle["course"];
  /** Every package and export of the bundle, verified, as a package and export source. */
  library: InMemoryPackageLibrary;
  /** Whether each part was signed (false only for the district's own domains), by `id@version`. */
  signed: ReadonlyMap<string, boolean>;
}

const refused = (what: string, reason: string) => new EducateOsError("unauthenticated", `${what}: the publisher signature was not accepted (${reason})`);

/**
 * Opens a bundle: checks its shape, recomputes every package's and export's digest, and checks
 * every publisher signature against the district's approved keys at `now`, exactly as the
 * district's library would at publication. Nothing in the bundle is trusted: a part whose content
 * does not match its digest, a signature by a key the district did not approve for that
 * publisher, or a missing signature from outside the district's own domains, refuses the bundle.
 *
 * @throws EducateOsError `validation-failed` for a malformed bundle or a part that does not match
 *   its digest, identity or the course entry; `unauthenticated` for a refused signature; and
 *   OcsError `invalid-package` or `invalid-export` for an invalid part.
 */
export async function openBundle(input: unknown, trust: PublisherTrust, now: Date): Promise<OpenedBundle> {
  const parsed = OcsBundle.safeParse(input);
  if (!parsed.success) throw new EducateOsError("validation-failed", "malformed course bundle");
  const bundle = parsed.data;
  const library = new InMemoryPackageLibrary();
  const signed = new Map<string, boolean>();
  for (const entry of bundle.packages) {
    const key = `${entry.id}@${entry.version}`;
    if (signed.has(key)) throw new EducateOsError("validation-failed", `${key} appears in the bundle more than once`);
    const pkg = await readPackage(entry.files);
    if (pkg.manifest.id !== entry.id || pkg.manifest.version !== entry.version || pkg.digest !== entry.digest || (await packageDigest(entry.files)) !== entry.digest) {
      throw new EducateOsError("validation-failed", `${key} in the bundle does not match its recorded identity or fingerprint`);
    }
    const check = await checkPublication(pkg, entry.signature, trust, now);
    if (!check.ok) throw refused(key, check.reason);
    signed.set(key, check.signed);
    await library.publish(entry.files);
  }
  const root = bundle.packages[0]!;
  if (root.id !== bundle.course.id || root.version !== bundle.course.version || root.digest !== bundle.course.digest) {
    throw new EducateOsError("validation-failed", "the bundle's first package is not the course it names");
  }
  for (const entry of bundle.exports) {
    const key = `${entry.id}@${entry.version}`;
    if (signed.has(`export:${key}`)) throw new EducateOsError("validation-failed", `${key} appears in the bundle more than once`);
    const { export: exported, digest } = await readActivityExport(entry.text);
    if (exported.id !== entry.id || exported.version !== entry.version || digest !== entry.digest || (await activityExportDigest(entry.text)) !== entry.digest) {
      throw new EducateOsError("validation-failed", `${key} in the bundle does not match its recorded identity or fingerprint`);
    }
    const check = await checkExportPublication(entry, entry.signature, trust, now);
    if (!check.ok) throw refused(key, check.reason);
    signed.set(`export:${key}`, check.signed);
    await library.publishExport(entry.text);
  }
  return { course: bundle.course, library, signed };
}

/**
 * Plans the installation of an opened bundle's course: resolves it from the bundle alone (with
 * its own lockfile), composes it, and verifies every export it names. What a district import
 * route hands to `applyInstallPlan`.
 *
 * @throws OcsError as `resolveCourse`, `composeCourse`, `resolveActivityExports` and `planCourseInstall`.
 */
export async function planBundleInstall(opened: OpenedBundle): Promise<CourseInstallPlan> {
  const published = await opened.library.getPackage(opened.course.id, opened.course.version);
  const root = await readPackage(published!.files);
  const course = composeCourse(await resolveCourse(root, opened.library, { locked: root.lock }));
  return planCourseInstall(course, await resolveActivityExports(course, opened.library));
}
