/** A Northfield configuration document in the roadmap §4.1 shape, as JSON. Each call is a fresh copy to edit. */
export function northfieldDocument(): Record<string, any> {
  return {
    apiVersion: "educateos.io/v1alpha1",
    district: "dst_northfield",
    profile: "us-k12-conservative",
    identity: { provider: "district-sso" },
    rostering: { provider: "oneroster-csv", mode: "preview-before-apply" },
    curriculum: { frameworks: ["CCSS", "NGSS", "C3", "CASEL"], importedSources: ["district-approved"] },
    modules: {
      "core-learning": "enabled",
      "teacher-studio": "enabled",
      "learning-registry": "enabled",
      "content-studio": "enabled",
      "assessment-ci": "advisory",
      playtrek: "disabled",
    },
    rollout: {
      target: "selected-course-offerings",
      offerings: ["off_nf-bio-fall-p2", "off_nf-eng9-fall-p3"],
      requiresAdminActivation: true,
    },
    policies: {
      ai: { spending: "capped", promptsInGatewayLogs: false },
      studentPersonalConversations: "private",
      teacherObservation: "assigned-work-only",
      automatedSelProfiling: "prohibited",
    },
  };
}

/** Scopes in Northfield, written out in full as overrides require. */
export const NF = {
  high: { level: "school", districtId: "dst_northfield", schoolId: "sch_nf-high" },
  middle: { level: "school", districtId: "dst_northfield", schoolId: "sch_nf-middle" },
  eng9: { level: "offering", districtId: "dst_northfield", schoolId: "sch_nf-high", offeringId: "off_nf-eng9-fall-p3" },
  bio: { level: "offering", districtId: "dst_northfield", schoolId: "sch_nf-high", offeringId: "off_nf-bio-fall-p2" },
  eng9Essay: {
    level: "activity",
    districtId: "dst_northfield",
    schoolId: "sch_nf-high",
    offeringId: "off_nf-eng9-fall-p3",
    activityId: "act_nf-eng9-essay",
  },
} as const;
