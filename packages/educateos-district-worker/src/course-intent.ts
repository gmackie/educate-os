// Optional internal Worker service binding for teacher course-intent inference.
// A district deployer must configure BOTH the trusted service binding and model
// settings. The called Worker owns provider credentials, inference and its price book.
// This module never exposes the binding URL or credentials to a browser.
import { ModelRef, TokenUsage, type UsdNano } from "@educateos/ai-governance";
import type { CourseIntentProvider } from "@educateos/district-app";
import { z } from "zod";

export const CourseIntentBindingSettings = z.strictObject({
  model: ModelRef,
  /** Maximum billed amount for this adapter, in nanodollars. */
  estimatedMaxUsdNano: z.string().regex(/^[1-9][0-9]{0,29}$/),
});
export type CourseIntentBindingSettings = z.infer<typeof CourseIntentBindingSettings>;

const ProviderReply = z.strictObject({
  intent: z.unknown(),
  usage: TokenUsage,
  actualUsdNano: z.string().regex(/^(0|[1-9][0-9]{0,29})$/),
});

export function boundCourseIntentProvider(binding: { fetch(request: Request): Promise<Response> }, settingsJson: string | undefined): CourseIntentProvider {
  if (settingsJson === undefined || settingsJson.trim() === "") {
    throw new Error("COURSE_INTENT_MODEL must be provided with the course inference service binding.");
  }
  let input: unknown;
  try {
    input = JSON.parse(settingsJson);
  } catch {
    throw new Error("COURSE_INTENT_MODEL is not valid JSON.");
  }
  const settings = CourseIntentBindingSettings.parse(input);
  return {
    model: settings.model,
    estimatedMaxUsdNano: settings.estimatedMaxUsdNano as UsdNano,
    async generate(payload) {
      // Host is purely an internal service-binding request target; no public fetch.
      const response = await binding.fetch(new Request("https://course-intent.internal/propose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: settings.model, ...payload }),
      }));
      if (!response.ok) throw new Error("Configured district inference service failed.");
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (declaredLength > 128 * 1024) throw new Error("AI suggestion response is too large.");
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 128 * 1024) throw new Error("AI suggestion response is too large.");
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error("The district inference service returned invalid JSON.");
      }
      const result = ProviderReply.safeParse(json);
      if (!result.success) throw new Error("The district inference service returned an invalid billing or suggestion record.");
      return { intent: result.data.intent, usage: result.data.usage, actualUsdNano: result.data.actualUsdNano };
    },
  };
}
