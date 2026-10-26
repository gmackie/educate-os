import { useRef, useState } from "react";
import { Badge, Button, Input, InputArea, LayerCard, Text } from "@cloudflare/kumo";
import { ChatCircleText, LockSimple, TextAa } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import { SubmittedFile } from "./SubmittedFile.tsx";

type Submitted = RouteResponse<"teacher.submittedContent">;

/**
 * One item of the student's submitted work, exactly as turned in, and a way to comment on a
 * passage of it. A passage can be selected with the pointer or typed, so the comment works the
 * same from the keyboard.
 */
export const SubmittedWork = ({ submissionId, submitted, label, onCommented }: {
  submissionId: string;
  submitted: Submitted;
  /** What the work answers: its activity step, where known. */
  label: string;
  onCommented: () => void;
}) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const textRef = useRef<HTMLPreElement>(null);
  const [passage, setPassage] = useState("");
  const [body, setBody] = useState("");
  const [state, setState] = useState<{ status: "idle" | "sending" } | { status: "failed"; error: unknown } | { status: "not-found" }>({ status: "idle" });
  const { item, content } = submitted;
  const text = content.kind === "text" ? content.text : undefined;

  const takeSelection = () => {
    const selection = window.getSelection();
    if (selection !== null && textRef.current !== null && selection.rangeCount > 0 && textRef.current.contains(selection.anchorNode)) {
      setPassage(selection.toString());
    }
  };

  const comment = async () => {
    const quoted = passage.trim();
    const start = quoted === "" || text === undefined ? -1 : text.indexOf(quoted);
    if (quoted !== "" && start < 0) {
      setState({ status: "not-found" });
      return;
    }
    setState({ status: "sending" });
    try {
      await client.call("teacher.addComment", {
        params: { submissionId },
        body: {
          body: body.trim(),
          ...(start < 0 ? {} : { anchor: { artifactId: item.artifactId, revisionId: item.revisionId, region: { kind: "text-range", start, end: start + quoted.length } } }),
        },
      });
      setPassage("");
      setBody("");
      setState({ status: "idle" });
      announce("Comment added. The student sees it once you share feedback.");
      onCommented();
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <LayerCard className="flex flex-col gap-3 p-4">
      <span className="flex flex-wrap items-center gap-2">
        <h3><Text bold as="span">{label}</Text></h3>
        <Badge variant="neutral" icon={<LockSimple aria-hidden />}>Read-only: the version they turned in</Badge>
        {item.aiAssistance.level !== "none" && <Badge variant="warning">{item.aiAssistance.level === "generated" ? "Student says AI wrote this" : "Student says AI helped"}</Badge>}
      </span>
      {content.kind === "text" && (
        // Focusable so a keyboard user can scroll long work; a labelled region so it is announced as the work.
        <div role="region" aria-label={`Submitted work: ${label}`} tabIndex={0} className="max-h-96 overflow-auto rounded border border-kumo-line p-3 focus-visible:ring-2 focus-visible:ring-kumo-brand">
          <pre ref={textRef} className="whitespace-pre-wrap font-sans">{content.text}</pre>
        </div>
      )}
      {content.kind === "external" && <Text>{`A link the student turned in: ${content.url}`}</Text>}
      {content.kind === "bytes" && <SubmittedFile base64={content.base64} mediaType={item.mediaType} label={label} />}
      <form
        aria-label={`Comment on ${label}`}
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void comment();
        }}
      >
        {text !== undefined && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="grow">
              <Input
                label="Passage you're commenting on"
                required={false}
                description="Select words in the work and press “Use selected words”, or type them exactly."
                value={passage}
                onChange={(event) => setPassage(event.target.value)}
              />
            </div>
            <Button icon={<TextAa aria-hidden />} onClick={takeSelection}>Use selected words</Button>
          </div>
        )}
        <InputArea label="Comment" value={body} onValueChange={setBody} />
        <div>
          <Button type="submit" icon={<ChatCircleText aria-hidden />} disabled={body.trim() === ""} loading={state.status === "sending"}>Add comment</Button>
        </div>
        {state.status === "not-found" && <p role="alert" className="text-kumo-danger">That passage isn't in the work. Check the words match exactly.</p>}
        {state.status === "failed" && <Problem error={state.error} />}
      </form>
    </LayerCard>
  );
};
