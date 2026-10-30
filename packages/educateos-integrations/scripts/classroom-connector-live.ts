// Explicit teacher-approved synthetic demo operation: exercise shipped connector grade/return and
// licensed rubric reads. Reuses the delegated token implementation; no token is printed or saved.
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { googleclassroom } from "../src/index.ts";

const encoded = execFileSync("security", ["find-generic-password", "-s", "educateos-classroom-demo-sa-key", "-w"], {
  encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
});
const key: unknown = JSON.parse(Buffer.from(encoded.trim(), "base64").toString("utf8"));
const tokens = googleclassroom.serviceAccountTokens({ key,
  scopes: [...googleclassroom.CLASSROOM_ROSTER_SCOPES_READ_WRITE, googleclassroom.GOOGLE_SCOPES.courseworkStudents], fetch });
const token = await tokens.token("cv-teacher-whitaker@gedu.demo.educateos.io");
const result = spawnSync("pnpm", ["exec", "vitest", "run", "-c", "vitest.classroom-live.config.ts"], {
  cwd: fileURLToPath(new URL("../../gatekeeper-google/", import.meta.url)),
  env: { ...process.env, EDUCATEOS_CLASSROOM_LIVE_TOKEN: token }, stdio: "inherit",
});
if (result.error) throw new Error("Could not launch the explicit Classroom live verifier.");
process.exitCode = result.status ?? 1;
