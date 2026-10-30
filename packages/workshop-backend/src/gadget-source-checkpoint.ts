import type { GadgetSourceCheckpoint } from "@gadgets/workshop-shared/gatekeeper";

const encoder = new TextEncoder();
const forbiddenPath = /(?:^|[/._-])(?:secrets?|credentials?|bindings?|chat|transcripts?|tests?|spec|fixtures?|rubrics?|answers?|hidden|private|node_modules)(?:$|[/._-])/i;
const credential = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{20,})|\b(?:password|api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*["'`][^"'`\s]{4,}["'`]/i;

/**
 * Export the entire executable tree or refuse it; silently dropping a file would misrepresent
 * the pinned executable. Screening is conservative defense in depth, not secret detection proof:
 * the user must review the exact source before transfer. Inputs come only from the owner's store.
 */
export async function createGadgetSourceCheckpoint(
  identity: Pick<GadgetSourceCheckpoint, "workspaceId" | "gadgetId" | "commitId" | "blueprint">,
  source: ReadonlyMap<string, string>,
): Promise<GadgetSourceCheckpoint> {
  if (!/^[a-f0-9]{40}$/.test(identity.commitId) ||
      !/^[a-f0-9]{40}$/.test(identity.blueprint.commitId) || !identity.blueprint.id) {
    throw new Error("Checkpoint has no verified source revision or Blueprint origin.");
  }
  if (!source.has("server.js") || source.size > 32) {
    throw new Error("Checkpoint requires a committed server.js and at most 32 source files.");
  }
  const files = [...source].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [path, content] of files) {
    if ((!/^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*\.(?:js|jsx|ts|tsx|css|html)$/.test(path) &&
        path !== "educateos.assessment.json") ||
        forbiddenPath.test(path) || content.includes("\0") || credential.test(content)) {
      // Deliberately omit paths and offending values; these may themselves contain secrets.
      throw new Error("Checkpoint export refused: source contains an unsupported or sensitive file.");
    }
  }
  const bytes = encoder.encode(JSON.stringify(files));
  if (bytes.byteLength > 128 * 1024) throw new Error("Checkpoint exceeds the 128 KiB source limit.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    format: "workshop.gadget-source.v1", policy: "educateos-source-v1", ...identity,
    blueprint: {...identity.blueprint}, files,
    sourceDigest: `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`,
  };
}
