// The notice a family's adults read and accept before entering anything about a child (ADR-0016).
// Its wording is the draft in docs/educateos/legal/home-learning-counsel-brief.md, filled in with
// the installation's own facts. When the wording changes, the version changes, and every adult is
// asked to accept the new one before they carry on.

/** The current notice's version. Bump it whenever {@link familyNotice}'s wording changes. */
export const FAMILY_NOTICE_VERSION = "2026-11-16";

/** The installation facts the notice states. */
export interface FamilyNoticeFacts {
  /** Who runs the installation: the community's name. */
  operator: string;
  /** How to reach them, if the installation set it. */
  contact?: string;
  /** How long practice is kept, in days; undefined until the family deletes it. */
  retentionDays?: number;
}

/** The notice, as it is shown: a version and its paragraphs. */
export interface FamilyNotice {
  version: string;
  title: string;
  paragraphs: string[];
}

const period = (days: number) => (days % 365 === 0 ? (days === 365 ? "one year" : `${days / 365} years`) : `${days} days`);

/** The current notice, with this installation's facts. */
export function familyNotice(facts: FamilyNoticeFacts): FamilyNotice {
  return {
    version: FAMILY_NOTICE_VERSION,
    title: "Your family's information",
    paragraphs: [
      "Only your family's grown-ups can see your children's practice. Children don't have accounts; a grown-up signs in and hands over the device.",
      "We keep each child's nickname, the picture they picked, a starting grade, the activities you choose, and the answers they tap. We don't collect birth dates, photos, recordings or locations.",
      facts.retentionDays === undefined
        ? "Practice is kept until you delete it."
        : `Practice is deleted automatically ${period(facts.retentionDays)} after it happened, and so is the record of who looked at it.`,
      "You can download everything, delete a child, delete your family, or delete your account at any time from Family settings.",
      "Reading aloud uses your browser's own voice, which may send the activity's words (never your child's answers) to your browser's speech service. You can turn reading aloud off in Family settings.",
      `This installation is run by ${facts.operator}.${facts.contact === undefined ? "" : ` Contact: ${facts.contact}.`}`,
    ],
  };
}
