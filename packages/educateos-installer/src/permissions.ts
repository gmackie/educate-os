// The API token a district-run install needs, as Cloudflare's token editor names its permissions
// (docs/educateos/installer-permissions.md). Shared by educateos.io's guided install and the
// `launch-educate-os` CLI, so both send operators to the same prefilled token editor.

/** The token's permissions. `key` and `type` prefill the editor. */
export const INSTALL_TOKEN_PERMISSIONS = [
  { scope: "Account", name: "Account Settings", level: "Read", key: "account_settings", type: "read" },
  { scope: "Account", name: "Billing", level: "Read", key: "billing", type: "read" },
  { scope: "Account", name: "Workers Scripts", level: "Edit", key: "workers_scripts", type: "edit" },
  { scope: "Account", name: "Workers KV Storage", level: "Edit", key: "workers_kv_storage", type: "edit" },
  { scope: "Account", name: "Workers R2 Storage", level: "Edit", key: "workers_r2", type: "edit" },
  { scope: "Account", name: "D1", level: "Edit", key: "d1", type: "edit" },
  { scope: "Account", name: "Access: Apps and Policies", level: "Edit", key: "access", type: "edit" },
  { scope: "Account", name: "Access: Organizations, Identity Providers, and Groups", level: "Read", key: "access_acct", type: "read" },
  { scope: "Account", name: "AI Gateway", level: "Edit", key: "aig", type: "edit" },
  { scope: "Zone", name: "Zone", level: "Read", key: "zone", type: "read" },
  { scope: "Zone", name: "DNS", level: "Edit", key: "dns", type: "edit" },
  { scope: "Zone", name: "Workers Routes", level: "Edit", key: "workers_routes", type: "edit" },
  { scope: "Zone", name: "SSL and Certificates", level: "Edit", key: "ssl_and_certificates", type: "edit" },
] as const;

/** Cloudflare's token editor, prefilled with {@link INSTALL_TOKEN_PERMISSIONS} and a token name. */
export function installTokenLink(name = "EducateOS guided install"): string {
  const keys = INSTALL_TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type }));
  const query = new URLSearchParams({ permissionGroupKeys: JSON.stringify(keys), name });
  return `https://dash.cloudflare.com/profile/api-tokens?${query}`;
}
