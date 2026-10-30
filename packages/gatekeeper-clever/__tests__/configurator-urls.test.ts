// The resource URL patterns, the server-side parser and the configurators each describe Clever's
// resource URLs, and none can share code: the patterns are strings the Workshop matches, and each
// configurator is transpiled alone, with no runtime imports. This test keeps them in step: a URL
// resolves, through the function the Workshop uses, to the resource the parser makes of it, and
// every configurator's URL resolves back to its card's types and pre-fills itself again.

import { describe, expect, it } from "vitest";
import { resolveRequestedResource } from "@gadgets/workshop-shared/gatekeeper";
import districtConfigurator from "../src/configurator/clever-district-configurator-ui.js";
import profileConfigurator from "../src/configurator/clever-profile-configurator-ui.js";
import studentConfigurator from "../src/configurator/clever-student-configurator-ui.js";
import teacherConfigurator from "../src/configurator/clever-teacher-configurator-ui.js";
import {
  DISTRICT_PATTERN, PROFILE_PATTERN, RESOURCE_BY_KIND, SECTION_PATTERN, STUDENT_PATTERN, STUDENT_SECTION_PATTERN,
  SUPPORTED_RESOURCES, TEACHER_PATTERN, parseResourceUrl, resourceUrlOf, type CleverTarget,
} from "../src/clever-env";

const ui = new Proxy({}, {
  get(_target, property) { throw new Error(`the configurator must not call ui.${String(property)}`); },
}) as never;

const SECTION = "0123456789abcdef01234567";

const TARGETS: CleverTarget[] = [
  { kind: "profile" },
  { kind: "teacher" },
  { kind: "section", sectionId: SECTION },
  { kind: "student" },
  { kind: "studentSection", sectionId: SECTION },
  { kind: "district" },
];

function resolved(url: string) {
  const result = resolveRequestedResource(SUPPORTED_RESOURCES, url);
  return result.ok ? result.resource.urlPattern : undefined;
}

describe("resource URLs", () => {
  it.each(TARGETS)("$kind resolves to its own type and parses back to itself", target => {
    const url = resourceUrlOf(target);
    expect(resolved(url)).toBe(RESOURCE_BY_KIND[target.kind].urlPattern);
    expect(resolved(`${url}/`)).toBe(RESOURCE_BY_KIND[target.kind].urlPattern);
    expect(parseResourceUrl(url)).toEqual(target);
    expect(parseResourceUrl(`${url}/`)).toEqual(target);
  });

  it("refuses anything else", () => {
    for (const url of [
      "https://api.clever.com/sections/not-an-id",
      "https://api.clever.com/sections/../users",
      "https://clever.com/me",
      "http://api.clever.com/me",
      "https://api.clever.com/me?x=1",
      "https://api.clever.com/v3.1/sections",
    ]) expect(() => parseResourceUrl(url)).toThrow(/not a Clever resource URL/);
  });

  it("groups each one-section type on its role's card", () => {
    expect(RESOURCE_BY_KIND.section.groupedWith).toBe(TEACHER_PATTERN);
    expect(RESOURCE_BY_KIND.studentSection.groupedWith).toBe(STUDENT_PATTERN);
    expect(SUPPORTED_RESOURCES.filter(resource => resource.groupedWith === undefined).map(resource => resource.urlPattern))
      .toEqual([PROFILE_PATTERN, TEACHER_PATTERN, STUDENT_PATTERN, DISTRICT_PATTERN]);
    expect(SUPPORTED_RESOURCES.some(resource => resource.grantable)).toBe(false);
  });
});

describe("configurators", () => {
  it.each([
    [teacherConfigurator, TEACHER_PATTERN, SECTION_PATTERN, "teacher", "section"],
    [studentConfigurator, STUDENT_PATTERN, STUDENT_SECTION_PATTERN, "student", "studentSection"],
  ] as const)("a section picker returns every section or one, and pre-fills from either", async (spec, all, one, allKind, oneKind) => {
    const context = { ui, acceptedResourceUrlPatterns: [all, one] };
    const every = await spec.resourceUrl({ ...context, values: { target: "all" } });
    expect(parseResourceUrl(every)).toEqual({ kind: allKind });
    const single = await spec.resourceUrl({ ...context, values: { target: SECTION } });
    expect(parseResourceUrl(single)).toEqual({ kind: oneKind, sectionId: SECTION });
    expect(await spec.initialValuesFromResourceUrl!({ resourceUrl: every, resourceUrlPattern: all, ui })).toEqual({ target: "all" });
    expect(await spec.initialValuesFromResourceUrl!({ resourceUrl: single, resourceUrlPattern: one, ui })).toEqual({ target: SECTION });
  });

  it("a section picker offers only the types the Workshop will take", () => {
    const onlyOne = { acceptedResourceUrlPatterns: [SECTION_PATTERN] };
    expect(teacherConfigurator.isReady!({ ...onlyOne, values: { target: "all" } })).toBe(false);
    expect(teacherConfigurator.isReady!({ ...onlyOne, values: { target: SECTION } })).toBe(true);
    expect(teacherConfigurator.isReady!({ values: { target: "nonsense" } })).toBe(false);
  });

  it("the profile and district cards name their own resources", async () => {
    expect(parseResourceUrl(await profileConfigurator.resourceUrl())).toEqual({ kind: "profile" });
    // The district card refuses until it knows the user is an administrator.
    expect(() => districtConfigurator.resourceUrl()).toThrow(/district administrator/);
  });
});
