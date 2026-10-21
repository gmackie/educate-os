import { Text } from "@cloudflare/kumo";
import { FileTextIcon, NoteIcon } from "@phosphor-icons/react";
import type { ActivityContent } from "../model.ts";
import { SafeExternalLink } from "../SafeExternalLink.tsx";

/** A resource the activity permits, as the list shows it. */
export interface PermittedResource {
  key: string;
  title: string;
  /** Where it opens, once the district says; until then the resource is listed without a link. */
  href?: string;
  /** The steps that use it. */
  usedIn: string[];
}

/**
 * The activity's resources, in the order students meet them. The student API names a resource only
 * by its release for now, so each is listed by position with the steps that use it; a link appears
 * once the district returns one, and opens through {@link SafeExternalLink}.
 */
export const permittedResources = (content: ActivityContent): PermittedResource[] =>
  content.resources.map((ref, i) => ({
    key: `${ref.resourceId}@${ref.version}`,
    title: `Resource ${i + 1}`,
    usedIn: content.steps.filter((step) => step.sources.some((s) => s.resourceId === ref.resourceId && s.version === ref.version)).map((step) => step.title),
  }));

/** The teacher's notes for students, from the activity's class context. */
const contextNotes = (content: ActivityContent) => content.codex.flatMap((entry) => (entry.kind === "note" ? [entry] : []));

/** The resources and teacher notes an activity gives students. */
export const ResourceList = ({ content }: { content: ActivityContent }) => {
  const resources = permittedResources(content);
  const notes = contextNotes(content);
  if (resources.length === 0 && notes.length === 0) return <Text variant="secondary">This activity has no resources.</Text>;
  return (
    <ul className="flex flex-col gap-2">
      {resources.map((resource) => (
        <li key={resource.key} className="flex items-start gap-2">
          <FileTextIcon aria-hidden size={20} className="mt-0.5 shrink-0" />
          <div className="flex flex-col">
            {resource.href === undefined ? <Text bold>{resource.title}</Text> : <SafeExternalLink href={resource.href}>{resource.title}</SafeExternalLink>}
            {resource.usedIn.length === 0 ? null : (
              <Text variant="secondary" size="sm">
                For: {resource.usedIn.join(", ")}
              </Text>
            )}
          </div>
        </li>
      ))}
      {notes.map((note) => (
        <li key={note.id} className="flex items-start gap-2">
          <NoteIcon aria-hidden size={20} className="mt-0.5 shrink-0" />
          <div className="flex flex-col">
            <Text bold>{note.title}</Text>
            <Text>{note.body}</Text>
          </div>
        </li>
      ))}
    </ul>
  );
};
