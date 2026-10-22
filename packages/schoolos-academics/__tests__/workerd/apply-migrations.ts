// Applies `migrations/` to the suite's D1 database before the tests run, as a deployment does.
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.MIGRATIONS);
