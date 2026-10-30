// Applies the package's D1 migrations before each suite. Idempotent: D1 records what it applied.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
