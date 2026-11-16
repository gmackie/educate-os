// `DISTRICT_CONFIG`, the district Worker's deployment configuration, as the answers file holds it:
// a JSON string under `install.services["educateos-district-worker"].vars`. The installer writes it
// to the Worker on the next apply, so a change here takes effect only once the install is applied
// again (which `connect` offers to do).
import { EducateOsError } from "@educateos/contracts";
import type { Answers } from "../answers.ts";
import { DISTRICT_PACKAGE } from "./district.ts";

type Json = Record<string, unknown>;

/** The district's configuration from the answers, parsed. Undefined when the install has no district. */
export function readDistrictConfig(answers: Pick<Answers, "install">): Json | undefined {
  const services = answers.install.services as Record<string, { vars?: Record<string, unknown> }> | undefined;
  const text = services?.[DISTRICT_PACKAGE]?.vars?.DISTRICT_CONFIG;
  if (typeof text !== "string") return undefined;
  try {
    const json = JSON.parse(text) as unknown;
    if (typeof json === "object" && json !== null && !Array.isArray(json)) return json as Json;
  } catch {
    // Falls through.
  }
  throw new EducateOsError("validation-failed", "DISTRICT_CONFIG in the answers file is not a JSON object");
}

/** The answers with `DISTRICT_CONFIG` replaced by `change(current)`. */
export function withDistrictConfig(answers: Answers, change: (config: Json) => Json): Answers {
  const current = readDistrictConfig(answers);
  if (current === undefined) throw new EducateOsError("not-found", "the answers file has no district configuration (DISTRICT_CONFIG)");
  const services = answers.install.services as Record<string, { vars: Record<string, unknown> }>;
  const district = services[DISTRICT_PACKAGE]!;
  return {
    ...answers,
    install: {
      ...answers.install,
      services: {
        ...services,
        [DISTRICT_PACKAGE]: { ...district, vars: { ...district.vars, DISTRICT_CONFIG: JSON.stringify(change(current)) } },
      },
    },
  };
}
