// Reusable frontend-only build command for district ForgeGraph jobs. This builds local assets;
// it never deploys. Run from the repository root or any package directory.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { frontendProfile } from "./frontend-profile.ts";
import { vpRunEnv } from "../vp/concurrency.ts";

const profile = frontendProfile(vpRunEnv());
const result = spawnSync("pnpm", ["exec", "vp", "run", "-F", "@gadgets/workshop-frontend", "build"], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  env: profile.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
