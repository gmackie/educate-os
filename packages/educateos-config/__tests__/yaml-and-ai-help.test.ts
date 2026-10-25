import { PrincipalId, Scope } from "@educateos/contracts";
import { describe, expect, it } from "vitest";
import {
  SHIPPED_REGISTRY,
  aiHelpLayersAt,
  compileDistrictConfig,
  createDraftRevision,
  readYamlConfigDocument,
  type DesiredState,
} from "../src/index.ts";
import { NF, northfieldDocument } from "./support.ts";

const NORTHFIELD_YAML = `
apiVersion: educateos.io/v1alpha1
district: dst_northfield
profile: us-k12-conservative
identity: { provider: district-sso }
rostering:
  provider: oneroster-csv
  mode: preview-before-apply
curriculum:
  frameworks: [CCSS, NGSS, C3, CASEL]
  importedSources: [district-approved]
modules:
  core-learning: enabled
  teacher-studio: enabled
  learning-registry: enabled
  content-studio: enabled
  assessment-ci: advisory
  playtrek: disabled
rollout:
  target: selected-course-offerings
  offerings: [off_nf-bio-fall-p2, off_nf-eng9-fall-p3]
  requiresAdminActivation: true
policies:
  ai: { spending: capped, promptsInGatewayLogs: false }
  studentPersonalConversations: private
  teacherObservation: assigned-work-only
  automatedSelProfiling: prohibited
`;

describe("readYamlConfigDocument", () => {
  it("reads a YAML document to the same configuration as its JSON", async () => {
    const read = readYamlConfigDocument(NORTHFIELD_YAML);
    expect(read).toEqual({ ok: true, value: northfieldDocument() });
  });

  it.each([
    ["an anchor and alias", "district: &d dst_northfield\nother: *d\n", "anchors are not allowed (line 1)"],
    ["an explicit tag", "district: !!str dst_northfield\n", "tags are not allowed (line 1)"],
    ["a custom tag", "district: !include secrets.yaml\n", "tags are not allowed (line 1)"],
    ["a duplicate key", "district: a\ndistrict: b\n", "Map keys must be unique (line 2)"],
    ["a key that is not a string", "? [a, b]\n: 1\n", "With stringKeys, all keys must be strings (line 1)"],
    ["two documents", "a: 1\n---\nb: 2\n", "a configuration is exactly one YAML document"],
  ])("refuses %s", (_what, text, message) => {
    const read = readYamlConfigDocument(text);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problems).toContainEqual({ code: "invalid-yaml", path: "", message });
  });

  it("refuses an alias bomb without expanding it", () => {
    const levels = Array.from({ length: 12 }, (_, i) => `l${i + 1}: &l${i + 1} [${Array(10).fill(`*l${i}`).join(", ")}]`);
    const bomb = ["l0: &l0 boom", ...levels].join("\n");
    const read = readYamlConfigDocument(bomb);
    expect(read.ok).toBe(false);
  });

  it("never quotes the document in a problem", () => {
    const read = readYamlConfigDocument("token: !!str sk-live-abcdefghijklmnop\n");
    expect(JSON.stringify(read)).not.toContain("sk-live");
  });
});

const offering = (scope: unknown) => Scope.parse(scope) as Extract<Scope, { level: "offering" }>;

describe("aiHelp in the policy floor", () => {
  const ADMIN = PrincipalId.parse("prn_nf-district-admin");

  async function desiredOf(document: unknown): Promise<DesiredState> {
    const result = await createDraftRevision({ document, registry: SHIPPED_REGISTRY, actorPrincipalId: ADMIN });
    if (!result.ok) throw new Error(JSON.stringify(result.problems));
    return result.compiled.desired;
  }

  it("compiles per scope: the profile sets the district level and overrides only tighten it", async () => {
    const document = northfieldDocument();
    document.profile = "us-k12-standard";
    document.overrides = [
      { scope: NF.high, policies: { ai: { help: "hints-only" } } },
      { scope: NF.eng9, policies: { ai: { help: "none" } } },
    ];
    const desired = await desiredOf(document);
    expect(desired.policies.aiHelp).toBe("full");
    expect(aiHelpLayersAt(desired, offering(NF.eng9))).toEqual({ district: "full", school: "hints-only", offering: "none" });
    expect(aiHelpLayersAt(desired, offering(NF.bio))).toEqual({ district: "full", school: "hints-only" });
  });

  it("refuses an override that loosens the district's AI-help level", () => {
    const document = northfieldDocument();
    document.policies.ai.help = "none";
    document.overrides = [{ scope: NF.eng9, policies: { ai: { help: "full" } } }];
    const result = compileDistrictConfig(document, SHIPPED_REGISTRY);
    expect(result).toEqual({
      ok: false,
      problems: [{
        code: "policy-violation",
        path: "/overrides/0/policies",
        message: "a offering override cannot loosen aiHelp from none to full",
      }],
    });
  });

  it("reads a revision compiled before aiHelp existed as its profile's level, and no revision as the initial profile's", async () => {
    const desired = await desiredOf(northfieldDocument());
    const legacy = { ...desired, policies: { ...desired.policies } };
    delete legacy.policies.aiHelp;
    expect(aiHelpLayersAt(legacy, offering(NF.eng9))).toEqual({ district: "hints-only" });
    expect(aiHelpLayersAt(undefined, offering(NF.eng9))).toEqual({ district: "hints-only" });
  });
});
