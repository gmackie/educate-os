// Project-specific Env augmentation for Wrangler's generated types.

declare namespace Cloudflare {
  interface Env {
    // This gatekeeper's public URL under the Workshop's origin. The dev server and the release
    // manifest set it.
    BASE_URL?: string;
    // The district's school tools. The district deployment injects this service binding; it is
    // not in the config, so a release without a district installs a gatekeeper that refuses to work.
    SCHOOLOS_DISTRICT?: import("./district.ts").SchoolToolService;
  }
}
