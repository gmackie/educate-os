// The district's starting configuration, written from plain answers (SCHO-441, SCHO-442), so an
// operator never hand-writes DISTRICT_CONFIG or MCP_CONFIG JSON for a new district.
//
// A new district starts with no people: its administrators are bootstrap administrators, created
// on their first sign-in (see `BootstrapAdmin` in @educateos/identity), and its roster arrives by
// import. It trusts the install's Zero Trust team, and its Workshop policy lets staff create
// workspaces and chat while students stay off until the district turns them on.

/** One administrator the operator named. */
export interface FirstAdmin {
  email: string;
  displayName: string;
}

/** What the starting configuration is written from. */
export interface DistrictAnswers {
  /** The instance's short name; it names the district and its first administrators' IDs. */
  slug: string;
  districtName: string;
  /** An IANA time zone, such as America/Chicago. */
  timeZone: string;
  /** The Zero Trust team name, `<team>.cloudflareaccess.com`. */
  teamName: string;
  /** The district's public origin, `https://<hostname>`. */
  origin: string;
  admins: readonly FirstAdmin[];
}

/**
 * The Workshop actions staff hold on a new district (SCHO-442): create a workspace, author in it,
 * run gadgets and agents, and share. Students hold none until the district grants them.
 */
export const DEFAULT_STAFF_ACTIONS = [
  "workspace.create.query",
  "workshop.authoring.query",
  "gadget.create",
  "gadget.execute",
  "agent.execute",
  "workspace.share",
] as const;

/** The district ID for an instance slug. */
export const districtIdFor = (slug: string) => `dst_${slug}`;

/** The principal ID of the `index`th (from 0) first administrator. */
export const adminPrincipalIdFor = (slug: string, index: number) => `prn_${slug}-admin-${index + 1}`;

function directory(answers: DistrictAnswers) {
  return {
    district: {
      id: districtIdFor(answers.slug),
      name: answers.districtName,
      timeZone: answers.timeZone,
      trustedIssuers: [`https://${answers.teamName}.cloudflareaccess.com`],
    },
    schools: [], terms: [], courses: [], offerings: [], principals: [], enrollments: [], roleAssignments: [],
  };
}

/** The district Worker's `DISTRICT_CONFIG` text. */
export function districtConfigText(answers: DistrictAnswers): string {
  return JSON.stringify({
    directory: directory(answers),
    authority: "local",
    bootstrapAdmins: answers.admins.map((admin, i) => ({
      principalId: adminPrincipalIdFor(answers.slug, i),
      displayName: admin.displayName,
      email: admin.email,
    })),
    workshopPolicy: {
      personalCreation: true,
      personalBlueprints: [],
      classBlueprints: [],
      models: [],
      connectors: [],
      workspaceActions: [{ kind: "staff", actions: [...DEFAULT_STAFF_ACTIONS] }],
    },
  });
}

/** The district MCP Worker's `MCP_CONFIG` text: the same district, signing in through Access. */
export function mcpConfigText(answers: DistrictAnswers): string {
  const issuer = `https://${answers.teamName}.cloudflareaccess.com`;
  return JSON.stringify({
    origin: answers.origin,
    directory: directory(answers),
    allowedOrigins: [],
    issuer: {
      issuer,
      metadataUrl: `${issuer}/.well-known/openid-configuration`,
      jwksUri: `${issuer}/cdn-cgi/access/certs`,
      exchangeAudience: `${issuer}/educateos-${answers.slug}-exchange`,
      algorithms: ["RS256"],
      credential: "person",
    },
  });
}

/**
 * A display name from an email's local part, as a default the operator can change:
 * `avery.admin@…` → "Avery Admin".
 */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const words = local.split(/[._+-]+/).filter((word) => word !== "");
  const name = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
  return name === "" ? "Administrator" : name.slice(0, 200);
}
