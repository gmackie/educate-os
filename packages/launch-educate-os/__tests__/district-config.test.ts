import { describe, expect, it } from "vitest";
import { readDistrictWorkerConfig } from "@educateos/district-worker/src/config.ts";
import { readMcpConfig } from "@educateos/external-mcp/discovery";
import { bootstrapAdminLink, createDirectoryPrincipalResolver } from "@educateos/identity";
import { adminPrincipalIdFor, districtConfigText, mcpConfigText, nameFromEmail } from "../src/district-config.ts";

const answers = {
  slug: "northfield", districtName: "Northfield", timeZone: "America/Chicago", teamName: "northfield",
  origin: "https://educateos.northfield.example",
  admins: [{ email: "avery.admin@northfield.example", displayName: "Avery Admin" }, { email: "it@northfield.example", displayName: "IT" }],
};

describe("the district's starting configuration", () => {
  it("names each administrator once, with no person in the seeded directory", () => {
    const config = JSON.parse(districtConfigText(answers));
    expect(config.directory.principals).toEqual([]);
    expect(config.directory.roleAssignments).toEqual([]);
    expect(config.bootstrapAdmins.map((a: { principalId: string }) => a.principalId)).toEqual(["prn_northfield-admin-1", "prn_northfield-admin-2"]);
    expect(adminPrincipalIdFor("northfield", 1)).toBe("prn_northfield-admin-2");
    // Students hold no Workshop actions until the district grants them.
    expect(config.workshopPolicy.workspaceActions.map((grant: { kind: string }) => grant.kind)).toEqual(["staff"]);
    // Built-in Cloudflare OAuth MCP server is enabled by default for the district LMS.
    expect(config.mcp).toEqual({
      mode: "builtin",
      origin: "https://educateos.northfield.example",
      allowDrafts: true,
    });
  });

  it("gives the MCP service the same district with no administrator email", () => {
    const text = mcpConfigText(answers);
    expect(JSON.parse(text).directory.district).toEqual(JSON.parse(districtConfigText(answers)).directory.district);
    expect(text).not.toContain("avery.admin@");
  });

  it.each([
    ["avery.admin@northfield.example", "Avery Admin"],
    ["jo_ann+it@x.example", "Jo Ann It"],
    ["@x.example", "Administrator"],
  ])("suggests a name for %s", (email, name) => {
    expect(nameFromEmail(email)).toBe(name);
  });
});

// The Workers' own parsers accept what the wizard writes, and the identity library creates the
// first administrator from it (SCHO-441). The Workers' end-to-end sign-in is tested in their package.
describe("against the district and MCP Workers", () => {
  it("is a DISTRICT_CONFIG the district Worker accepts, whose administrator is created on first sign-in", async () => {
    const config = readDistrictWorkerConfig(districtConfigText(answers));
    const identity = { issuer: "https://northfield.cloudflareaccess.com", subject: "access-uuid-it", credential: "person" as const };
    const linked = bootstrapAdminLink(config.directory, { identity, email: "IT@northfield.example", bootstrapAdmins: config.bootstrapAdmins ?? [] });
    expect(linked?.principalId).toBe("prn_northfield-admin-2");
    await expect(createDirectoryPrincipalResolver(linked!.directory).resolve(identity)).resolves.toMatchObject({ principalId: "prn_northfield-admin-2" });
  });

  it("is an MCP_CONFIG the MCP Worker accepts", () => {
    const config = readMcpConfig(mcpConfigText(answers));
    expect(config.issuer.issuer).toBe("https://northfield.cloudflareaccess.com");
    expect(config.issuer.exchangeAudience).not.toBe(`${config.origin}/mcp`);
  });
});
