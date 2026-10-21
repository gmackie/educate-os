import { checkImportUrl, ContentItemId } from "@schoolos/content-studio";
import { PrincipalId } from "@schoolos/contracts";
import { z } from "zod";
import { CartridgeRefusedError } from "./errors.ts";
import { CartridgeMetadata, CartridgeProfile, type ManifestResource, type OrganizationItem, parseLtiLink, parseWebLink } from "./manifest.ts";
import type { CartridgePackage } from "./package.ts";
import { assertSafePath } from "./zip.ts";

/** A `sha256:<hex>` digest of a package's bytes, as uploaded. */
export const PackageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64 lowercase hex digits>");

/** One step of the path from the organization's top level down to an item. */
export const ItemPathStep = z.strictObject({ identifier: z.string().max(200), title: z.string().max(500).optional() });
/** An item path step. */
export type ItemPathStep = z.infer<typeof ItemPathStep>;

/**
 * Where an imported link or tool came from: the exact package, the item that placed it in the
 * hierarchy, and the resource and file that described it.
 */
export const CartridgeProvenance = z.strictObject({
  packageDigest: PackageDigest,
  /** From the top level down to the item itself. Empty for a resource no item references. */
  itemPath: z.array(ItemPathStep).max(64),
  resourceIdentifier: z.string().max(200),
  /** The package file the resource's content was read from. */
  file: z.string().max(1024),
});
/** Cartridge provenance. */
export type CartridgeProvenance = z.infer<typeof CartridgeProvenance>;

/**
 * Where an imported web link stands. It starts `quarantined`: recorded but never fetched. A
 * teacher's request submits it to the Content Studio, which fetches and reviews it like any URL.
 * A link whose URL the studio's import checks would refuse is `refused` and cannot be submitted.
 */
export const LinkStatus = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("quarantined") }),
  z.strictObject({ status: z.literal("refused"), reason: z.string().max(100) }),
  z.strictObject({
    status: z.literal("submitted"),
    /** The Content Studio item the submission created. */
    contentItemId: ContentItemId,
    by: PrincipalId,
    at: z.iso.datetime({ offset: true }),
  }),
]);
/** A link status. */
export type LinkStatus = z.infer<typeof LinkStatus>;

/** An imported web link (`imswl_xmlv1p*`). */
export const CartridgeLink = z.strictObject({
  id: z.string().regex(/^lnk-\d{1,5}$/),
  title: z.string().min(1).max(500),
  url: z.string().min(1).max(2048),
  metadata: CartridgeMetadata,
  provenance: CartridgeProvenance,
  review: LinkStatus,
});
/** An imported web link. */
export type CartridgeLink = z.infer<typeof CartridgeLink>;

/**
 * A reference to an external LTI tool (`imsbasiclti_xmlv1p*`). It is recorded so the hierarchy
 * stays whole, but it is never launchable: the schema admits only `launchable: false`. Launching
 * needs an approved LTI registration for the tool (roadmap §5.3, threat model §14 "Imported Thin
 * CC references unregistered LTI tool"), which a later PR matches against `@schoolos/lti`.
 */
export const ExternalToolReference = z.strictObject({
  id: z.string().regex(/^tool-\d{1,5}$/),
  kind: z.literal("external-tool"),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  /** The launch URL the cartridge gives, preferring its secure launch URL. */
  launchUrl: z.string().min(1).max(2048),
  /** The launch URL's host, which a registration would have to cover. */
  domain: z.string().min(1).max(253),
  /** Custom parameters as written. They are data for a future registered launch, never interpreted here. */
  customParams: z.record(z.string(), z.string().max(1000)),
  vendor: z.strictObject({ code: z.string().max(200).optional(), name: z.string().max(200).optional() }).optional(),
  registration: z.literal("requires-registration"),
  launchable: z.literal(false),
  metadata: CartridgeMetadata,
  provenance: CartridgeProvenance,
});
/** An external tool reference. */
export type ExternalToolReference = z.infer<typeof ExternalToolReference>;

/** One node of the proposed outline: a module, or a placement of a link or tool. */
export type OutlineNode =
  | { kind: "module"; identifier: string; title: string; children: OutlineNode[] }
  | { kind: "link"; identifier: string; linkId: string }
  | { kind: "tool"; identifier: string; toolId: string };

/** The schema for {@link OutlineNode}. */
export const OutlineNode: z.ZodType<OutlineNode> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("module"),
    identifier: z.string().max(200),
    title: z.string().min(1).max(500),
    get children() {
      return z.array(OutlineNode).max(10_000);
    },
  }),
  z.strictObject({ kind: z.literal("link"), identifier: z.string().max(200), linkId: z.string().max(20) }),
  z.strictObject({ kind: z.literal("tool"), identifier: z.string().max(200), toolId: z.string().max(20) }),
]);

/** Why a resource or item was not imported. */
export const SkipReason = z.enum([
  /** Not a web link or LTI link: web content files, QTI, discussion topics and so on. */
  "unsupported-type",
  /** A supported resource no organization item places. */
  "not-in-organization",
  /** An item references a resource the manifest does not define. */
  "missing-resource",
  /** The resource names no file, or a file the package does not contain. */
  "missing-file",
  /** The web link has no URL, or one that is not an absolute URL. */
  "invalid-link",
  /** The LTI link has no launch URL, or one that is not an absolute URL. */
  "invalid-launch-url",
]);
/** A skip reason. */
export type SkipReason = z.infer<typeof SkipReason>;

/** One resource or item that was not imported. */
export const SkippedEntry = z.strictObject({
  reason: SkipReason,
  /** The resource type, or the empty string when the resource is missing. */
  type: z.string().max(200),
  resourceIdentifier: z.string().max(200),
  itemIdentifier: z.string().max(200).optional(),
});
/** A skipped entry. */
export type SkippedEntry = z.infer<typeof SkippedEntry>;

/** What was skipped: each entry, and the number of skipped resources by type. */
export const SkippedReport = z.strictObject({
  countsByType: z.record(z.string(), z.number().int().nonnegative()),
  entries: z.array(SkippedEntry),
});
/** A skipped report. */
export type SkippedReport = z.infer<typeof SkippedReport>;

/** Everything an import extracts from a package. It references content but holds none. */
export interface CartridgePlan {
  packageDigest: string;
  profile: CartridgeProfile;
  schemaVersion: string;
  manifestIdentifier: string;
  metadata: CartridgeMetadata;
  links: CartridgeLink[];
  tools: ExternalToolReference[];
  /** The organization's hierarchy, as modules holding link and tool placements. */
  outline: OutlineNode[];
  skipped: SkippedReport;
  /** Archive entries listed but deliberately not read, such as symbolic links. */
  ignoredEntries: { path: string; reason: string }[];
}

const WEB_LINK = /^imswl_xmlv1p[0-3]$/;
const LTI_LINK = /^imsbasiclti_xmlv1p[0-3]$/;
const UNTITLED = "Untitled";

/**
 * Maps a read package to an import plan. Web links become quarantined links, LTI links become
 * never-launchable tool references, and the organization becomes an outline. Every other resource
 * type is skipped and counted: in particular no file content (web content, scripts, QTI) is kept,
 * so nothing executable crosses into SchoolOS.
 *
 * @throws CartridgeRefusedError if a resource names an unsafe path or a link file is unsafe XML.
 */
export function planCartridgeImport(pkg: CartridgePackage): CartridgePlan {
  const { manifest, files, packageDigest } = pkg;
  const resources = new Map<string, ManifestResource>();
  for (const resource of manifest.resources) if (!resources.has(resource.identifier)) resources.set(resource.identifier, resource);

  const links: CartridgeLink[] = [];
  const tools: ExternalToolReference[] = [];
  const entries: SkippedEntry[] = [];
  /** Each resource is mapped once; later items referencing it place the same link or tool. */
  const mapped = new Map<string, { kind: "link"; id: string } | { kind: "tool"; id: string } | undefined>();
  const decoder = new TextDecoder();

  const mapResource = (resource: ManifestResource, itemPath: ItemPathStep[], itemIdentifier: string | undefined) => {
    if (mapped.has(resource.identifier)) return mapped.get(resource.identifier);
    const skip = (reason: SkipReason) => {
      entries.push({ reason, type: resource.type.slice(0, 200), resourceIdentifier: resource.identifier.slice(0, 200), ...(itemIdentifier === undefined ? {} : { itemIdentifier: itemIdentifier.slice(0, 200) }) });
      mapped.set(resource.identifier, undefined);
      return undefined;
    };
    const isLink = WEB_LINK.test(resource.type);
    if (!isLink && !LTI_LINK.test(resource.type)) return skip("unsupported-type");
    const href = resource.files[0] ?? resource.href;
    const path = href === undefined ? undefined : packagePath(href);
    const content = path === undefined ? undefined : files.get(path);
    if (path === undefined || content === undefined) return skip("missing-file");
    const provenance: CartridgeProvenance = { packageDigest, itemPath, resourceIdentifier: resource.identifier.slice(0, 200), file: path };
    const text = decoder.decode(content);

    if (isLink) {
      const link = parseWebLink(text);
      if (link.url === undefined || link.url.length > 2048 || !URL.canParse(link.url)) return skip("invalid-link");
      const check = checkImportUrl(link.url);
      const id = `lnk-${links.length + 1}`;
      links.push({
        id,
        title: link.title ?? resource.metadata.title ?? itemPath.at(-1)?.title ?? link.url.slice(0, 500),
        url: link.url,
        metadata: resource.metadata,
        provenance,
        review: check.ok ? { status: "quarantined" } : { status: "refused", reason: check.reason },
      });
      mapped.set(resource.identifier, { kind: "link", id });
    } else {
      const lti = parseLtiLink(text);
      const launchUrl = lti?.secureLaunchUrl ?? lti?.launchUrl;
      if (lti === undefined || launchUrl === undefined || !URL.canParse(launchUrl)) return skip("invalid-launch-url");
      const domain = new URL(launchUrl).hostname;
      if (domain === "") return skip("invalid-launch-url");
      const id = `tool-${tools.length + 1}`;
      tools.push({
        id,
        kind: "external-tool",
        title: lti.title ?? resource.metadata.title ?? itemPath.at(-1)?.title ?? domain,
        ...(lti.description === undefined ? {} : { description: lti.description }),
        launchUrl,
        domain,
        customParams: lti.customParams,
        ...(lti.vendor === undefined ? {} : { vendor: lti.vendor }),
        registration: "requires-registration",
        launchable: false,
        metadata: resource.metadata,
        provenance,
      });
      mapped.set(resource.identifier, { kind: "tool", id });
    }
    return mapped.get(resource.identifier);
  };

  const placeItem = (item: OrganizationItem, parentPath: ItemPathStep[]): OutlineNode[] => {
    const step = { identifier: item.identifier.slice(0, 200), ...(item.title === undefined ? {} : { title: item.title }) };
    const path = [...parentPath, step];
    const nodes: OutlineNode[] = [];
    if (item.resourceRef !== undefined) {
      const resource = resources.get(item.resourceRef);
      if (resource === undefined) {
        entries.push({ reason: "missing-resource", type: "", resourceIdentifier: item.resourceRef.slice(0, 200), itemIdentifier: step.identifier });
      } else {
        const target = mapResource(resource, path, item.identifier);
        if (target?.kind === "link") nodes.push({ kind: "link", identifier: step.identifier, linkId: target.id });
        if (target?.kind === "tool") nodes.push({ kind: "tool", identifier: step.identifier, toolId: target.id });
      }
    }
    if (item.children.length > 0) {
      const children = item.children.flatMap((child) => placeItem(child, path));
      nodes.push({ kind: "module", identifier: step.identifier, title: item.title ?? UNTITLED, children });
    }
    return nodes;
  };

  const outline = manifest.items.flatMap((item) => placeItem(item, []));
  const hasOrganization = manifest.items.length > 0;
  for (const resource of resources.values()) {
    if (mapped.has(resource.identifier)) continue;
    const supported = WEB_LINK.test(resource.type) || LTI_LINK.test(resource.type);
    if (supported && hasOrganization) {
      entries.push({ reason: "not-in-organization", type: resource.type.slice(0, 200), resourceIdentifier: resource.identifier.slice(0, 200) });
      continue;
    }
    // Without an organization, which Thin CC allows, every supported resource sits at the top level.
    const target = mapResource(resource, [], undefined);
    if (target?.kind === "link") outline.push({ kind: "link", identifier: resource.identifier.slice(0, 200), linkId: target.id });
    if (target?.kind === "tool") outline.push({ kind: "tool", identifier: resource.identifier.slice(0, 200), toolId: target.id });
  }

  const countsByType: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.reason === "missing-resource") continue;
    countsByType[entry.type] = (countsByType[entry.type] ?? 0) + 1;
  }
  return {
    packageDigest,
    profile: manifest.profile,
    schemaVersion: manifest.schemaVersion,
    manifestIdentifier: manifest.identifier.slice(0, 200),
    metadata: manifest.metadata,
    links,
    tools,
    outline,
    skipped: { countsByType, entries },
    ignoredEntries: pkg.ignoredEntries,
  };
}

/**
 * The package path a manifest `href` names. Hrefs are URI references relative to the manifest at
 * the package root, so they are percent-decoded and then held to the same rules as entry names.
 *
 * @throws CartridgeRefusedError `unsafe-path` for an absolute, external or escaping reference.
 */
function packagePath(href: string): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || href.startsWith("//")) {
    throw new CartridgeRefusedError("unsafe-path", `the manifest references ${JSON.stringify(href.slice(0, 200))} outside the package`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/)[0]!);
  } catch {
    throw new CartridgeRefusedError("unsafe-path", "the manifest references a malformed path");
  }
  assertSafePath(decoded);
  return decoded;
}
