import { planCourseCartridge } from "@educateos/cartridge/course";
import { readCartridge } from "@educateos/cartridge/package";
import { CartridgeRefusedError } from "@educateos/cartridge/errors";
import { ExtractionStopped, StepBudget, TextSink } from "./budget.ts";
import type { ExtractionLimits } from "./limits.ts";

/** Reuses the school course planner as a bounded, read-only source preview; stores nothing. */
export async function extractCartridgeText(bytes: Uint8Array, limits: ExtractionLimits, budget: StepBudget): Promise<{ text: string; truncated: boolean }> {
  try {
    const pkg = await readCartridge(bytes, {
      maxPackageBytes: limits.maxBytes,
      zip: { maxEntries: 200, maxEntryBytes: Math.min(limits.maxInflatedBytes, 256 * 1024), maxTotalBytes: limits.maxInflatedBytes, maxCompressionRatio: 100 },
      xml: { maxLength: 64 * 1024, maxDepth: 32, maxElements: 2000 },
    });
    const totalBytes = [...pkg.files.values()].reduce((n, file) => n + file.byteLength, 0);
    budget.spend(totalBytes);
    // Charge each file access, including repeated QTI references, before the shared planner
    // decodes/parses it. An archive-size cap alone cannot bound repeated placement work.
    class BudgetedFiles extends Map<string, Uint8Array> {
      override get(path: string): Uint8Array | undefined {
        const bytes = super.get(path);
        budget.spend(bytes?.byteLength ?? 1);
        return bytes;
      }
    }
    const stack = [...pkg.manifest.items];
    const referenced = new Set<string>();
    while (stack.length) {
      const item = stack.pop()!;
      budget.spend();
      if (item.resourceRef) referenced.add(item.resourceRef);
      stack.push(...item.children);
    }
    const plan = planCourseCartridge({ ...pkg, files: new BudgetedFiles(pkg.files) });
    const sink = new TextSink(limits.maxTextChars);
    const unplaced = pkg.manifest.resources.filter(resource => !referenced.has(resource.identifier)).length;
    // Coverage comes first, so even a short excerpt says what the preview omitted.
    sink.write(`Common Cartridge ${pkg.manifest.schemaVersion}; package ${pkg.packageDigest}\n`);
    sink.write(`Read-only preview: ${plan.modules.length} modules; ${plan.skipped.length} skipped placements; ${unplaced} unplaced resources; ${pkg.ignoredEntries.length} ignored archive entries; ${plan.flattened.length} flattened groups; ${plan.truncated.length} truncated items.\n`);
    sink.write("Links are references only; their contents have not been fetched. Files, unsupported quizzes and external tools may be skipped. No course, enrollment, grades or published content was created.\n");
    sink.write(JSON.stringify({ skipped: plan.skipped, flattened: plan.flattened, truncated: plan.truncated, title: plan.title, modules: plan.modules }));
    return { text: sink.text(), truncated: sink.truncated };
  } catch (error) {
    if (error instanceof CartridgeRefusedError) {
      throw new ExtractionStopped(["too-many-entries", "entry-too-large", "package-too-large", "compression-ratio", "xml-too-large"].includes(error.reason) ? "too-large" : "malformed");
    }
    throw error;
  }
}
