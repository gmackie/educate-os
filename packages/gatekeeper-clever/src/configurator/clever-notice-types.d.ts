export type CleverNoticeValues = {
  /** No user-selectable values: the resource names no record. A placeholder for the form. */
  confirmed?: string | null;
};

/** What the profile and district cards ask the gatekeeper. */
export interface CleverNoticeRpc {
  /** Whether the signed-in user is a Clever district administrator now. */
  isDistrictAdmin(): Promise<boolean>;
}
