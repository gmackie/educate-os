// Scoring fixtures per item type (SCHO-191): what each response earns, deterministically.
import { describe, expect, it } from "vitest";
import { isSafePattern, QuizItem, scoreAttempt, scoreResponse, seededShuffle, ShortAnswerPattern, totalOf, type QuizResponse } from "../src/index.ts";
import { ITEMS } from "./items.ts";

const item = (draft: unknown) => QuizItem.parse(draft);

describe("scoring (SCHO-191)", () => {
  it("scores multiple choice and true/false all or nothing", () => {
    const mc = item(ITEMS.mc);
    expect(scoreResponse(mc, { type: "multiple-choice", choiceId: "b" })).toBe(2);
    expect(scoreResponse(mc, { type: "multiple-choice", choiceId: "a" })).toBe(0);
    expect(scoreResponse(mc, undefined)).toBe(0);
    // A response of another type earns nothing.
    expect(scoreResponse(mc, { type: "true-false", value: true })).toBe(0);
    const tf = item(ITEMS.tf);
    expect(scoreResponse(tf, { type: "true-false", value: false })).toBe(1);
    expect(scoreResponse(tf, { type: "true-false", value: true })).toBe(0);
  });

  it("scores multiple select with partial credit, never below zero, or all or nothing", () => {
    const partial = item(ITEMS.ms);
    const choose = (...choiceIds: string[]): QuizResponse => ({ type: "multiple-select", choiceIds });
    expect(scoreResponse(partial, choose("wall", "chloro", "vac"))).toBe(3);
    expect(scoreResponse(partial, choose("wall", "chloro"))).toBe(2);
    // Each wrong choice takes away a right one's share.
    expect(scoreResponse(partial, choose("wall", "chloro", "centri"))).toBe(1);
    expect(scoreResponse(partial, choose("centri"))).toBe(0);
    expect(scoreResponse(partial, choose())).toBe(0);
    const strict = item({ ...ITEMS.ms, scoring: "all-or-nothing" });
    expect(scoreResponse(strict, choose("vac", "wall", "chloro"))).toBe(3);
    expect(scoreResponse(strict, choose("wall", "chloro"))).toBe(0);
    expect(scoreResponse(strict, choose("wall", "chloro", "vac", "centri"))).toBe(0);
    // Thirds stay exact to four places.
    expect(scoreResponse(item({ ...ITEMS.ms, points: 1 }), choose("wall"))).toBe(0.3333);
  });

  it("scores numbers within an absolute tolerance", () => {
    const num = item(ITEMS.num);
    for (const value of [46, 45.5, 46.5]) expect(scoreResponse(num, { type: "numeric", value }), String(value)).toBe(1);
    for (const value of [45.4, 46.51, -46]) expect(scoreResponse(num, { type: "numeric", value }), String(value)).toBe(0);
    const exact = item({ ...ITEMS.num, answer: 0.3, tolerance: 0 });
    expect(scoreResponse(exact, { type: "numeric", value: 0.1 + 0.2 })).toBe(1);
    expect(scoreResponse(exact, { type: "numeric", value: 0.31 })).toBe(0);
  });

  it("scores short answers case-insensitively against the list, or the whole answer against a safe pattern", () => {
    const short = item({ ...ITEMS.short, pattern: undefined });
    for (const text of ["photosynthesis", "  PhotoSynthesis ", "photosynthesis"]) expect(scoreResponse(short, { type: "short-answer", text }), text).toBe(1);
    for (const text of ["photo synthesis", "photosynthesis!", "", "   "]) expect(scoreResponse(short, { type: "short-answer", text }), text).toBe(0);
    const patterned = item(ITEMS.short);
    expect(scoreResponse(patterned, { type: "short-answer", text: "Photo-synthesis" })).toBe(1);
    // The pattern matches the whole answer, not part of it.
    expect(scoreResponse(patterned, { type: "short-answer", text: "not photosynthesis at all" })).toBe(0);
    const spaced = item({ ...ITEMS.short, acceptedAnswers: ["Golgi  apparatus"], pattern: undefined });
    expect(scoreResponse(spaced, { type: "short-answer", text: "golgi apparatus" })).toBe(1);
  });

  it("refuses patterns that could run away, and caps what a pattern runs on", () => {
    for (const safe of ["photo-?synthesis", "colou?r", "[a-z]+ase", "(mito|chloro)plast", "\\d{2,3}", "(ab)?c"]) expect(isSafePattern(safe), safe).toBe(true);
    for (const unsafe of ["(a+)+", "(a*)*b", "(a|aa)+", "((ab)*)+", "(.*){3}", "(\\w+\\s?)*$", "(a)\\1", "(?=a)a", "(?<!a)b", "[", "", "x".repeat(201)]) {
      expect(isSafePattern(unsafe), unsafe).toBe(false);
    }
    expect(ShortAnswerPattern.safeParse("(a+)+").success).toBe(false);
    expect(QuizItem.safeParse({ ...ITEMS.short, pattern: "(x+)+y" }).success).toBe(false);
    // An answer longer than any accepted one never reaches the pattern.
    expect(scoreResponse(item({ ...ITEMS.short, acceptedAnswers: [], pattern: "a.*" }), { type: "short-answer", text: `a${"b".repeat(250)}` })).toBe(0);
  });

  it("leaves essays for a teacher, so an attempt with one has no total yet", () => {
    const items = Object.values(ITEMS).map(item);
    expect(scoreResponse(items.at(-1)!, { type: "essay", text: "Anything" })).toBeNull();
    const scores = scoreAttempt(items, [{ itemId: "qzi_mc", response: { type: "multiple-choice", choiceId: "b" } }]);
    expect(scores.map((s) => s.points)).toEqual([2, 0, 0, 0, 0, null]);
    expect(totalOf(scores)).toEqual({ points: null, maxPoints: 13 });
    expect(totalOf(scores.slice(0, 5))).toEqual({ points: 2, maxPoints: 8 });
  });

  it("checks keys against their items", () => {
    expect(QuizItem.safeParse({ ...ITEMS.mc, correctChoiceId: "z" }).success).toBe(false);
    expect(QuizItem.safeParse({ ...ITEMS.ms, correctChoiceIds: ["wall", "wall"] }).success).toBe(false);
    expect(QuizItem.safeParse({ ...ITEMS.short, acceptedAnswers: [], pattern: undefined }).success).toBe(false);
    expect(QuizItem.safeParse({ ...ITEMS.mc, prompt: "<script>alert(1)</script>" }).success).toBe(false);
  });

  it("shuffles the same way for the same seed and differently for others", () => {
    const values = Array.from({ length: 12 }, (_, i) => i);
    const once = seededShuffle(values, "0123456789abcdef", "questions");
    expect(seededShuffle(values, "0123456789abcdef", "questions")).toEqual(once);
    expect(once.toSorted((a, b) => a - b)).toEqual(values);
    expect(seededShuffle(values, "fedcba9876543210", "questions")).not.toEqual(once);
    expect(seededShuffle(values, "0123456789abcdef", "qzi_mc")).not.toEqual(once);
  });
});
