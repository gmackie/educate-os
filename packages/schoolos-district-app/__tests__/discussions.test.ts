// Course discussions (SCHO-190) through the district API: a teacher opens a topic, students post
// and reply, Hall Monitor screens student posts where the district enables it, and the teacher
// moderates; a graded topic's posts show up where the teacher grades participation.
import { describe, expect, it } from "vitest";
import type { DiscussionScreening } from "@schoolos/discussions";
import { bootDistrict, expectError, NF, RB, RIVERBEND, teacherSetsUpEssay } from "./support.ts";

/** A stand-in for Hall Monitor: `[[block]]`, `[[support]]`, `[[hold]]` and `[[coach]]` pick that decision; `[[down]]` fails. */
function fakeHallMonitor(): DiscussionScreening & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    settings: { tenantId: "tenant-nf", profileId: "student-9-12", revision: "rev-1", costCenterId: "cc-safety" },
    hallMonitor: {
      async evaluate(request) {
        const text = request.content.type === "text" ? request.content.text : "";
        texts.push(text);
        if (text.includes("[[down]]")) throw new Error("unavailable");
        const decision = (["block", "support", "hold", "coach"] as const).find((d) => text.includes(`[[${d}]]`)) ?? "allow";
        return { decision, reasonCodes: decision === "allow" ? [] : [`moderation.${decision}`] };
      },
    },
  };
}

describe("course discussions (SCHO-190)", () => {
  it("runs a threaded discussion that students read with names, and the teacher moderates", async () => {
    const district = await bootDistrict();
    const rivera = district.tokenFor(NF.rivera);
    const amara = district.tokenFor(NF.amara);
    const elena = district.tokenFor(NF.elena);
    const topic = await district.ok(rivera, "teacher.createTopic", {
      params: { offeringId: NF.eng9 }, body: { title: "Should homework be banned?", prompt: "Take a side and give **one** reason." },
    });
    const listing = await district.ok(amara, "student.listDiscussions", { params: { offeringId: NF.eng9 } });
    expect(listing).toMatchObject({ view: "student", canModerate: false, topics: [{ topic: { id: topic.id }, posts: 0 }] });

    const root = await district.ok(amara, "student.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "Yes: sleep matters." } });
    expect(root).toMatchObject({ status: "visible", mine: true });
    expect(JSON.stringify(root)).not.toContain("flags");
    const reply = await district.ok(elena, "student.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "Practice matters too.", parentId: root.id } });

    const thread = await district.ok(elena, "student.discussionThread", { params: { offeringId: NF.eng9, topicId: topic.id } });
    expect(thread.posts.map((p) => p.id)).toStrictEqual([root.id, reply.id]);
    expect(thread.authors.map((a) => a.principalId).toSorted()).toStrictEqual([NF.amara, NF.elena].toSorted());

    // Elena reports Amara's post; the teacher sees the flag and hides it.
    await district.ok(elena, "student.reportPost", { params: { offeringId: NF.eng9, postId: root.id }, body: { reason: "unkind" } });
    const queue = await district.ok(rivera, "teacher.moderationQueue", { params: { offeringId: NF.eng9 } });
    expect(queue.flagged.map((p) => p.id)).toStrictEqual([root.id]);
    expect(queue.authors.map((a) => a.principalId)).toStrictEqual([NF.amara]);
    await district.ok(rivera, "teacher.moderatePost", { params: { offeringId: NF.eng9, postId: root.id }, body: { decision: "hide" } });
    const after = await district.ok(elena, "student.discussionThread", { params: { offeringId: NF.eng9, topicId: topic.id } });
    expect(after.posts[0]).toStrictEqual({ status: "withdrawn", id: root.id, topicId: topic.id, createdAt: root.createdAt });
    expect(after.authors.map((a) => a.principalId)).toStrictEqual([NF.elena]);
    const staff = await district.ok(rivera, "teacher.discussionThread", { params: { offeringId: NF.eng9, topicId: topic.id } });
    expect(staff.posts[0]).toMatchObject({ status: "hidden", body: "Yes: sleep matters.", flags: [{ kind: "report", by: NF.elena }] });

    // Locked, the topic takes no more student posts; the teacher can still close it out.
    await district.ok(rivera, "teacher.updateTopic", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { locked: true } });
    expectError(await district.call(elena, "student.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "One more" } }), 403, "forbidden");
    await district.ok(rivera, "teacher.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "Thanks, all." } });
  });

  it("keeps edits and deletion to the author, and moderation and topics to the class's teachers", async () => {
    const district = await bootDistrict();
    const rivera = district.tokenFor(NF.rivera);
    const amara = district.tokenFor(NF.amara);
    const elena = district.tokenFor(NF.elena);
    const topic = await district.ok(rivera, "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Warm-up", prompt: "Say hi." } });
    const post = await district.ok(amara, "student.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "Hi!" } });

    expectError(await district.call(elena, "student.editPost", { params: { offeringId: NF.eng9, postId: post.id }, body: { body: "Hacked" } }), 403, "forbidden");
    expectError(await district.call(elena, "student.deletePost", { params: { offeringId: NF.eng9, postId: post.id } }), 403, "forbidden");
    expect(await district.ok(amara, "student.editPost", { params: { offeringId: NF.eng9, postId: post.id }, body: { body: "Hello!" } })).toMatchObject({ body: "Hello!" });
    await district.ok(amara, "student.deletePost", { params: { offeringId: NF.eng9, postId: post.id } });

    // A student's token never reaches the teacher surface; another class's teacher finds nothing.
    expectError(await district.call(amara, "teacher.moderatePost", { params: { offeringId: NF.eng9, postId: post.id }, body: { decision: "hide" } }), 403, "forbidden");
    expectError(await district.call(amara, "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Mine", prompt: "x" } }), 403, "forbidden");
    const morgan = district.tokenFor(NF.morgan);
    expectError(await district.call(morgan, "teacher.listDiscussions", { params: { offeringId: NF.eng9 } }), 404, "not-found");
    expectError(await district.call(morgan, "teacher.moderatePost", { params: { offeringId: NF.eng9, postId: post.id }, body: { decision: "hide" } }), 404, "not-found");
    // A dropped student and another district's student see nothing.
    expectError(await district.call(district.tokenFor(NF.dmitri), "student.listDiscussions", { params: { offeringId: NF.eng9 } }), 404, "not-found");
    const riverbend = await bootDistrict(RIVERBEND);
    expectError(await riverbend.call(riverbend.tokenFor(RB.student), "student.listDiscussions", { params: { offeringId: NF.eng9 } }), 404, "not-found");
  });

  it("holds student posts for approval when the teacher turns pre-moderation on", async () => {
    const district = await bootDistrict();
    const rivera = district.tokenFor(NF.rivera);
    const amara = district.tokenFor(NF.amara);
    const topic = await district.ok(rivera, "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Reflections", prompt: "What did you learn?" } });
    expect(await district.ok(rivera, "teacher.discussionSettings", { params: { offeringId: NF.eng9 }, body: { premoderation: true } })).toStrictEqual({ premoderation: true });
    const post = await district.ok(amara, "student.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "Lots." } });
    expect(post.status).toBe("pending");
    expect((await district.ok(district.tokenFor(NF.elena), "student.discussionThread", { params: { offeringId: NF.eng9, topicId: topic.id } })).posts).toStrictEqual([]);
    expect((await district.ok(rivera, "teacher.moderationQueue", { params: { offeringId: NF.eng9 } })).pending.map((p) => p.id)).toStrictEqual([post.id]);
    await district.ok(rivera, "teacher.moderatePost", { params: { offeringId: NF.eng9, postId: post.id }, body: { decision: "approve" } });
    expect((await district.ok(district.tokenFor(NF.elena), "student.discussionThread", { params: { offeringId: NF.eng9, topicId: topic.id } })).posts).toHaveLength(1);
  });

  it("screens student posts with the district's Hall Monitor: refusing, flagging and holding them", async () => {
    const hallMonitor = fakeHallMonitor();
    const district = await bootDistrict(undefined, { discussionScreening: hallMonitor });
    const rivera = district.tokenFor(NF.rivera);
    const amara = district.tokenFor(NF.amara);
    const topic = await district.ok(rivera, "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Debate", prompt: "Go." } });
    const at = { params: { offeringId: NF.eng9, topicId: topic.id } };

    const blocked = await district.call(amara, "student.createPost", { ...at, body: { body: "Mean words [[block]]" } });
    expectError(blocked, 403, "policy-violation");
    expect((blocked.body as { message: string }).message).toMatch(/discussion guidelines/);
    expectError(await district.call(amara, "student.createPost", { ...at, body: { body: "Hello [[down]]" } }), 503, "unavailable");
    expect((await district.ok(amara, "student.createPost", { ...at, body: { body: "Borderline [[coach]]" } })).status).toBe("visible");
    expect((await district.ok(amara, "student.createPost", { ...at, body: { body: "Worrying [[hold]]" } })).status).toBe("pending");
    expect((await district.ok(amara, "student.createPost", { ...at, body: { body: "Fine." } })).status).toBe("visible");
    expect((await district.ok(rivera, "teacher.createPost", { ...at, body: { body: "Teachers aren't screened [[block]]" } })).status).toBe("visible");
    expect(hallMonitor.texts.some((text) => text.includes("Teachers aren't screened"))).toBe(false);

    const queue = await district.ok(rivera, "teacher.moderationQueue", { params: { offeringId: NF.eng9 } });
    expect(queue.flagged.map((p) => p.flags[0])).toMatchObject([{ kind: "screening", decision: "coach" }, { kind: "screening", decision: "hold" }]);
    expect(queue.recent.filter((e) => e.action === "screening-refused")).toHaveLength(2);
    expect(JSON.stringify(queue)).not.toContain("Mean words");
  });

  it("lists a student's posts in a topic graded under an assignment, for the teacher grading it", async () => {
    const district = await bootDistrict();
    const { assignment } = await teacherSetsUpEssay(district);
    const rivera = district.tokenFor(NF.rivera);
    const amara = district.tokenFor(NF.amara);
    const topic = await district.ok(rivera, "teacher.createTopic", {
      params: { offeringId: NF.eng9 }, body: { title: "Peer review", prompt: "Respond to two classmates.", assignmentId: assignment.id },
    });
    expectError(await district.call(rivera, "teacher.createTopic", {
      params: { offeringId: NF.eng9 }, body: { title: "Wrong", prompt: "x", assignmentId: "asg_not-this-class" },
    }), 400, "validation-failed");
    const post = await district.ok(amara, "student.createPost", { params: { offeringId: NF.eng9, topicId: topic.id }, body: { body: "Nice claim." } });
    const participation = await district.ok(rivera, "teacher.discussionParticipation", { params: { assignmentId: assignment.id, principalId: NF.amara } });
    expect(participation.topics.map((t) => t.id)).toStrictEqual([topic.id]);
    expect(participation.posts.map((p) => p.id)).toStrictEqual([post.id]);
    expectError(await district.call(district.tokenFor(NF.morgan), "teacher.discussionParticipation", { params: { assignmentId: assignment.id, principalId: NF.amara } }), 404, "not-found");
  });

  it("imports a cartridge's discussion topics into its draft modules, and exports them again", async () => {
    const district = await bootDistrict();
    const rivera = district.tokenFor(NF.rivera);
    const unit = await district.ok(rivera, "teacher.createModule", { params: { offeringId: NF.eng9 }, body: { title: "Unit 1" } });
    await district.ok(rivera, "teacher.addPage", { params: { offeringId: NF.eng9, moduleId: unit.id }, body: { title: "Intro", body: "Welcome." } });
    await district.ok(rivera, "teacher.createTopic", { params: { offeringId: NF.eng9 }, body: { title: "Your first claim", prompt: "Post a claim.\n\n- Be specific", moduleId: unit.id } });
    const exported = await district.ok(rivera, "teacher.exportCartridge", { params: { offeringId: NF.eng9 } });

    const morgan = district.tokenFor(NF.morgan);
    const upload = { fileName: exported.fileName, base64: exported.base64 };
    const preview = await district.ok(morgan, "teacher.previewCartridge", { params: { offeringId: NF.bio }, body: upload });
    expect(preview.modules[0]!.discussions).toStrictEqual([{ title: "Your first claim", characters: "Post a claim.\n\n- Be specific".length }]);
    const imported = await district.ok(morgan, "teacher.importCartridge", { params: { offeringId: NF.bio }, body: { ...upload, packageDigest: preview.packageDigest } });
    expect(imported.topics).toMatchObject([{
      title: "Your first claim",
      prompt: "Post a claim.\n\n- Be specific",
      moduleId: imported.modules[0]!.id,
      source: { kind: "cartridge", packageDigest: preview.packageDigest },
    }]);

    // The topic is in a draft module, so Biology's students see it once Morgan publishes the module.
    const amara = district.tokenFor(NF.amara);
    expect((await district.ok(amara, "student.listDiscussions", { params: { offeringId: NF.bio } })).topics).toStrictEqual([]);
    await district.ok(morgan, "teacher.updateModule", { params: { offeringId: NF.bio, moduleId: imported.modules[0]!.id }, body: { published: true } });
    expect((await district.ok(amara, "student.listDiscussions", { params: { offeringId: NF.bio } })).topics.map((t) => t.topic.title)).toStrictEqual(["Your first claim"]);
  });
});
