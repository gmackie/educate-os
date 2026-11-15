import type { Overseer } from "@gadgets/workshop-shared/api";
import { digestBytes } from "@educateos/assessment-sdk";
import { z } from "zod";
import { ActivityScope, Id, type Observation } from "./contracts.ts";
import { missingObservation, type LearningActivityAdapter } from "./runtime.ts";

/** Existing RPC signature, narrowed to the only method this read-only adapter needs. */
export type GadgetSource = Pick<Overseer, "readFilesAtCommit">;
/**
 * Observe explicitly selected files at an immutable Gadget commit. Source content is hashed,
 * never executed or copied into evidence. The host supplies an already-authorized RPC capability
 * and owns its disposal. No chat, whole-workspace discovery, getGadget or vendor access is needed.
 */
export function gadgetAdapter(options: {
  scope: ActivityScope; paths: string[]; source?: GadgetSource; now?: () => Date;
}): LearningActivityAdapter {
  const scope = ActivityScope.parse(options.scope);
  const commitId = z.string().regex(/^[a-f0-9]{40}$/).parse(scope.revision);
  const paths = z.array(Id.refine((path) => !path.startsWith("/")
    && !path.split("/").includes(".."))).min(1).max(32).parse(options.paths);
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate selected path");
  const source = options.source;
  const now = options.now ?? (() => new Date());
  return {
    descriptor: { id: "educateos-gadget", version: "1", actions: [
      { id: "selected-source", operation: "observe", surfaces: ["source"] },
      { id: "selected-artifacts", operation: "collect-evidence", surfaces: ["source"] },
    ] },
    async execute(request) {
      const fail = (status: Observation["status"], code: Observation["code"]) => [
        missingObservation(request, "source", status, code, now().toISOString()),
      ];
      if (Object.keys(scope).some((key) => scope[key as keyof ActivityScope] !== request.scope[key as keyof ActivityScope])) {
        return fail("error", "source-mismatch");
      }
      if (!source) return fail("unavailable", "not-connected");
      let files: Awaited<ReturnType<GadgetSource["readFilesAtCommit"]>>;
      try { files = await source.readFilesAtCommit(commitId, [...paths]); }
      catch { return fail("error", "transport-failed"); }
      // Cancel every returned stream even if a different path is absent. Large files require a
      // separate reviewed artifact flow; this adapter never buffers unbounded student content.
      await Promise.all(files.map(async ([, file]) => {
        if (file.kind === "stream") await file.content.cancel();
      }));
      if (files.length !== paths.length || new Set(files.map(([path]) => path)).size !== files.length
          || files.some(([path]) => !paths.includes(path))) return fail("unavailable", "missing");
      const artifacts: Observation["artifacts"] = [];
      for (const path of paths) {
        const file = files.find(([name]) => name === path)?.[1];
        if (!file || file.kind === "absent") return fail("unavailable", "missing");
        if (file.kind !== "text") return fail("unsupported", "not-supported");
        const bytes = new TextEncoder().encode(file.text);
        if (bytes.byteLength > 1_000_000) return fail("unsupported", "not-supported");
        artifacts.push({ id: path, kind: "code", digest: await digestBytes(bytes) });
      }
      return [{ surface: "source", sourceId: scope.sourceId, revision: commitId,
        observedAt: now().toISOString(), status: "observed", code: "ok", artifacts,
        measurements: [{ name: "selected-files", value: artifacts.length, unit: "count" }] }];
    },
  };
}
