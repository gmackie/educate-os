// The answers file: everything non-secret the wizard asked, so a re-run (to resume, upgrade or roll
// back) asks nothing again, and the same file drives a non-interactive run (`--config`).
//
// It holds an install config (`DistrictInstallConfig`) without its `release`, which the launcher
// fills in from the release it verified, plus the releases this machine installed. It never holds
// the API token or any secret: the config's schema has no field for either, and it is strict, so a
// pasted-in `token` or secret field is refused rather than kept.
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { EducateOsError } from "@educateos/contracts";
import { DistrictInstallConfig, type SignedReleasePin } from "@educateos/installer";
import { z } from "zod";

/** The default answers file, in the directory the launcher runs in. */
export const ANSWERS_FILE = "educateos-install.json";

/** The answers file's format marker. */
export const ANSWERS_FORMAT = "launch-educate-os/1";

/** One release this machine installed or rolled back to. */
export const InstalledEntry = z.strictObject({
  releaseId: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
  at: z.iso.datetime(),
  action: z.enum(["install", "upgrade", "rollback"]),
});
/** An installed entry. */
export type InstalledEntry = z.infer<typeof InstalledEntry>;

/** The answers file. */
export const Answers = z.strictObject({
  format: z.literal(ANSWERS_FORMAT),
  /** The install config, without `release`. Validated in full once the release is known. */
  install: z.record(z.string(), z.unknown()).refine((install) => !("release" in install), {
    message: "the launcher pins the release itself; remove `release` from install",
  }),
  /** Releases installed from this machine, oldest first. */
  history: z.array(InstalledEntry).max(100).default([]),
});
/** The answers. */
export type Answers = z.infer<typeof Answers>;

// A placeholder pin, to validate everything but the release before one is chosen.
const PLACEHOLDER_PIN = { mode: "insecure-pin", releaseId: "placeholder", version: "0.0.0", manifestSha256: "0".repeat(64) } as const;

/** The install config for a release pin. Fails with every problem in the answers. */
export function installConfig(answers: Pick<Answers, "install">, pin: SignedReleasePin | typeof PLACEHOLDER_PIN = PLACEHOLDER_PIN): DistrictInstallConfig {
  const parsed = DistrictInstallConfig.safeParse({ ...answers.install, release: pin });
  if (!parsed.success) throw new EducateOsError("validation-failed", `the install config is not valid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Reads and checks an answers file. Undefined when there is none. */
export async function readAnswers(path: string): Promise<Answers | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new EducateOsError("unavailable", `${path} could not be read`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EducateOsError("validation-failed", `${path} is not JSON`);
  }
  const parsed = Answers.safeParse(json);
  if (!parsed.success) throw new EducateOsError("validation-failed", `${path} is not a launch-educate-os answers file:\n${z.prettifyError(parsed.error)}`);
  installConfig(parsed.data);
  return parsed.data;
}

/** Writes an answers file atomically, readable by its owner only. */
export async function writeAnswers(path: string, answers: Answers): Promise<void> {
  const checked = Answers.parse(answers);
  installConfig(checked);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checked, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** The last release in the history, if any. */
export function lastInstalled(answers: Answers | undefined): InstalledEntry | undefined {
  return answers?.history.at(-1);
}

/** The release before the current one, for a rollback with no `--to`. */
export function previousInstalled(answers: Answers | undefined): InstalledEntry | undefined {
  const history = answers?.history ?? [];
  const current = history.at(-1);
  return history.toReversed().find((entry) => entry.releaseId !== current?.releaseId);
}
