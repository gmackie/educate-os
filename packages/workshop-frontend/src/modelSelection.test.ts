// @vitest-environment jsdom
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it } from "vitest";
import { NO_AGENT_OPTION_VALUE, getStoredSelectedModel, persistSelectedModel } from "./modelSelection";

const models: AiChatAuthorInfo[] = [
  { type: "agent", id: "sonnet", name: "Sonnet" },
  { type: "agent", id: "opus", name: "Opus" },
];

afterEach(() => localStorage.clear());

describe("getStoredSelectedModel", () => {
  it("starts on the user's onboarding choice when this browser has saved none", () => {
    expect(getStoredSelectedModel(models, "opus")).toBe("opus");
  });

  it("starts on the first model when the onboarding choice is no longer offered, or there is none", () => {
    expect(getStoredSelectedModel(models, "retired-model")).toBe("sonnet");
    expect(getStoredSelectedModel(models, null)).toBe("sonnet");
    expect(getStoredSelectedModel([], "opus")).toBeNull();
  });

  it("prefers this browser's last pick over the onboarding choice", () => {
    persistSelectedModel("sonnet");
    expect(getStoredSelectedModel(models, "opus")).toBe("sonnet");
    persistSelectedModel(null);
    expect(localStorage.getItem("lastSelectedModel")).toBe(NO_AGENT_OPTION_VALUE);
    expect(getStoredSelectedModel(models, "opus")).toBeNull();
  });

  it("falls back to the onboarding choice when this browser's pick is no longer offered", () => {
    persistSelectedModel("retired-model");
    expect(getStoredSelectedModel(models, "opus")).toBe("opus");
  });
});
