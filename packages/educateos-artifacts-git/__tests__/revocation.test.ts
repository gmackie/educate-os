import { describe, expect, it } from "vitest";
import { TermId } from "@educateos/contracts";
import { as, notebook, O, P, rejectsWith, setup } from "./setup.ts";

const files = [{ path: "lab.py", text: "print('hello')\n" }];
const ADMIN = as("prn_nf-district-admin");
const FALL = TermId.parse("trm_nf-2026-fall");

/** Amara's and Elena's Biology projects, each with a live credential of their own. */
async function liveCredentials() {
  const env = setup();
  const amaraBio = await env.workspaces.ensureCourseWorkspace(P.amara, O.bioFall);
  const elenaBio = await env.workspaces.ensureCourseWorkspace(P.elena, O.bioFall);
  const amara = await env.projects.createProject(P.amara, notebook(amaraBio.id, files));
  const elena = await env.projects.createProject(P.elena, notebook(elenaBio.id, files));
  const amaraToken = await env.projects.issueCredential(P.amara, amara.artifact.id, "write");
  const teacherToken = await env.projects.issueCredential(P.morgan, amara.artifact.id, "read");
  const elenaToken = await env.projects.issueCredential(P.elena, elena.artifact.id, "write");
  const reads = (token: typeof amaraToken) => env.storage.readBranch(token.remote, token.reveal(), "main");
  return { ...env, amaraBio, elenaBio, amara, amaraToken, teacherToken, elenaToken, reads };
}

describe("ending course access", () => {
  it("revokes a dropped student's project credentials, and no one else's", async () => {
    const { projects, workspaces, changeDirectory, amaraToken, teacherToken, elenaToken, reads } = await liveCredentials();
    await changeDirectory((d) => {
      d.enrollments.find((e) => e.principalId === P.amara.principal.principalId && e.offeringId === O.bioFall)!.status = "inactive";
    });
    expect(await projects.revokeEndedCourseAccess()).toEqual({ revoked: 0, pending: [] });
    await workspaces.reconcileCourseGrants(ADMIN);

    expect(await projects.revokeEndedCourseAccess()).toEqual({ revoked: 2, pending: [] });
    await rejectsWith(reads(amaraToken), "forbidden");
    await rejectsWith(reads(teacherToken), "forbidden");
    expect(await reads(elenaToken)).toMatch(/^[0-9a-f]{40}$/);
    expect(await projects.revokeEndedCourseAccess()).toEqual({ revoked: 0, pending: [] });
  });

  it("revokes every credential in a closed term", async () => {
    const { projects, workspaces, changeDirectory, amaraToken, teacherToken, elenaToken, reads } = await liveCredentials();
    await changeDirectory((d) => {
      d.terms.find((t) => t.id === FALL)!.state = "completed";
    });
    await workspaces.closeTerm(ADMIN, FALL);
    expect(await projects.revokeEndedCourseAccess()).toEqual({ revoked: 3, pending: [] });
    for (const token of [amaraToken, teacherToken, elenaToken]) await rejectsWith(reads(token), "forbidden");
  });

  it("retries a revocation the storage refuses for now, and reports what is still pending", async () => {
    const { projects, workspaces, storage, changeDirectory, amara, amaraBio, amaraToken, elenaToken, reads } = await liveCredentials();
    await changeDirectory((d) => {
      d.terms.find((t) => t.id === FALL)!.state = "completed";
    });
    await workspaces.closeTerm(ADMIN, FALL);
    let failures = 1;
    const get = storage.get.bind(storage);
    storage.get = async (name) => {
      const repo = await get(name);
      return {
        ...repo,
        revokeToken: async (token) => {
          if (failures-- > 0) throw new Error("storage unavailable");
          return repo.revokeToken(token);
        },
      };
    };

    // One refusal: the workspace is retried within the same run, and everything ends revoked.
    expect((await projects.revokeEndedCourseAccess()).pending).toEqual([]);
    for (const token of [amaraToken, elenaToken]) await rejectsWith(reads(token), "forbidden");

    // An outage that outlasts the retries leaves the workspace pending; a later run finishes it.
    const later = await projects.issueCredential(P.amara, amara.artifact.id, "read");
    failures = Number.POSITIVE_INFINITY;
    expect(await projects.revokeEndedCourseAccess()).toEqual({ revoked: 0, pending: [amaraBio.id] });
    expect(await reads(later)).toMatch(/^[0-9a-f]{40}$/);
    failures = 0;
    expect(await projects.revokeEndedCourseAccess()).toEqual({ revoked: 1, pending: [] });
    await rejectsWith(reads(later), "forbidden");
  });
});
