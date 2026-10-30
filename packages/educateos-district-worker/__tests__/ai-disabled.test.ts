// `/ai` on a district with no Workshop and no router in front (ADR-0014 D7, SCHO-259).
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { aiDisabledResponse, isAiPath } from "../src/ai-disabled.ts";

/** Fetches through the deployed fetch handler, reading the body so the pool can evict. */
async function fetchWorker(input: Request): Promise<{ response: Response; body: string }> {
  const response = await SELF.fetch(input);
  return { response, body: await response.text() };
}

describe("the AI-not-enabled page", () => {
  it("is what the Worker answers at /ai and under it, with no sign-in and no link when no demo is configured", async () => {
    for (const path of ["/ai", "/ai/", "/ai/new?context=assignment:1"]) {
      const { response, body } = await fetchWorker(new Request(`https://riverbend.educateos.io${path}`));
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toContain("AI isn't enabled at your school");
      expect(body).not.toContain("demo district");
    }
  });

  it("answers its API with a plain 404, and leaves look-alike paths to the district", async () => {
    const api = await fetchWorker(new Request("https://riverbend.educateos.io/ai/api/x", { method: "POST", body: "{}" }));
    expect(api.response.status).toBe(404);
    expect(api.body).toBe("AI isn't enabled at this school.");
    expect(isAiPath("/aide")).toBe(false);
    expect(isAiPath("/api/ai")).toBe(false);
    const aide = await fetchWorker(new Request("https://riverbend.educateos.io/aide"));
    expect(aide.response.status).toBe(404);
    expect(aide.body).toBe("");
  });

  it("links to the AI-enabled demo district, escaping the URL, and never to a script URL", async () => {
    const page = (url: string | undefined) => aiDisabledResponse(new Request("https://riverbend.educateos.io/ai"), url).text();
    expect(await page("https://northfield.educateos.io/ai/")).toContain('<a href="https://northfield.educateos.io/ai/">');
    expect(await page("javascript:alert(1)")).not.toContain("demo district");
    expect(await page('https://demo.example/?a="><script>')).not.toContain('"><script>');
  });

  it("answers HEAD with no body and refuses other methods on the page", async () => {
    const head = aiDisabledResponse(new Request("https://riverbend.educateos.io/ai", { method: "HEAD" }), undefined);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(aiDisabledResponse(new Request("https://riverbend.educateos.io/ai", { method: "POST" }), undefined).status).toBe(405);
  });
});
