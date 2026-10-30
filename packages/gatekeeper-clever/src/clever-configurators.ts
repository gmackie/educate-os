// The capabilities resource configurator frames talk to. They answer the signed-in user's own
// sections in one role, and whether they are a district administrator; nothing else. These are
// the Workshop showing the user their own records, not reads an agent receives.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { CleverAccess } from "./clever-access";
import type { CleverSectionRecord } from "./clever-api";
import type { CleverNoticeRpc } from "./configurator/clever-notice-types";
import type { CleverSectionOption, CleverSectionPickerRpc } from "./configurator/clever-section-picker-types";
import type { CleverSection } from "./types";

const accessByUi = new WeakMap<object, CleverAccess>();

function option(section: CleverSection): CleverSectionOption {
  const parts = [section.school.name, section.term?.name, section.period === undefined ? undefined : `Period ${section.period}`]
    .filter((part): part is string => part !== undefined);
  return { id: section.id, title: section.name, ...(parts.length === 0 ? {} : { subtitle: parts.join(" · ") }) };
}

/** A section picker over the user's own sections, as a teacher or as a student. */
@validateRpc()
export class CleverSectionPickerUI extends RpcTarget implements CleverSectionPickerRpc {
  readonly #role: "teacher" | "student";

  constructor(access: CleverAccess, role: "teacher" | "student") {
    super();
    accessByUi.set(this, access);
    this.#role = role;
  }

  async listSections(): Promise<CleverSectionOption[]> {
    const context = await this.#access().context();
    const { userId, districtId } = context.identity;
    const mine = (await context.api.userSections(userId)).filter(section => this.#reaches(section, userId, districtId));
    return (await context.directory.currentSections(mine)).map(option);
  }

  async getSection(sectionId: string): Promise<CleverSectionOption | null> {
    try {
      const { context, section } = await this.#access().section(this.#role, sectionId);
      return option(await context.directory.toSection(section));
    } catch (error) {
      if ((error as { code?: unknown }).code === "not-found") return null;
      throw error;
    }
  }

  #reaches(section: CleverSectionRecord, userId: string, districtId: string): boolean {
    if (section.district !== districtId) return false;
    return this.#role === "teacher" ? section.teachers.includes(userId) : section.students.includes(userId);
  }

  #access(): CleverAccess {
    const access = accessByUi.get(this);
    if (access === undefined) throw new Error("This configurator is not initialized.");
    return access;
  }
}

/** The profile and district cards: whether the user is a district administrator. */
@validateRpc()
export class CleverNoticeUI extends RpcTarget implements CleverNoticeRpc {
  constructor(access: CleverAccess) {
    super();
    accessByUi.set(this, access);
  }

  async isDistrictAdmin(): Promise<boolean> {
    const access = accessByUi.get(this);
    if (access === undefined) throw new Error("This configurator is not initialized.");
    try {
      await access.requireAdmin();
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === "forbidden") return false;
      throw error;
    }
  }
}
