// The student's work on an activity, step by step, the way the web's activity page keeps it
// (packages/educateos-student-ui/src/activity, SCHO-323): each step that asks for something is
// saved as its own artifact in the class workspace, titled "<assignment>: <step>", and one
// submission hands in the saved version of every step. Pure, so the rules are tested in Node.
import type { ActivityContent, ActivityStep, ArtifactView, Submission } from './types';
import { plainText } from './markdown.ts';

/**
 * How the phone makes a step's work:
 * - `writing`: typed text, saved as a plain-text document.
 * - `picture`: a drawing (where the class draws) or a photo, saved as a PNG or JPEG image.
 * - `recording`: the student's voice, recorded on the phone and saved as `audio/mp4`.
 * - `photo`: a photo of work done elsewhere, saved as evidence (or the step's own artifact type).
 * - `elsewhere`: work the phone can't make (data tables, spreadsheets, notebooks, links to other
 *   services); it is made on a computer.
 */
export type StepWork =
  | { input: 'writing'; artifactType: 'document' }
  | { input: 'picture'; artifactType: 'image'; drawing: boolean }
  | { input: 'recording'; artifactType: 'audio' }
  | { input: 'photo'; artifactType: string }
  | { input: 'elsewhere'; artifactType: string };

/** How a step's work is made on the phone, or undefined for a step that asks for nothing. */
export function stepWork(step: ActivityStep, { drawing = false }: { drawing?: boolean } = {}): StepWork | undefined {
  const response = step.response;
  switch (response.kind) {
    case 'none': return undefined;
    case 'writing': return { input: 'writing', artifactType: 'document' };
    case 'dataset': return { input: 'elsewhere', artifactType: 'dataset' };
    case 'artifact':
      switch (response.artifactType) {
        case 'document': return { input: 'writing', artifactType: 'document' };
        case 'image': return { input: 'picture', artifactType: 'image', drawing };
        case 'audio': return { input: 'recording', artifactType: 'audio' };
        case 'evidence': case 'portfolio': return { input: 'photo', artifactType: response.artifactType };
        default: return { input: 'elsewhere', artifactType: response.artifactType };
      }
    default: return undefined;
  }
}

/** The steps that ask the student to produce something. Every one needs saved work before submitting. */
export function workSteps(content: ActivityContent): ActivityStep[] {
  return content.steps.filter((step) => step.response.kind !== 'none');
}

/**
 * The title a step's work is saved under, as the web saves it. Artifacts carry no link to an
 * assignment, so the title is what finds a step's work again.
 */
export function workTitle(assignmentTitle: string, step: ActivityStep): string {
  return (assignmentTitle + ': ' + step.title).slice(0, 200);
}

/** The saved work for each step, by step ID, found in the class workspace's artifacts by title. */
export function workByStep(assignmentTitle: string, content: ActivityContent, artifacts: readonly ArtifactView[]): Map<string, ArtifactView> {
  const found = new Map<string, ArtifactView>();
  for (const step of workSteps(content)) {
    const title = workTitle(assignmentTitle, step);
    const match = artifacts.find((view) => view.artifact.title === title && !view.artifact.deletedAt);
    if (match) found.set(step.id, match);
  }
  return found;
}

/** Whether a submission can be made yet, and if not, why, in words for the student. */
export type Readiness =
  | { ready: true; revisions: { artifactId: string; revisionId: string }[] }
  | { ready: false; reason: string; missing: ActivityStep[] };

/**
 * A submission hands in one saved version for every step that asks for work, and nothing until
 * then: the district would accept part of an activity, so the phone checks first. Unsaved typing
 * blocks it too, since a submission takes saved versions and the student would otherwise hand in
 * something other than what is on their screen.
 */
export function readiness(content: ActivityContent, saved: ReadonlyMap<string, ArtifactView>, unsaved: ReadonlySet<string>,
  { young = false }: { young?: boolean } = {}): Readiness {
  const steps = workSteps(content);
  if (steps.length === 0) return { ready: false, reason: "There's nothing to hand in for this activity.", missing: [] };
  const dirty = steps.filter((step) => unsaved.has(step.id));
  if (dirty.length > 0) {
    return { ready: false, missing: dirty,
      reason: young ? 'Save your work first.' : 'Save your changes to ' + list(dirty) + ' before you submit.' };
  }
  const missing = steps.filter((step) => !saved.has(step.id));
  if (missing.length > 0) {
    return { ready: false, missing,
      reason: young ? 'Finish ' + list(missing) + ' first.' : 'Finish ' + list(missing) + ' before you submit. Every step needs your work.' };
  }
  return { ready: true, revisions: steps.map((step) => {
    const view = saved.get(step.id)!;
    return { artifactId: view.artifact.id, revisionId: view.head.id };
  }) };
}

function list(steps: ActivityStep[]): string {
  const titles = steps.map((s) => '“' + s.title + '”');
  return titles.length <= 1 ? titles.join('') : titles.slice(0, -1).join(', ') + ' and ' + titles.at(-1);
}

/** A resource the activity permits, as the list shows it. */
export type PermittedResource = { key: string; title: string; usedIn: string[] };

/**
 * The activity's resources, in the order students meet them. The student API names a resource only
 * by its release, so each is listed by position with the steps that use it, as on the web.
 */
export function permittedResources(content: ActivityContent): PermittedResource[] {
  return (content.resources ?? []).map((ref, i) => ({
    key: ref.resourceId + '@' + ref.version,
    title: 'Resource ' + (i + 1),
    usedIn: content.steps.filter((step) => step.sources.some((s) => s.resourceId === ref.resourceId && s.version === ref.version))
      .map((step) => step.title),
  }));
}

/** The teacher's notes for students from the activity's class context. Teacher-only notes never show. */
export function studentNotes(content: ActivityContent): { id: string; title: string; body: string }[] {
  return (content.codex ?? []).flatMap((entry) =>
    entry.kind === 'note' && entry.visibility === 'students' && entry.purpose === 'context' ? [{ id: entry.id, title: entry.title, body: entry.body }] : []);
}

/** How a sentence frame is spoken: a blank such as "___" is a pause, not a run of underscores. */
export function spokenFrame(frame: string): string {
  return frame.replace(/_{2,}/g, ' … ');
}

/** Teacher Markdown as it is read aloud: its words, without formatting marks or link addresses. */
export function spokenText(markdown: string): string {
  return plainText(markdown.replace(/_{2,}/g, ' … ')).trim();
}

const FINISHED = new Set(['completed', 'retained', 'eligible-for-deletion']);
/** Whether a class workspace belongs to a finished term, which makes its work read-only. */
export function isFinished(workspace: { lifecycle: string } | undefined): boolean {
  return workspace !== undefined && FINISHED.has(workspace.lifecycle);
}

/** The longest recording, which keeps every recording well under the district's upload limit. */
export const MAX_RECORDING_SECONDS = 120;

/** Elapsed recording time as m:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** Where the student's hand-ins for an assignment stand: the newest attempt not withdrawn, and the attempts used. */
export type HandInStatus = {
  handedIn: boolean; attempt: number | null; submittedAt: string | null; used: number; allowed: number;
};

/** The hand-in status from the student's submissions. A withdrawn attempt still counts as used. */
export function handInStatus(submissions: Pick<Submission, 'attempt' | 'submittedAt' | 'withdrawnAt'>[], attemptsAllowed: number): HandInStatus {
  const latest = submissions.filter((s) => !s.withdrawnAt).reduce<typeof submissions[number] | null>(
    (best, s) => !best || s.attempt > best.attempt ? s : best, null);
  return { handedIn: latest !== null, attempt: latest?.attempt ?? null, submittedAt: latest?.submittedAt ?? null,
    used: submissions.length, allowed: attemptsAllowed };
}

/**
 * The newest comment a teacher has shared on a child's work, for the family view: the guardian
 * route returns only feedback released to the child, so whatever it holds may be shown.
 */
export function sharedComment(feedback: readonly { comments: readonly { body: string; enteredAt: string }[] }[] | undefined): string | undefined {
  const comments = (feedback ?? []).flatMap((entry) => entry.comments).filter((comment) => comment.body.trim() !== '');
  return comments.reduce<{ body: string; enteredAt: string } | undefined>(
    (latest, comment) => (!latest || comment.enteredAt >= latest.enteredAt ? comment : latest), undefined)?.body.trim();
}
