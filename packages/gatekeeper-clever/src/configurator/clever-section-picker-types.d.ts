/** One section a picker offers. */
export type CleverSectionOption = {
  /** The Clever section ID. */
  id: string;
  title: string;
  /** School, term and period, when known. */
  subtitle?: string;
};

export type CleverSectionPickerValues = {
  /** `all` for every section, or one section's Clever ID. */
  target?: string | null;
};

/** What a section picker asks the gatekeeper: the signed-in user's own sections, in its role. */
export interface CleverSectionPickerRpc {
  /** The current and future sections the user teaches (teacher card) or is enrolled in (student card). */
  listSections(): Promise<CleverSectionOption[]>;
  /** One of those sections, or null if the user does not reach it. */
  getSection(sectionId: string): Promise<CleverSectionOption | null>;
}
