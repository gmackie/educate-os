import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderWorkerConfig } from "../../../scripts/generate-worker-configs.ts";
const directory = fileURLToPath(new URL("../deploy/", import.meta.url));
writeFileSync(new URL("../deploy/wrangler.jsonc", import.meta.url), await renderWorkerConfig(directory));
