import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, satisfies } from "../src/index.ts";

describe("satisfies", () => {
  it("matches an exact range only at that version", () => {
    expect(satisfies("1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.4", "1.2.3")).toBe(false);
    expect(satisfies("1.2.3-rc.1", "1.2.3")).toBe(false);
  });

  it("lets a caret range move everything right of the left-most non-zero component", () => {
    expect(satisfies("1.9.0", "^1.2.3")).toBe(true);
    expect(satisfies("1.2.2", "^1.2.3")).toBe(false);
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false);
    expect(satisfies("0.2.9", "^0.2.3")).toBe(true);
    expect(satisfies("0.3.0", "^0.2.3")).toBe(false);
    expect(satisfies("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfies("0.0.4", "^0.0.3")).toBe(false);
  });

  it("lets a tilde range move the patch only", () => {
    expect(satisfies("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfies("1.3.0", "~1.2.3")).toBe(false);
    expect(satisfies("0.1.5", "~0.1.0")).toBe(true);
  });

  it("never lets a release range pick up a prerelease", () => {
    expect(satisfies("1.3.0-beta.1", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.1-beta.1", "~1.0.0")).toBe(false);
    expect(satisfies("1.0.0-beta.2", "^1.0.0-beta.1")).toBe(true);
    expect(satisfies("1.0.0", "^1.0.0-beta.1")).toBe(true);
    expect(satisfies("1.0.1-beta.1", "^1.0.0-beta.1")).toBe(false);
  });

  it("reports ranges it does not understand instead of guessing", () => {
    for (const range of [">=1.0.0", "1.x", "*", "^1.0", "1.0.0 || 2.0.0", "v1.0.0", "^01.0.0"]) {
      expect(satisfies("1.0.0", range), range).toBeUndefined();
    }
    expect(satisfies("latest", "^1.0.0")).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("follows SemVer 2.0.0 precedence", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0"];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(parseVersion(ordered[i - 1]!)!, parseVersion(ordered[i]!)!), ordered[i]).toBeLessThan(0);
    }
  });
});
