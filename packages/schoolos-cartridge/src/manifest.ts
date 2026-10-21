import { z } from "zod";
import { CartridgeRefusedError } from "./errors.ts";
import { attributeOf, childElement, childElements, descendant, parseXml, textOf, type XmlElement, type XmlLimits } from "./xml.ts";

/** Which 1EdTech profile a manifest declares. */
export const CartridgeProfile = z.enum(["thin-common-cartridge", "common-cartridge"]);
/** A cartridge profile. */
export type CartridgeProfile = z.infer<typeof CartridgeProfile>;

/** The manifest schema versions accepted: CC and Thin CC 1.1 to 1.3. */
export const SUPPORTED_SCHEMA_VERSIONS = ["1.1.0", "1.2.0", "1.3.0"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One standard a resource claims to address, from the cartridge's curriculum standards metadata
 * (`imscsmd`). It is the cartridge's claim, not an alignment: only a reviewer turns it into one.
 */
export const StandardClaim = z.strictObject({
  /** Who issued the GUID, such as a state agency or a standards provider. */
  providerId: z.string().max(200).optional(),
  region: z.string().max(200).optional(),
  version: z.string().max(200).optional(),
  label: z.string().max(500).optional(),
  guid: z.string().min(1).max(200),
  /**
   * The GUID, lowercased, when it has the UUID form CASE item identifiers take, so a reviewer can
   * look it up as a CASE item. Other providers use UUIDs too, so this is a candidate, never a match.
   */
  caseItemGuid: z.string().regex(UUID).optional(),
});
/** A standard claim. */
export type StandardClaim = z.infer<typeof StandardClaim>;

/** Descriptive metadata from a manifest's or resource's LOM and standards metadata, all optional. */
export const CartridgeMetadata = z.strictObject({
  title: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  keywords: z.array(z.string().min(1).max(200)).max(50),
  /** The LOM rights statement, as written: the publisher's claim, not a verified license. */
  rights: z.string().max(2000).optional(),
  /** LOM `copyrightAndOtherRestrictions`: whether the publisher says restrictions apply. */
  copyrightRestricted: z.boolean().optional(),
  standards: z.array(StandardClaim).max(200),
});
/** Cartridge metadata. */
export type CartridgeMetadata = z.infer<typeof CartridgeMetadata>;

/** One item in an organization: a module when it has children, a leaf when it references a resource. */
export interface OrganizationItem {
  identifier: string;
  title: string | undefined;
  resourceRef: string | undefined;
  children: OrganizationItem[];
}

/** One `<resource>` in the manifest. */
export interface ManifestResource {
  identifier: string;
  type: string;
  href: string | undefined;
  files: string[];
  metadata: CartridgeMetadata;
}

/** What a manifest says, in the parts this importer uses. */
export interface CartridgeManifest {
  identifier: string;
  profile: CartridgeProfile;
  schemaVersion: (typeof SUPPORTED_SCHEMA_VERSIONS)[number];
  metadata: CartridgeMetadata;
  /** The organization's top-level items. Empty when the cartridge has no organization, which Thin CC allows. */
  items: OrganizationItem[];
  /** Resources in manifest order. */
  resources: ManifestResource[];
}

const clip = (value: string, max: number) => (value === "" ? undefined : value.slice(0, max));

/**
 * Parses `imsmanifest.xml` with {@link parseXml}, so a DOCTYPE or entity declaration refuses it.
 *
 * @throws CartridgeRefusedError `not-a-cartridge` unless it is a CC or Thin CC 1.1-1.3 manifest,
 *   and whatever {@link parseXml} throws.
 */
export function parseManifest(source: string, limits?: XmlLimits): CartridgeManifest {
  const root = parseXml(source, limits);
  if (root.local !== "manifest") throw new CartridgeRefusedError("not-a-cartridge", "the manifest's root is not <manifest>");
  const metadataElement = childElement(root, "metadata");
  const schema = textOf(childElement(metadataElement ?? root, "schema"));
  const version = textOf(childElement(metadataElement ?? root, "schemaversion"));
  const profile = schema === "IMS Thin Common Cartridge" ? "thin-common-cartridge" : schema === "IMS Common Cartridge" ? "common-cartridge" : undefined;
  if (profile === undefined) throw new CartridgeRefusedError("not-a-cartridge", "the manifest does not declare a Common Cartridge schema");
  const schemaVersion = SUPPORTED_SCHEMA_VERSIONS.find((v) => v === version);
  if (schemaVersion === undefined) throw new CartridgeRefusedError("not-a-cartridge", `schema version ${JSON.stringify(version.slice(0, 20))} is not supported`);

  const organization = childElements(descendant(root, "organizations") ?? root, "organization")[0];
  let items = organization === undefined ? [] : childElements(organization, "item").map(parseItem);
  // CC wraps the organization in one root item with no resource of its own; its children are the top level.
  if (items.length === 1 && items[0]!.resourceRef === undefined) items = items[0]!.children;

  const resources = childElements(descendant(root, "resources") ?? root, "resource").map((resource): ManifestResource => ({
    identifier: attributeOf(resource, "identifier") ?? "",
    type: attributeOf(resource, "type") ?? "",
    href: attributeOf(resource, "href"),
    files: childElements(resource, "file").map((file) => attributeOf(file, "href")).filter((href) => href !== undefined),
    metadata: parseMetadata(childElement(resource, "metadata")),
  }));

  return {
    identifier: attributeOf(root, "identifier") ?? "",
    profile,
    schemaVersion,
    metadata: parseMetadata(metadataElement),
    items,
    resources,
  };
}

function parseItem(item: XmlElement): OrganizationItem {
  return {
    identifier: attributeOf(item, "identifier") ?? "",
    title: clip(textOf(childElement(item, "title")), 500),
    resourceRef: attributeOf(item, "identifierref"),
    children: childElements(item, "item").map(parseItem),
  };
}

/** Finds every descendant with local name `local`, in document order. */
function findAll(element: XmlElement | undefined, local: string): XmlElement[] {
  if (element === undefined) return [];
  const found: XmlElement[] = [];
  for (const child of childElements(element)) {
    if (child.local === local) found.push(child);
    found.push(...findAll(child, local));
  }
  return found;
}

/** The first LOM `<string>` of a langstring element, or its text when it has none. */
function langString(element: XmlElement | undefined): string {
  if (element === undefined) return "";
  return textOf(childElement(element, "string") ?? element);
}

function parseMetadata(metadata: XmlElement | undefined): CartridgeMetadata {
  const lom = findAll(metadata, "lom")[0];
  const general = lom === undefined ? undefined : childElement(lom, "general");
  const rights = lom === undefined ? undefined : childElement(lom, "rights");
  const restricted = textOf(descendant(rights, "copyrightAndOtherRestrictions", "value")).toLowerCase();
  const keywords = (general === undefined ? [] : childElements(general, "keyword"))
    .flatMap((keyword) => childElements(keyword, "string").map(textOf))
    .filter((keyword) => keyword !== "")
    .map((keyword) => keyword.slice(0, 200));
  return {
    ...optional("title", clip(langString(descendant(general, "title")), 500)),
    ...optional("description", clip(langString(descendant(general, "description")), 5000)),
    keywords: [...new Set(keywords)].slice(0, 50),
    ...optional("rights", clip(langString(descendant(rights, "description")), 2000)),
    ...optional("copyrightRestricted", restricted === "yes" ? true : restricted === "no" ? false : undefined),
    standards: parseStandards(metadata),
  };
}

/** Curriculum standards metadata: `curriculumStandardsMetadata` > `setOfGUIDs` > `labelledGUID`. */
function parseStandards(metadata: XmlElement | undefined): StandardClaim[] {
  const claims: StandardClaim[] = [];
  for (const provider of findAll(metadata, "curriculumStandardsMetadata")) {
    const providerId = attributeOf(provider, "providerId");
    for (const set of childElements(provider, "setOfGUIDs")) {
      for (const labelled of childElements(set, "labelledGUID")) {
        const guid = textOf(childElement(labelled, "GUID"));
        if (guid === "" || guid.length > 200) continue;
        claims.push({
          ...optional("providerId", providerId?.slice(0, 200)),
          ...optional("region", attributeOf(set, "region")?.slice(0, 200)),
          ...optional("version", attributeOf(set, "version")?.slice(0, 200)),
          ...optional("label", clip(textOf(childElement(labelled, "label")), 500)),
          guid,
          ...optional("caseItemGuid", UUID.test(guid) ? guid.toLowerCase() : undefined),
        });
      }
    }
  }
  return claims.slice(0, 200);
}

/** `{ [key]: value }`, or nothing when `value` is undefined, for strict optional fields. */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** A web link's target, from its `imswl` file: `<webLink><title/><url href/></webLink>`. */
export interface WebLinkContent {
  title: string | undefined;
  url: string | undefined;
}

/** Parses a web link resource's XML. */
export function parseWebLink(source: string, limits?: XmlLimits): WebLinkContent {
  const root = parseXml(source, limits);
  if (root.local !== "webLink") return { title: undefined, url: undefined };
  const url = childElement(root, "url");
  return { title: clip(textOf(childElement(root, "title")), 500), url: url === undefined ? undefined : attributeOf(url, "href") };
}

/** An LTI link's content, from its `imsbasiclti` file (`<cartridge_basiclti_link>`). */
export interface LtiLinkContent {
  title: string | undefined;
  description: string | undefined;
  launchUrl: string | undefined;
  secureLaunchUrl: string | undefined;
  customParams: Record<string, string>;
  vendor: { code?: string; name?: string } | undefined;
}

const MAX_CUSTOM_PARAMS = 100;

/** Parses an LTI link resource's XML. Extension properties are platform-specific and not kept. */
export function parseLtiLink(source: string, limits?: XmlLimits): LtiLinkContent | undefined {
  const root = parseXml(source, limits);
  if (root.local !== "cartridge_basiclti_link") return undefined;
  const customParams = new Map<string, string>();
  for (const property of childElements(childElement(root, "custom") ?? root, "property").slice(0, MAX_CUSTOM_PARAMS)) {
    const name = attributeOf(property, "name");
    // `__proto__` cannot be an ordinary key of a parsed record, so it is dropped rather than risk a prototype write.
    if (name === undefined || name === "" || name === "__proto__" || name.length > 200 || customParams.has(name)) continue;
    customParams.set(name, textOf(property).slice(0, 1000));
  }
  const vendor = childElement(root, "vendor");
  return {
    title: clip(textOf(childElement(root, "title")), 500),
    description: clip(textOf(childElement(root, "description")), 5000),
    launchUrl: clip(textOf(childElement(root, "launch_url")), 2048),
    secureLaunchUrl: clip(textOf(childElement(root, "secure_launch_url")), 2048),
    customParams: Object.fromEntries(customParams),
    vendor: vendor === undefined ? undefined : {
      ...optional("code", clip(textOf(childElement(vendor, "code")), 200)),
      ...optional("name", clip(textOf(childElement(vendor, "name")), 200)),
    },
  };
}
