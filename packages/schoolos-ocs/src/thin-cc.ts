// The Thin Common Cartridge adapter (RFC 0001 §10, SCHO-96): OCS units to and from a Thin CC's
// organization and web links. Neither format is a superset of the other, so each direction lists
// everything it could not carry instead of dropping it silently.
import type { CartridgeImport, OutlineNode } from "@schoolos/cartridge";
import { SchoolOsError } from "@schoolos/contracts";
import type { ResourceReleaseRef } from "@schoolos/curriculum";
import type { RightsMode } from "@schoolos/registry";
import { formatJson, type OcsPackage, readPackage } from "./package.ts";
import { OCS_SPEC_VERSION, type OcsManifest, PlainText, type OcsResource, type OcsUnit } from "./schema.ts";

/** Something one direction of the adapter could not carry, and where it was. */
export interface AdapterLoss {
  kind:
    // Thin CC to OCS.
    | "link-not-released"
    | "lti-tool"
    | "nested-module-flattened"
    | "standards-claims"
    | "descriptive-metadata"
    | "title-replaced"
    // OCS to Thin CC.
    | "modules"
    | "overrides"
    | "activity"
    | "codex-note"
    | "gadget-blueprint"
    | "resource-without-locator"
    | "rights-use"
    | "standards";
  /** The identifier, link or item it concerns, never its content. */
  at: string;
}

const UNTITLED = "Untitled";

/** `text` if it is acceptable OCS plain text, else a neutral title, recording the replacement. */
function plainTitle(text: string | undefined, at: string, losses: AdapterLoss[]): string {
  const candidate = (text ?? "").slice(0, 200);
  if (PlainText(200).safeParse(candidate).success) return candidate.trim();
  losses.push({ kind: "title-replaced", at });
  return UNTITLED;
}

/** A kebab-case local ID from `seed`, unique among `taken`. */
function localId(seed: string, taken: Set<string>): string {
  const base = `u-${seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 56).replace(/-+$/, "") || "u";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** How a released cartridge link enters OCS: its release, and the use the package makes of it. */
export type ReleasedLink = ResourceReleaseRef & { use: RightsMode };

/**
 * Maps a cartridge import to an OCS package: each top-level module becomes a unit holding, in
 * order, the released links anywhere beneath it, and top-level links outside any module form one
 * more unit. Only links released through the Content Studio are carried, as `release` resources.
 *
 * What does not carry over is listed: LTI tools (which have no release), unreleased or refused
 * links, nesting below the top level, the cartridge's standards claims (OCS standards are reviewed
 * alignments, which a claim is not), its descriptive metadata, and titles that are not plain text.
 *
 * @throws SchoolOsError `validation-failed` if no link is released, since a course needs a unit.
 */
export async function ocsFromCartridge(
  record: CartridgeImport,
  options: { packageId: string; version: string; language: string; released: ReadonlyMap<string, ReleasedLink> },
): Promise<{ files: Record<string, string>; pkg: OcsPackage; losses: AdapterLoss[] }> {
  const losses: AdapterLoss[] = [];
  const resources = new Map<string, OcsResource>();
  const links = new Map(record.links.map((link) => [link.id, link]));
  const unitIds = new Set<string>();

  // Called on a top-level module's children, so every module it meets is nested and is flattened.
  const collect = (nodes: readonly OutlineNode[]): string[] => {
    const refs: string[] = [];
    for (const node of nodes) {
      if (node.kind === "module") {
        losses.push({ kind: "nested-module-flattened", at: node.identifier });
        refs.push(...collect(node.children));
      } else if (node.kind === "tool") {
        losses.push({ kind: "lti-tool", at: node.identifier });
      } else {
        const link = links.get(node.linkId);
        const released = options.released.get(node.linkId);
        if (link === undefined || released === undefined) {
          losses.push({ kind: "link-not-released", at: node.identifier });
          continue;
        }
        if (!resources.has(link.id)) {
          resources.set(link.id, {
            kind: "release",
            id: link.id,
            title: plainTitle(link.title, link.id, losses),
            release: { resourceId: released.resourceId, version: released.version },
            use: released.use,
          });
          if (link.metadata.standards.length > 0) losses.push({ kind: "standards-claims", at: link.id });
          if (link.metadata.keywords.length > 0 || link.metadata.rights !== undefined || link.metadata.description !== undefined) {
            losses.push({ kind: "descriptive-metadata", at: link.id });
          }
        }
        if (!refs.includes(link.id)) refs.push(link.id);
      }
    }
    return refs;
  };

  const units: OcsUnit[] = [];
  const loose = record.outline.filter((node) => node.kind !== "module");
  const groups = [
    ...(loose.length > 0 ? [{ identifier: record.manifestIdentifier || "top-level", title: record.metadata.title ?? record.fileName, nodes: loose }] : []),
    ...record.outline.flatMap((node) => (node.kind === "module" ? [{ identifier: node.identifier, title: node.title, nodes: node.children }] : [])),
  ];
  for (const group of groups) {
    const refs = collect(group.nodes);
    if (refs.length === 0) continue;
    units.push({ id: localId(group.identifier, unitIds), title: plainTitle(group.title, group.identifier, losses), standards: [], items: refs.map((ref) => ({ kind: "resource", ref })) });
  }
  if (units.length === 0) throw new SchoolOsError("validation-failed", "the cartridge has no released links to carry into a course");
  if (record.metadata.standards.length > 0) losses.push({ kind: "standards-claims", at: record.manifestIdentifier });

  const manifest: OcsManifest = {
    specVersion: OCS_SPEC_VERSION,
    id: options.packageId,
    version: options.version,
    title: plainTitle(record.metadata.title ?? record.fileName, record.manifestIdentifier, losses),
    language: options.language,
    standards: [],
    modules: [],
    outline: units.map((unit) => ({ kind: "unit", unit: unit.id })),
    overrides: [],
  };
  const files: Record<string, string> = { "ocs.json": formatJson(manifest) };
  for (const unit of units) files[`units/${unit.id}.json`] = formatJson(unit);
  for (const resource of resources.values()) files[`resources/${resource.id}.json`] = formatJson(resource);
  // Read back, so the adapter can only ever produce a package every other OCS tool accepts.
  return { files, pkg: await readPackage(files), losses };
}

const escapeXml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/**
 * Maps an OCS package's own units to a Thin CC 1.3 package: an organization with one module per
 * unit and one web link per resource release, pointing at the URL `locate` gives for that release.
 * Returns the package's files, to be zipped as an `.imscc`.
 *
 * Thin CC carries links and hierarchy only, so what does not carry over is listed: the package's
 * modules and overrides (export a composed course's own package to carry those units), activities,
 * Codex notes (answer keys among them never leave), Gadget Blueprints (Thin CC carries no code),
 * releases with no public locator, rights uses and standards.
 */
export async function cartridgeFromOcs(
  pkg: OcsPackage,
  locate: (release: ResourceReleaseRef) => Promise<string | undefined>,
): Promise<{ files: Map<string, string>; losses: AdapterLoss[] }> {
  const losses: AdapterLoss[] = [];
  if (pkg.manifest.modules.length > 0) losses.push({ kind: "modules", at: pkg.manifest.id });
  if (pkg.manifest.overrides.length > 0) losses.push({ kind: "overrides", at: pkg.manifest.id });
  if (pkg.manifest.standards.length > 0) losses.push({ kind: "standards", at: pkg.manifest.id });

  const files = new Map<string, string>();
  const organization: string[] = [];
  const resources: string[] = [];
  let links = 0;
  for (const entry of pkg.manifest.outline) {
    if (entry.kind !== "unit") continue;
    const unit = pkg.units.get(entry.unit)!;
    if (unit.standards.length > 0) losses.push({ kind: "standards", at: unit.id });
    const items: string[] = [];
    for (const item of unit.items) {
      const at = `${unit.id}#${item.ref}`;
      if (item.kind === "activity") {
        losses.push({ kind: "activity", at });
        continue;
      }
      if (item.kind === "codex") {
        losses.push({ kind: "codex-note", at });
        continue;
      }
      const resource = pkg.resources.get(item.ref)!;
      if (resource.kind === "gadget-blueprint") {
        losses.push({ kind: "gadget-blueprint", at });
        continue;
      }
      const url = await locate(resource.release);
      if (url === undefined || !URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) {
        losses.push({ kind: "resource-without-locator", at });
        continue;
      }
      if (resource.use !== "link") losses.push({ kind: "rights-use", at });
      links++;
      const id = `WL_${links}`;
      const path = `${id}/weblink.xml`;
      files.set(path, [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<webLink xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imswl_v1p3">`,
        `  <title>${escapeXml(resource.title)}</title>`,
        `  <url href="${escapeXml(url)}"/>`,
        `</webLink>`,
        ``,
      ].join("\n"));
      resources.push(`    <resource identifier="${id}" type="imswl_xmlv1p3"><file href="${path}"/></resource>`);
      items.push(`        <item identifier="I_${links}" identifierref="${id}"><title>${escapeXml(resource.title)}</title></item>`);
    }
    if (items.length === 0) continue;
    organization.push(`      <item identifier="U_${escapeXml(unit.id)}"><title>${escapeXml(unit.title)}</title>`, ...items, `      </item>`);
  }
  if (pkg.manifest.outline.some((entry) => entry.kind === "module")) losses.push({ kind: "modules", at: pkg.manifest.id });

  files.set("imsmanifest.xml", [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<manifest identifier="M_${escapeXml(pkg.manifest.id.replace(/[^A-Za-z0-9]/g, "_"))}" xmlns="http://www.imsglobal.org/xsd/imsccv1p3/imscp_v1p1" xmlns:lomimscc="http://ltsc.ieee.org/xsd/imsccv1p3/LOM/manifest">`,
    `  <metadata>`,
    `    <schema>IMS Thin Common Cartridge</schema>`,
    `    <schemaversion>1.3.0</schemaversion>`,
    `    <lomimscc:lom><lomimscc:general><lomimscc:title><lomimscc:string language="${escapeXml(pkg.manifest.language)}">${escapeXml(pkg.manifest.title)}</lomimscc:string></lomimscc:title></lomimscc:general></lomimscc:lom>`,
    `  </metadata>`,
    `  <organizations>`,
    `    <organization identifier="O_1" structure="rooted-hierarchy">`,
    `      <item identifier="LearningModules">`,
    ...organization.map((line) => `  ${line}`),
    `      </item>`,
    `    </organization>`,
    `  </organizations>`,
    `  <resources>`,
    ...resources,
    `  </resources>`,
    `</manifest>`,
    ``,
  ].join("\n"));
  return { files, losses: dedupe(losses) };
}

function dedupe(losses: AdapterLoss[]): AdapterLoss[] {
  const seen = new Set<string>();
  return losses.filter((loss) => {
    const key = `${loss.kind}\0${loss.at}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
