// The gatekeeper Durable Object: one binding of a Clever resource to a gadget, run as a facet of
// the overseer. One class serves every resource type; its props name the type.
//
// Observer strategies, by binding (see docs/observers.md):
// - profile, student, student section, district: A (private). A profile is personal, a student's
//   view is their own work, and the district grant reaches every student in the district, so none
//   can be shared.
// - section: B. The binding is one section, and an observer must teach it too.
// - teacher: C. The binding spans the teacher's sections, each with its own roster; every read
//   names the sections it discloses, and each observer must teach every one of them.

import { DurableObject, type RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import {
  ObservationGate, aclObservers, privateObservers, trackedCollectionObservers, type ObserverStrategy,
} from "@gadgets/gatekeeper-kit/observers";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, GitCache, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CleverAccess, type SectionRole } from "./clever-access";
import { CLEVER_ACTIONS, type CleverAction, type CleverActionHost } from "./clever-actions";
import { resourceUrlOf, type CleverTarget, type Env } from "./clever-env";
import { nameOf } from "./clever-model";
import {
  CleverDistrictSessionImpl, CleverProfileSessionImpl, CleverSectionSessionImpl, CleverStudentSectionSessionImpl,
  CleverStudentSessionImpl, CleverTeacherSessionImpl, type BindingHost,
} from "./clever-sessions";
import type { CleverVerifierApi } from "./clever-verifier-types";
import TYPES_CODE from "./types.txt";

/** What a binding names: its owner's account, and the resource. */
export type CleverGatekeeperProps = { userObjectId: string; target: CleverTarget };

const DESCRIPTIONS: Record<CleverTarget["kind"], { tsType: string; binding: string }> = {
  profile: { tsType: "CleverProfileSession", binding: "CLEVER_PROFILE" },
  teacher: { tsType: "CleverTeacherSession", binding: "CLEVER_TEACHER" },
  section: { tsType: "CleverSectionSession", binding: "CLEVER_SECTION" },
  student: { tsType: "CleverStudentSession", binding: "CLEVER_STUDENT" },
  studentSection: { tsType: "CleverStudentSectionSession", binding: "CLEVER_STUDENT_SECTION" },
  district: { tsType: "CleverDistrictSession", binding: "CLEVER_DISTRICT" },
};

const PRIVATE_MESSAGE: Record<string, string> = {
  profile: "A Clever profile is personal and cannot be shared with collaborators.",
  student: "A student's Clever classes hold their own work and cannot be shared with collaborators.",
  studentSection: "A student's Clever classes hold their own work and cannot be shared with collaborators.",
  district: "A district-wide Clever connection reaches every student in the district and cannot be shared with collaborators.",
};

function roleOf(target: CleverTarget): SectionRole {
  switch (target.kind) {
    case "student":
    case "studentSection":
      return "student";
    case "district":
      return "district";
    default:
      return "teacher";
  }
}

@validateRpc()
export class CleverGatekeeperImpl extends DurableObject<Env, CleverGatekeeperProps> implements Gatekeeper<unknown> {
  #access = new CleverAccess(this.env, () => this.#account().getIdentity());
  #journal = new ActionJournal<CleverAction>(this.ctx.storage.kv, { namespace: "clever" });
  #host: CleverActionHost = {
    role: roleOf(this.ctx.props.target),
    access: this.#access,
    ledger: districtId => this.ctx.exports.CleverDistrictLedger.getByName(districtId),
    ...(this.ctx.props.target.kind === "district"
      ? { audit: (userId: string, districtId: string, action: string, target: string) => this.#audit(userId, districtId, action, target) }
      : {}),
  };
  #actions = CLEVER_ACTIONS.bind(this.#journal, this.#host);
  #observers: ObserverStrategy = this.#strategy();

  #account() {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #audit(userId: string, districtId: string, action: string, target: string): Promise<void> {
    await this.ctx.exports.CleverDistrictLedger.getByName(districtId).appendAudit({ userId, action, target });
  }

  #strategy(): ObserverStrategy {
    const target = this.ctx.props.target;
    switch (target.kind) {
      case "section":
        return aclObservers<Fetcher<CleverVerifierApi>>({
          hasAccess: async verifier => (await verifier.teachesSections([target.sectionId]))[0] === true,
          denyMessage: "This collaborator does not teach the bound Clever section, so they cannot observe its roster and grades.",
        });
      case "teacher":
        return trackedCollectionObservers<Fetcher<CleverVerifierApi>>({
          kv: this.ctx.storage.kv,
          collectionPrefix: "observedSection:",
          hasCollectionAccess: (verifier, sectionIds) => verifier.teachesSections([...sectionIds]),
          denyMessage: () =>
            "This collaborator does not teach every Clever section read through this connection, so they cannot observe it.",
          vendorId: "clever",
        });
      default:
        return privateObservers(PRIVATE_MESSAGE[target.kind]!);
    }
  }

  #bindingHost(): BindingHost {
    const kind = this.ctx.props.target.kind;
    return {
      ...this.#host,
      pending: () => this.#journal.listPending(),
      submit: async (queue, actionKind, payload) => this.#actions.submit(queue, actionKind, payload),
      sectionScope: sectionId => kind === "teacher" ? { kind: "collections", ids: [sectionId] } : { kind: "baseline" },
      listScope: sectionIds => kind === "teacher" && sectionIds.length > 0
        ? { kind: "collections", ids: sectionIds }
        : { kind: "baseline" },
    };
  }

  async describe(): Promise<ResourceDescription> {
    const target = this.ctx.props.target;
    const { tsType, binding } = DESCRIPTIONS[target.kind];
    const url = resourceUrlOf(target);
    const base = { url, suggestedBindingName: binding, tsType };
    switch (target.kind) {
      case "profile": {
        const { user } = await this.#access.self();
        return { ...base, title: `Clever profile: ${nameOf(user)}`, snippet: "Your Clever name, roles, district and schools." };
      }
      case "teacher":
        await this.#access.self();
        return { ...base, title: "Clever: sections you teach", snippet: "Rosters, assignments and grades of every section you teach." };
      case "student":
        await this.#access.self();
        return { ...base, title: "Clever: your classes", snippet: "Your classes, their teachers and assignments, and your own work." };
      case "district": {
        // Only a district administrator can grant it: refused here, before it is granted.
        await this.#access.requireAdmin();
        return {
          ...base, title: "Clever: every section in your district",
          snippet: "Every section of the district. Each read and change is recorded in the district's audit log.",
        };
      }
      case "section": {
        const { section } = await this.#access.section("teacher", target.sectionId);
        return { ...base, title: `Clever section: ${section.name}`, snippet: `Roster, assignments and grades of ${section.name}.` };
      }
      case "studentSection": {
        const { section } = await this.#access.section("student", target.sectionId);
        return { ...base, title: `Clever class: ${section.name}`, snippet: `Your work in ${section.name}.` };
      }
    }
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<unknown> {
    const target = this.ctx.props.target;
    const host = this.#bindingHost();
    const gate = new ObservationGate(approvalQueue.dup(), this.#observers);
    switch (target.kind) {
      case "profile":
        return new CleverProfileSessionImpl(this.#access, gate);
      case "teacher":
        return new CleverTeacherSessionImpl(host, gate, approvalQueue.dup());
      case "section":
        return new CleverSectionSessionImpl(host, target.sectionId, gate, approvalQueue.dup());
      case "student":
        return new CleverStudentSessionImpl(host, gate, approvalQueue.dup());
      case "studentSection":
        return new CleverStudentSectionSessionImpl(host, target.sectionId, gate, approvalQueue.dup());
      case "district":
        // Re-checked on every session start, and again on every call.
        try {
          await this.#access.requireAdmin();
        } catch (error) {
          gate[Symbol.dispose]();
          throw error;
        }
        return new CleverDistrictSessionImpl(host, gate, approvalQueue.dup());
    }
  }

  async applyAction(actionId: number, _cache: RpcStub<GitCache>): Promise<void> {
    await this.#actions.apply(actionId);
  }

  async rejectAction(actionId: number): Promise<void> {
    const record = this.#journal.get(actionId);
    await this.#actions.reject(actionId);
    if (this.ctx.props.target.kind === "district" && record !== undefined) {
      const { action } = record;
      const identity = await this.#account().getIdentity();
      const target = action.kind === "setGrade"
        ? `section:${action.payload.sectionId}/assignment:${action.payload.assignmentId}/student:${action.payload.studentId}`
        : `section:${action.payload.sectionId}`;
      const name = action.kind === "setGrade" ? "set-grade" : action.kind === "turnIn" ? "turn-in" : "create-assignment";
      await this.#audit(identity.userId, identity.districtId, `rejected:${name}`, target);
    }
  }

  async revertAction(_actionId: number): Promise<{ message: string }> {
    return { message: "Clever changes cannot be reverted automatically. Undo it in the section's learning management system." };
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    await this.#observers.addObserver(id, user);
  }

  async removeObserver(id: string): Promise<void> {
    await this.#observers.removeObserver(id);
  }
}
