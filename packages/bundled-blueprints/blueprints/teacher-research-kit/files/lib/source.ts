import type { WebSearchSession } from "./connector.d.ts";
import { sourceUrl, type BoardResult } from "@gadgets/bundled-blueprints/libraries/teacher-board/server";

/** Search excerpts remain attributed source text, never instructions or generated summaries. */
export async function readSource(search: Pick<WebSearchSession, "search"> | undefined, input: string): Promise<BoardResult> {
  const query = input.trim();
  if (!query || query.length > 1024) throw new Error("Enter 1 to 1,024 characters of search keywords.");
  if (!search) throw new Error("Enable Web Search, then ask the Workshop agent to bind WEB_SEARCH to this gadget.");
  const results = await search.search(query);
  return {
    title: query, subtitle: "Public web sources · excerpts are unverified source text, not teacher notes", refreshedAt: new Date().toISOString(),
    cards: results.slice(0, 10).map((result, index) => ({
      id: String(index), title: result.title, detail: result.description ?? "No excerpt supplied. Open the original page to review it.",
      label: "Search excerpt · review original", url: sourceUrl(result.url),
    })),
  };
}
