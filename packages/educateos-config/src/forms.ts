import { EducateOsError } from "@educateos/contracts";
import { GOVERNANCE_KEYWORD, type GovernanceArea } from "./packs.ts";

/** How an administrator form renders a field. */
export type FormFieldType = "string" | "url" | "integer" | "number" | "boolean" | "enum" | "multi-select" | "list";

/**
 * One field of a pack's administrator form, derived from the manifest's JSON Schema so the form can
 * never accept something the API would reject.
 */
export interface FormField {
  /** Dotted path into the pack configuration; `[]` marks the items of a list (`platforms[].issuer`). */
  path: string;
  /** The field's label: the schema's `title`, or the property name in sentence case. */
  label: string;
  /** Help text from the schema's `description`. */
  description?: string;
  /** How to render the field. */
  type: FormFieldType;
  /** The allowed values of an `enum` or `multi-select` field. */
  options?: string[];
  /** Whether the field must be filled in. Fields with a default never are. */
  required: boolean;
  /** The value used when the field is left empty. */
  default?: unknown;
  /** Inclusive lower bound of a numeric field. */
  minimum?: number;
  /** Inclusive upper bound of a numeric field. */
  maximum?: number;
  /** Set on a boolean whose `true` value widens AI use or student-data exposure. */
  governance?: GovernanceArea;
}

type JsonSchema = Record<string, unknown>;

function unsupported(path: string, what: string): never {
  throw new EducateOsError("validation-failed", `form generation does not support ${what} (at ${path})`);
}

function sentenceCase(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) unsupported(path, "a non-string enum");
  return value;
}

function objectFields(schema: JsonSchema, prefix: string): FormField[] {
  if (schema.type !== "object" || typeof schema.properties !== "object" || schema.properties === null) {
    unsupported(prefix || "(root)", "a schema that is not an object with properties");
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties as Record<string, JsonSchema>).flatMap(([key, property]) =>
    propertyFields(property, prefix === "" ? key : `${prefix}.${key}`, key, required.has(key))
  );
}

function propertyFields(property: JsonSchema, path: string, key: string, required: boolean): FormField[] {
  const base = {
    path,
    label: typeof property.title === "string" ? property.title : sentenceCase(key),
    ...(typeof property.description === "string" ? { description: property.description } : {}),
    required,
    ...("default" in property ? { default: property.default } : {}),
  };
  const governance = property[GOVERNANCE_KEYWORD];
  if (governance !== undefined && property.type !== "boolean") unsupported(path, "governance on a non-boolean field");
  switch (property.type) {
    case "boolean":
      return [{ ...base, type: "boolean", ...(governance === undefined ? {} : { governance: governance as GovernanceArea }) }];
    case "string":
      if (property.enum !== undefined) return [{ ...base, type: "enum", options: stringArray(property.enum, path) }];
      return [{ ...base, type: property.format === "uri" ? "url" : "string" }];
    case "integer":
    case "number":
      return [{
        ...base,
        type: property.type,
        ...(typeof property.minimum === "number" ? { minimum: property.minimum } : {}),
        ...(typeof property.maximum === "number" ? { maximum: property.maximum } : {}),
      }];
    case "object":
      return objectFields(property, path);
    case "array": {
      const items = property.items as JsonSchema | undefined;
      if (items?.type === "string" && items.enum !== undefined) {
        return [{ ...base, type: "multi-select", options: stringArray(items.enum, path) }];
      }
      if (items?.type === "object") return [{ ...base, type: "list" }, ...objectFields(items, `${path}[]`)];
      return unsupported(path, "an array of this item type");
    }
    default:
      return unsupported(path, `type ${JSON.stringify(property.type)}`);
  }
}

/**
 * The flat list of form fields for a pack's configuration JSON Schema, in schema order. It covers
 * the schema features the shipped manifests use and throws on anything else, so a new feature
 * fails loudly in tests rather than rendering a form that silently drops a field.
 */
export function formFields(configSchema: JsonSchema): FormField[] {
  return objectFields(configSchema, "");
}
