// What every bundled tutor must be, checked from its persona, its blueprint.json and the prompt the
// library builds from it: deterministic stand-ins for evals, since the Workshop's eval harness
// (packages/workshop-evals) grades agents building gadgets, not a gadget's own model calls. Each
// blueprint's test runs these and adds its own band's checks.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { TUTOR_GRADE_BANDS, holdsPersonalDetails, systemPromptFor, type TutorPersona } from "../server.ts";

/** The guard config the schoolos.gmac.io instance runs with: what a tutor's model must be priced in. */
const GUARD_CONFIG = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../deploy/schoolos-gmac-io/ai-guard-config.example.json", import.meta.url)), "utf8")) as {
  modelRates: { provider: string; modelId: string }[];
  fundingPools: { allowedModels?: { provider: string; modelId: string }[] }[];
};

/** A blueprint's manifest, read from its directory. */
export function manifestOf(blueprintDir: URL): {
  blueprintId: string;
  bindings: Record<string, { type: string; audience?: string; suggestedModel?: { provider: string; modelName: string } }>;
} {
  return JSON.parse(readFileSync(fileURLToPath(new URL("blueprint.json", blueprintDir)), "utf8"));
}

/** The checks every tutor passes. Returns its system prompt, for the band's own checks. */
export function checkTutor(persona: TutorPersona, blueprintDir: URL): string {
  const manifest = manifestOf(blueprintDir);
  expect(manifest.blueprintId).toBe(`educateos.tutor-${persona.band === "K-2" ? "k2" : persona.band}`);

  // The band the guard screens at is the persona's, declared on the blueprint's one model binding.
  expect(Object.keys(manifest.bindings)).toEqual(["LLM"]);
  const binding = manifest.bindings.LLM!;
  expect(binding).toMatchObject({ type: "aiModel", audience: persona.band });
  expect(TUTOR_GRADE_BANDS).toContain(binding.audience);

  // Its suggested model is a Workers AI model the production guard prices and funds.
  const model = binding.suggestedModel!;
  expect(model.provider).toBe("cloudflare");
  expect(GUARD_CONFIG.modelRates).toContainEqual(expect.objectContaining({ provider: "cloudflare", modelId: model.modelName }));
  expect(GUARD_CONFIG.fundingPools.some((pool) => pool.allowedModels?.some((allowed) => allowed.modelId === model.modelName))).toBe(true);

  const prompt = systemPromptFor(persona);
  // Refuses off-topic and unsafe requests, collects no personal data, points to a trusted adult.
  expect(prompt).toContain(`Stay on ${persona.focus}`);
  expect(prompt).toMatch(/Never ask for personal information/);
  expect(prompt).toMatch(/Refuse anything unsafe/);
  expect(prompt).toMatch(/trusted adult/);
  expect(persona.helpNote).toMatch(/teacher|trusted adult|grown-up/);
  // Its own words never ask for anything private, and its privacy reply never repeats any.
  for (const text of [persona.greeting, persona.privacyReply, ...persona.quickReplies]) {
    expect(text).not.toMatch(/\byour (full )?name\b|\bhow old\b|\bwhere do you live\b|\byour school\b|\bphone\b|\bemail\b/i);
    expect(holdsPersonalDetails(text)).toBe(false);
  }
  expect(persona.rules.length).toBeGreaterThanOrEqual(5);
  return prompt;
}

/** Roughly the average sentence length of `text`, in words: a reading-level check on a tutor's own lines. */
export function wordsPerSentence(text: string): number {
  const sentences = text.split(/[.!?]+/).map((sentence) => sentence.trim()).filter(Boolean);
  const words = sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).length, 0);
  return words / sentences.length;
}
