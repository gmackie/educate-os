import { describe, expect, it } from "vitest";
import { O, P, rejectsWith, setTermState, setup, T } from "./setup.ts";

describe("lazy provisioning", () => {
  it("creates nothing until a principal first asks", async () => {
    const { store } = setup();
    expect((await store.load()).state.workspaces).toEqual([]);
  });

  it("gives each principal one permanent personal workspace, however often it is ensured", async () => {
    const { workspaces, store } = setup();
    const first = await workspaces.ensurePersonalWorkspace(P.amara);
    const again = await workspaces.ensurePersonalWorkspace(P.amara);
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({ kind: "personal", ownerPrincipalId: "prn_nf-student-amara", lifecycle: "active" });
    // Staff have one too, and it is theirs alone.
    const morgans = await workspaces.ensurePersonalWorkspace(P.morgan);
    expect(morgans.id).not.toBe(first.id);
    expect((await store.load()).state.workspaces).toHaveLength(2);
  });

  it("links a course workspace to its student, offering, school and term, with live course grants", async () => {
    const { workspaces, store } = setup();
    const bio = await workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
    expect(bio).toMatchObject({
      kind: "course",
      ownerPrincipalId: "prn_nf-student-amara",
      offeringId: "off_nf-bio-fall-p2",
      schoolId: "sch_nf-high",
      termId: "trm_nf-2026-fall",
      lifecycle: "active",
    });
    expect((await workspaces.ensureCourseWorkspace(P.amara, O.bioFall)).id).toBe(bio.id);
    const eng9 = await workspaces.ensureCourseWorkspace(P.amara, O.eng9);
    expect(eng9.id).not.toBe(bio.id);

    const { grants } = (await store.load()).state;
    expect(grants.filter((g) => g.workspaceId === bio.id).map((g) => [g.kind, g.state])).toEqual([
      ["course-tools", "live"],
      ["course-ai-funding", "live"],
    ]);
  });

  it("provisions one workspace when two first accesses race", async () => {
    const { workspaces, store } = setup();
    const [a, b] = await Promise.all([
      workspaces.ensureCourseWorkspace(P.amara, O.bioFall),
      workspaces.ensureCourseWorkspace(P.amara, O.bioFall),
    ]);
    expect(a.id).toBe(b.id);
    const { state } = await store.load();
    expect(state.workspaces).toHaveLength(1);
    expect(state.grants).toHaveLength(2);
  });

  it("refuses a course workspace to anyone but an actively enrolled student", async () => {
    const { workspaces, store } = setup();
    // Chidi is not in Biology at all: the offering is not even acknowledged.
    await rejectsWith(workspaces.ensureCourseWorkspace(P.chidi, O.bioFall), "not-found");
    // Morgan teaches it; teachers have no course workspace.
    await rejectsWith(workspaces.ensureCourseWorkspace(P.morgan, O.bioFall), "forbidden");
    // Dmitri was dropped from English 9 before he ever opened it.
    await rejectsWith(workspaces.ensureCourseWorkspace(P.dmitri, O.eng9), "forbidden");
    // A Riverbend principal has no workspace in Northfield.
    await rejectsWith(workspaces.ensurePersonalWorkspace(P.rbAdmin), "forbidden");
    expect((await store.load()).state.workspaces).toEqual([]);
  });

  it("does not create a course workspace in a completed term, though the enrollment is still active", async () => {
    const { workspaces, audit } = setup();
    await rejectsWith(workspaces.ensureCourseWorkspace(P.amara, O.bioSpring), "forbidden");
    expect(audit.events.at(-1)).toMatchObject({ action: "create", effect: "deny", ruleId: "guard.term-completed.read-only" });
  });

  it("provisions during planned and grading terms, following the term state", async () => {
    const { workspaces, changeDirectory } = setup();
    await changeDirectory((d) => setTermState(d, T.fall, "planned"));
    expect((await workspaces.ensureCourseWorkspace(P.amara, O.bioFall)).lifecycle).toBe("planned");
    await changeDirectory((d) => setTermState(d, T.fall, "grading"));
    expect((await workspaces.ensureCourseWorkspace(P.elena, O.bioFall)).lifecycle).toBe("grading");
  });
});
