// ClassLink (SCHO-204): rostering from a ClassLink Roster Server over OneRoster 1.2 REST with OAuth 2.0
// client credentials, and ClassLink sign-in (OpenID Connect) resolved as a trusted issuer. Its
// configuration is the contracts' `ClassLinkRosterConnection` and `ClassLinkSso`, stored in a
// configuration revision; its credentials are the Worker secrets `CLASSLINK_SECRET_NAMES` lists.
export * from "./roster.ts";
export * from "./secrets.ts";
export * from "./sso.ts";
