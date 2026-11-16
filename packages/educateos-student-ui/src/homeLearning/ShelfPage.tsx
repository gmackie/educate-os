import { useState } from "react";
import { Button, Empty, Input, InputArea, Link, Radio, Surface, Text } from "@cloudflare/kumo";
import { TrashIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { useAnnounce } from "../AppContext.tsx";
import { messageFor, useApi } from "../api.tsx";
import { ErrorState } from "../ErrorState.tsx";
import { LoadingSkeleton } from "../LoadingSkeleton.tsx";
import { PageHeading } from "../PageHeading.tsx";
import { SafeExternalLink } from "../SafeExternalLink.tsx";
import { HomeLearningNav } from "./HomeLearningNav.tsx";
import { HOME_PATH } from "./paths.ts";
import { useFamily } from "./useFamily.ts";

const KINDS = [
  { value: "book", label: "Book" },
  { value: "link", label: "Link" },
  { value: "worksheet", label: "Worksheet" },
  { value: "note", label: "Note" },
] as const;
type Kind = (typeof KINDS)[number]["value"];

/**
 * The family's shelf: books, links, worksheets and notes kept for reference. Nothing on the shelf is
 * practice, and nothing on it counts toward progress.
 */
export const ShelfPage = () => {
  const api = useApi();
  const announce = useAnnounce();
  const [home, reload] = useFamily();
  const [kind, setKind] = useState<Kind>("book");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  if (home.status === "loading") return <LoadingSkeleton label="Loading your shelf" />;
  if (home.status === "error") return <ErrorState error={home.error} title="We couldn't load your shelf" onRetry={reload} />;
  const family = home.data.family;
  if (family === null) return <Navigate to={HOME_PATH} replace />;
  const takesUrl = kind === "link" || kind === "worksheet";
  return (
    <div className="flex flex-col gap-6">
      <PageHeading>Shelf</PageHeading>
      <HomeLearningNav />
      <Text>Keep books you're reading together, useful links and printed worksheets here. The shelf is for you: nothing on it is practice, and nothing on it counts toward progress.</Text>
      {family.shelf.length === 0 ? <Empty title="Your shelf is empty" description="Add the first thing below." /> : (
        <ul className="flex flex-col gap-3">
          {family.shelf.map((item) => (
            <li key={item.id}>
              <Surface className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-kumo-hairline p-4">
                <span className="flex flex-col gap-1">
                  <span className="font-semibold">{item.url === undefined ? item.title : <SafeExternalLink href={item.url}>{item.title}</SafeExternalLink>}</span>
                  <Text variant="secondary" size="sm">{KINDS.find((k) => k.value === item.kind)!.label}</Text>
                  {item.note === undefined ? null : <Text>{item.note}</Text>}
                </span>
                <Button size="sm" variant="secondary-destructive" icon={<TrashIcon aria-hidden />} onClick={() => {
                  api.call("family.shelfRemove", { params: { itemId: item.id }, body: {} }).then(() => {
                    announce(`Removed ${item.title}`);
                    reload();
                  }, (caught: unknown) => setError(messageFor(caught)));
                }}>{`Remove ${item.title}`}</Button>
              </Surface>
            </li>
          ))}
        </ul>
      )}
      <Surface className="flex max-w-2xl flex-col gap-4 rounded-xl border border-kumo-hairline p-5">
        <form className="flex flex-col gap-4" aria-labelledby="shelf-add" onSubmit={(event) => {
          event.preventDefault();
          setError(undefined);
          api.call("family.shelfAdd", { body: {
            kind, title: title.trim(), learnerIds: [],
            ...(takesUrl && url.trim() !== "" ? { url: url.trim() } : {}),
            ...(note.trim() === "" ? {} : { note: note.trim() }),
          } }).then(() => {
            announce(`Added ${title.trim()} to your shelf`);
            setTitle("");
            setUrl("");
            setNote("");
            reload();
          }, (caught: unknown) => setError(messageFor(caught)));
        }}>
          <h2 id="shelf-add" className="text-lg font-semibold">Add to the shelf</h2>
          <Radio.Group legend="What is it?" orientation="horizontal" value={kind} onValueChange={(value) => setKind(value as Kind)}>
            {KINDS.map((k) => <Radio.Item key={k.value} value={k.value} label={k.label} />)}
          </Radio.Group>
          <Input label="Title" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
          {takesUrl ? <Input label="Address (https)" type="url" value={url} onChange={(event) => setUrl(event.target.value)} /> : null}
          <InputArea label="Note (optional)" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} />
          {error === undefined ? null : <p role="alert" className="text-kumo-danger">{error}</p>}
          <Button type="submit" variant="primary" className="self-start" disabled={title.trim() === "" || (kind === "link" && url.trim() === "")}>Add</Button>
        </form>
      </Surface>
      <Text variant="secondary" size="sm">Want something here to become practice? Choose a matching activity in the <Link href="/family/library">library</Link>.</Text>
    </div>
  );
};
