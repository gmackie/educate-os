// Who the signed-in user is allowed to reach, decided on every call against the district's own
// records, read with the district-app token the deployment holds:
//
// - A teacher's section must list the user among its teachers.
// - A student's section must list the user among its students.
// - The district-wide connection needs the user's record to hold the `district_admin` role. That
//   record is read through a short cache, so the role is re-checked on every session start and
//   every call, at most a minute stale.
//
// Anything else answers not-found, the same as a record that does not exist.

import { CleverApi, type CleverSectionRecord, type CleverUserRecord } from "./clever-api";
import { apiBase, districtToken, type Env } from "./clever-env";
import { forbidden, notFound, unavailable } from "./clever-errors";
import { CleverDirectory } from "./clever-model";

/** Who a connection signed in as: the Clever user and their district. */
export type CleverIdentity = { userId: string; districtId: string };

/** How long a user record is reused for role checks. */
export const USER_RECORD_TTL_MS = 60 * 1000;

/** Which roster a section must list the user on. */
export type SectionRole = "teacher" | "student" | "district";

/** A connection's view of its district: who it is, and the district's data. */
export type CleverDistrictContext = {
  identity: CleverIdentity;
  api: CleverApi;
  directory: CleverDirectory;
};

/** The district's data through its district-app token, or a refusal when the deployment has none. */
export function districtApi(env: Env, districtId: string): CleverApi {
  const token = districtToken(env, districtId);
  if (token === undefined) {
    throw unavailable("This deployment has no Clever connection for your district. Ask its administrator to add it.");
  }
  return new CleverApi(apiBase(env), token);
}

export class CleverAccess {
  readonly #env: Env;
  readonly #identity: () => Promise<CleverIdentity>;
  #district?: { key: string; context: Omit<CleverDistrictContext, "identity"> };
  #user?: { key: string; at: number; value: Promise<CleverUserRecord> };

  /** `identity` reads the connected account's identity; it throws once the account is gone. */
  constructor(env: Env, identity: () => Promise<CleverIdentity>) {
    this.#env = env;
    this.#identity = identity;
  }

  /** The signed-in user and their district's data. */
  async context(): Promise<CleverDistrictContext> {
    const identity = await this.#identity();
    const key = `${identity.districtId}\u0000${districtToken(this.#env, identity.districtId) ?? ""}`;
    if (this.#district?.key !== key) {
      const api = districtApi(this.#env, identity.districtId);
      this.#district = { key, context: { api, directory: new CleverDirectory(api) } };
    }
    return { identity, ...this.#district.context };
  }

  /** The signed-in user's own record, reused for up to {@link USER_RECORD_TTL_MS}. */
  async self(context?: CleverDistrictContext): Promise<{ context: CleverDistrictContext; user: CleverUserRecord }> {
    const ctx = context ?? await this.context();
    const key = `${ctx.identity.districtId}\u0000${ctx.identity.userId}`;
    const now = Date.now();
    if (this.#user === undefined || this.#user.key !== key || now - this.#user.at >= USER_RECORD_TTL_MS) {
      const value = ctx.api.user(ctx.identity.userId);
      const entry = { key, at: now, value };
      this.#user = entry;
      value.catch(() => {
        if (this.#user === entry) this.#user = undefined;
      });
    }
    const user = await this.#user.value;
    if (user.id !== ctx.identity.userId || user.district !== ctx.identity.districtId) {
      throw forbidden("Your Clever account is no longer in this district's records.");
    }
    return { context: ctx, user };
  }

  /** Refuses unless the signed-in user is, now, a district administrator. */
  async requireAdmin(): Promise<{ context: CleverDistrictContext; user: CleverUserRecord }> {
    let found;
    try {
      found = await this.self();
    } catch (error) {
      if ((error as { code?: unknown }).code === "not-found") {
        throw forbidden("Only a Clever district administrator can use this connection.");
      }
      throw error;
    }
    if (!found.user.roles.district_admin) {
      throw forbidden("Only a Clever district administrator can use this connection.");
    }
    return found;
  }

  /**
   * A section of the user's district the user may reach in `role`: one they teach, one they are
   * enrolled in, or, for a district administrator, any. Otherwise not-found.
   */
  async section(role: SectionRole, sectionId: string): Promise<{ context: CleverDistrictContext; section: CleverSectionRecord }> {
    const context = role === "district" ? (await this.requireAdmin()).context : await this.context();
    const section = await context.api.section(sectionId);
    if (!reaches(role, section, context.identity)) throw notFound("section");
    return { context, section };
  }
}

/** Whether `identity` reaches `section` in `role`. */
export function reaches(role: SectionRole, section: CleverSectionRecord, identity: CleverIdentity): boolean {
  if (section.district !== identity.districtId) return false;
  switch (role) {
    case "teacher": return section.teachers.includes(identity.userId);
    case "student": return section.students.includes(identity.userId);
    case "district": return true;
  }
}
