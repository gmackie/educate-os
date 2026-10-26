import { useState, type ReactNode } from "react";
import { Banner, Button, Empty, Input, InputArea, Surface, Text } from "@cloudflare/kumo";
import { CheckIcon, CopySimpleIcon, NotePencilIcon, TrayIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { messageFor, useApi, useQuery } from "./api.tsx";
import { useAnnounce } from "./AppContext.tsx";
import { canKeepFrom, personalWorkspace } from "./courses.ts";
import { clearDraft, readDraft, writeDraft } from "./drafts.ts";
import { ErrorState } from "./ErrorState.tsx";
import { classTitleIn, formatDateTime } from "./labels.ts";
import { LoadingSkeleton } from "./LoadingSkeleton.tsx";
import type { ArtifactView, CourseWorkspaceView } from "./model.ts";
import { PrivacyNote } from "./PrivacyNote.tsx";
import { ArtifactViewer } from "./viewers/ArtifactViewer.tsx";

const NOTE_DRAFT = "my-space/new-note";

const OpenedArtifact = ({ view }: { view: ArtifactView }) => {
  const [read, reload] = useQuery(`open:${view.head.id}`, (api) => api.call("student.getArtifact", { params: { artifactId: view.artifact.id } }));
  if (read.status === "loading") return <LoadingSkeleton label={`Opening ${view.artifact.title}`} />;
  if (read.status === "error") return <ErrorState error={read.error} title="We couldn't open this" onRetry={reload} />;
  return <ArtifactViewer read={read.data} />;
};

/** One piece of work in a list, opening in place. `action` is what else can be done with it. */
const ArtifactRow = ({ view, action }: { view: ArtifactView; action?: ReactNode }) => {
  const [open, setOpen] = useState(false);
  return (
    <Surface className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <Text bold>{view.artifact.title}</Text>
          <Text variant="secondary" size="sm">
            Saved <time dateTime={view.head.createdAt}>{formatDateTime(view.head.createdAt)}</time>
          </Text>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" aria-expanded={open} aria-label={`${open ? "Close" : "Open"} ${view.artifact.title}`} onClick={() => setOpen(!open)}>
            {open ? "Close" : "Open"}
          </Button>
          {action}
        </div>
      </div>
      {open ? <OpenedArtifact view={view} /> : null}
    </Surface>
  );
};

/** Keeps a copy of a finished class's work in My space, where only the student can see it. */
const KeepButton = ({ workspaceId, view, onKept }: { workspaceId: string; view: ArtifactView; onKept: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [state, setState] = useState<{ phase: "idle" | "keeping" | "kept" } | { phase: "failed"; message: string }>({ phase: "idle" });
  const keep = async () => {
    setState({ phase: "keeping" });
    try {
      await api.call("student.keepArtifact", { params: { workspaceId, artifactId: view.artifact.id } });
      setState({ phase: "kept" });
      announce(`${view.artifact.title} is kept in My space.`);
      onKept();
    } catch (error) {
      setState({ phase: "failed", message: messageFor(error) });
      announce(`${view.artifact.title} was not kept.`);
    }
  };
  if (state.phase === "kept") {
    return (
      <Text variant="success" size="sm">
        <span className="flex items-center gap-1">
          <CheckIcon aria-hidden /> Kept in My space
        </span>
      </Text>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" variant="secondary" icon={<CopySimpleIcon aria-hidden />} loading={state.phase === "keeping"} aria-label={`Keep a copy of ${view.artifact.title}`} onClick={() => void keep()}>
        Keep a copy
      </Button>
      {state.phase === "failed" ? (
        <Text variant="error" size="sm">
          <span role="alert">{state.message}</span>
        </Text>
      ) : null}
    </div>
  );
};

const FinishedCourse = ({ workspace, name, artifacts, onKept }: { workspace: CourseWorkspaceView; name: string; artifacts: ArtifactView[]; onKept: () => void }) => (
  <section aria-label={name} className="flex flex-col gap-2">
    <Text variant="heading" as="h3">
      {name}
    </Text>
    {artifacts.length === 0 ? (
      <Text variant="secondary">No saved work in this class.</Text>
    ) : (
      <ul className="flex flex-col gap-2">
        {artifacts.map((view) => (
          <li key={view.artifact.id}>
            <ArtifactRow view={view} action={<KeepButton workspaceId={workspace.id} view={view} onKept={onKept} />} />
          </li>
        ))}
      </ul>
    )}
  </section>
);

/** A new private note. Its text is kept as a draft until it saves, like work in a class. */
const NoteForm = ({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) => {
  const api = useApi();
  const announce = useAnnounce();
  const [title, setTitle] = useState("");
  const [text, setText] = useState(() => readDraft(NOTE_DRAFT) ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const personal = await api.call("student.openPersonalWorkspace");
      await api.call("student.createArtifact", {
        body: { workspaceId: personal.id, type: "document", title: title.trim(), content: { kind: "text", mediaType: "text/plain", text } },
      });
      clearDraft(NOTE_DRAFT);
      announce("Note saved.");
      onSaved();
    } catch (caught) {
      setError(messageFor(caught));
      announce("Your note was not saved. It is kept on this device.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Surface className="flex flex-col gap-3 rounded-lg border border-kumo-hairline p-4">
      <Input label="Note title" value={title} onChange={(event) => setTitle(event.target.value)} />
      <InputArea
        label="Note"
        value={text}
        autoResize
        minRows={6}
        onValueChange={(next) => {
          setText(next);
          if (next === "") clearDraft(NOTE_DRAFT);
          else writeDraft(NOTE_DRAFT, next);
        }}
      />
      {error === undefined ? null : (
        <div role="alert">
          <Banner variant="error" size="sm" icon={<WarningCircleIcon weight="fill" />} title="Not saved yet" description={`${error} Your note is kept on this device until it saves.`} />
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="primary" loading={saving} disabled={title.trim() === "" || saving} onClick={() => void save()}>
          Save note
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </Surface>
  );
};

/** My space: the student's private work, a new note, and copies to keep from finished classes. */
export const MySpacePage = () => {
  const [writing, setWriting] = useState(false);
  const [space, reload] = useQuery("my-space", async (api) => {
    const workspaces = await api.call("student.listWorkspaces");
    const personal = personalWorkspace(workspaces);
    const finished = workspaces.filter((w): w is CourseWorkspaceView => w.kind === "course" && canKeepFrom(w));
    const [mine, fromCourses, offerings] = await Promise.all([
      personal === undefined ? [] : api.call("student.listArtifacts", { params: { workspaceId: personal.id } }),
      Promise.all(finished.map(async (workspace) => ({ workspace, artifacts: await api.call("student.listArtifacts", { params: { workspaceId: workspace.id } }) }))),
      finished.length === 0 ? [] : api.call("student.listOfferings"),
    ]);
    return { mine, fromCourses: fromCourses.map((entry) => ({ ...entry, name: classTitleIn(offerings, entry.workspace.offeringId) })) };
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Text variant="heading" size="lg" as="h1">
          My space
        </Text>
        <PrivacyNote scope="personal" />
      </div>

      {space.status === "loading" ? <LoadingSkeleton label="Loading my space" lines={4} /> : null}
      {space.status === "error" ? <ErrorState error={space.error} title="We couldn't load My space" onRetry={reload} /> : null}
      {space.status === "ready" ? (
        <>
          <section aria-labelledby="my-things" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Text variant="heading" as="h2">
                <span id="my-things">My work</span>
              </Text>
              {writing ? null : (
                <Button icon={<NotePencilIcon aria-hidden />} onClick={() => setWriting(true)}>
                  New note
                </Button>
              )}
            </div>
            {writing ? <NoteForm onSaved={() => (setWriting(false), reload())} onCancel={() => setWriting(false)} /> : null}
            {space.data.mine.length === 0 ? (
              <Empty size="sm" icon={<TrayIcon aria-hidden size={32} />} title="Nothing here yet" description="Write a note, or keep a copy of work from a finished class." />
            ) : (
              <ul className="flex flex-col gap-2">
                {space.data.mine.map((view) => (
                  <li key={view.artifact.id}>
                    <ArtifactRow view={view} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {space.data.fromCourses.length === 0 ? null : (
            <section aria-labelledby="keep" className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Text variant="heading" as="h2">
                  <span id="keep">Keep work from finished classes</span>
                </Text>
                <Text variant="secondary">A copy you keep moves here, where only you can see it.</Text>
              </div>
              {space.data.fromCourses.map(({ workspace, name, artifacts }) => (
                <FinishedCourse key={workspace.id} workspace={workspace} name={name} artifacts={artifacts} onKept={reload} />
              ))}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
};
