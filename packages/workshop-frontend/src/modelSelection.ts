import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";

const LAST_SELECTED_MODEL_KEY = "lastSelectedModel";

/** Sentinel used for UI values and localStorage so an explicit null choice can persist. */
export const NO_AGENT_OPTION_VALUE = "__gadgets_no_agent__";

/**
 * The model a new conversation starts on: this browser's last pick while it is offered (an explicit
 * "No agent" included), else the user's own preferred model (chosen at onboarding, kept by the
 * server so a new browser honours it) while it is offered, else the first model.
 */
export function getStoredSelectedModel(
  models: AiChatAuthorInfo[],
  preferredModel: string | null,
): string | null {
  const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_KEY);

  if (storedModel === NO_AGENT_OPTION_VALUE) {
    return null;
  }

  if (storedModel && models.some((model) => model.id === storedModel)) {
    return storedModel;
  }

  return (models.find((model) => model.id === preferredModel) ?? models[0])?.id ?? null;
}

export function persistSelectedModel(modelId: string | null): void {
  localStorage.setItem(
    LAST_SELECTED_MODEL_KEY,
    modelId ?? NO_AGENT_OPTION_VALUE,
  );
}

export function toModelSelectValue(modelId: string | null): string {
  return modelId ?? NO_AGENT_OPTION_VALUE;
}

export function fromModelSelectValue(value: string): string | null {
  return value === NO_AGENT_OPTION_VALUE ? null : value;
}
