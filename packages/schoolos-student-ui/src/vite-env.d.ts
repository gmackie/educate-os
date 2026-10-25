/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" shows the class helper's entry point on activities that allow it. */
  readonly VITE_SCHOOLOS_AI_HELP?: string;
  /** "true" when the app is served behind Cloudflare Access, which signs requests itself. */
  readonly VITE_CF_ACCESS_MODE?: string;
}
