import { SchoolOsError } from "@schoolos/contracts";
import { extensionFor, type ArchivedRevision } from "./archive.ts";
import type { ValidatedArchive } from "./validate.ts";
import { concat } from "./zip.ts";

/** The branch the history is written to. */
export const GIT_EXPORT_BRANCH = "refs/heads/main";

const encoder = new TextEncoder();

/**
 * A `git fast-import` stream of one artifact's revision history, built from a validated archive
 * and nothing else: one commit per revision, oldest first, on {@link GIT_EXPORT_BRANCH}. A learner
 * runs `git init && git fast-import < history.fi` to get an ordinary repository; SchoolOS hosts
 * nothing.
 *
 * Commit authors are the archive's export-local pseudonyms, with addresses under the reserved
 * `.invalid` domain, so the repository names nobody. Each commit holds one file, named from the
 * artifact's title; AI assistance is recorded in the commit message. Links (`external-ref`
 * artifacts) have no content and are refused with `validation-failed`.
 */
export function gitFastImport(archive: ValidatedArchive, artifactId: string): Uint8Array<ArrayBuffer> {
  const artifact = archive.artifacts.find((a) => a.id === artifactId);
  if (artifact === undefined) throw new SchoolOsError("not-found", `artifact ${artifactId} is not in this archive.`);
  if (artifact.type === "external-ref") throw new SchoolOsError("validation-failed", "A link has no content to put in a repository.");

  const parts: Uint8Array[] = [text("feature done\n")];
  let mark = 0;
  let previousCommit: number | undefined;
  for (const revision of artifact.revisions) {
    if (revision.content.kind !== "file") throw new Error(`${revision.id} has no file`);
    const bytes = archive.content(revision.content.path);
    const blob = ++mark;
    parts.push(text(`blob\nmark :${blob}\ndata ${bytes.byteLength}\n`), bytes, text("\n"));

    const commit = ++mark;
    const when = `${Math.floor(Date.parse(revision.createdAt) / 1000)} +0000`;
    const who = `${revision.author} <${revision.author}@export.schoolos.invalid>`;
    const message = text(commitMessage(revision.number, revision.origin, revision.aiAssistance));
    parts.push(
      text(`commit ${GIT_EXPORT_BRANCH}\nmark :${commit}\nauthor ${who} ${when}\ncommitter ${who} ${when}\ndata ${message.byteLength}\n`),
      message,
      text(`\n${previousCommit === undefined ? "" : `from :${previousCommit}\n`}deleteall\nM 100644 :${blob} ${fileName(artifact.title, revision.mediaType)}\n\n`),
    );
    previousCommit = commit;
  }
  parts.push(text("done\n"));
  return concat(parts);
}

function text(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value);
}

function commitMessage(number: number, origin: ArchivedRevision["origin"], ai: ArchivedRevision["aiAssistance"]): string {
  const subject = origin === "baseline" ? `Revision ${number} (baseline)` : `Revision ${number}`;
  return ai.level === "none" ? `${subject}\n` : `${subject}\n\nAI assistance: ${ai.level} (${ai.modelId})\n`;
}

/** A file name from the title: lowercase words joined by hyphens, which never needs quoting in fast-import. */
function fileName(title: string, mediaType: string): string {
  const slug = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  return `${slug === "" ? "work" : slug}.${extensionFor(mediaType)}`;
}
