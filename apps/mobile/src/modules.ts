// How a class's modules are shown (SCHO-186, SCHO-331, SCHO-342). Pure, so it is tested in Node.
import type { CourseModule, CoursePage, ModuleItem, ModuleSource } from './types';

/**
 * A link the app will open: an `https` address with no embedded credentials. Anything else, such
 * as `javascript:`, `http:`, `file:` or an app scheme, is shown as text and never followed.
 */
export function safeLink(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

/** Where a module came from, for its teacher: "Installed from <package> <version>", or the cartridge's file. */
export function provenance(source: ModuleSource | undefined): string | null {
  if (!source) return null;
  if (source.kind === 'course') return 'Installed from ' + source.packageId + ' ' + source.version;
  return 'Imported from ' + source.fileName;
}

/** A teacher-only note's label, by what it is for. */
export function noteLabel(purpose: 'context' | 'answer-key'): string {
  return purpose === 'answer-key' ? 'Answer key' : 'Teacher guide';
}

/** One module item, resolved to what a row shows and where it goes. */
export type ModuleRow =
  | { kind: 'page'; id: string; page: CoursePage }
  | { kind: 'activity'; id: string; activityId: string }
  | { kind: 'link'; id: string; title: string; url: string | null }
  | { kind: 'teacher-note'; id: string; page: CoursePage; label: string };

/**
 * A module's items as rows. Students never get teacher notes, whatever the district sent, and a
 * page item whose page is missing is left out. Unknown item kinds from a newer district are skipped.
 */
export function moduleRows(module: CourseModule, pages: readonly CoursePage[], role: 'student' | 'teacher'): ModuleRow[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  return module.items.flatMap((item: ModuleItem): ModuleRow[] => {
    switch (item.kind) {
      case 'page': {
        const page = byId.get(item.pageId);
        return page ? [{ kind: 'page', id: item.id, page }] : [];
      }
      case 'activity': return [{ kind: 'activity', id: item.id, activityId: item.activityId }];
      case 'link': return [{ kind: 'link', id: item.id, title: item.title, url: safeLink(item.url) }];
      case 'teacher-note': {
        const page = role === 'teacher' ? byId.get(item.pageId) : undefined;
        return page ? [{ kind: 'teacher-note', id: item.id, page, label: noteLabel(item.purpose) }] : [];
      }
      default: return [];
    }
  });
}

/** The teacher-note label for a page, when the page is one: so it is marked teacher-only wherever it opens. */
export function teacherNoteFor(modules: readonly CourseModule[], pageId: string): string | null {
  for (const module of modules) {
    for (const item of module.items) if (item.kind === 'teacher-note' && item.pageId === pageId) return noteLabel(item.purpose);
  }
  return null;
}
