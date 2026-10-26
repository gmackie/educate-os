import { useState } from "react";
import { Button, Input, Text } from "@cloudflare/kumo";
import { LinkSimple } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";
import type { ResourceReport } from "../types.ts";
import { FILE_INPUT_CLASS } from "../fileInputClass.ts";

/**
 * Sends a web page, or later a file, to the class's review queue. Nothing imported reaches
 * students until the teacher approves it.
 */
export const ImportResourceForm = ({ offeringId, onImported }: { offeringId: string; onImported: (item: ResourceReport) => void }) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [url, setUrl] = useState("");
  const [state, setState] = useState<{ status: "idle" | "sending" } | { status: "failed"; error: unknown }>({ status: "idle" });

  const submit = async () => {
    setState({ status: "sending" });
    try {
      const item = await client.call("teacher.importResource", { params: { offeringId }, body: { url: url.trim() } });
      setUrl("");
      setState({ status: "idle" });
      announce(`${item.title ?? "The page"} is in the review queue.`);
      onImported(item);
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <form
      aria-label="Add a resource"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="grow">
          <Input
            label="Web address"
            type="url"
            required
            placeholder="https://"
            description="We check the page, its license and its accessibility before anyone can use it."
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
        <Button type="submit" variant="primary" icon={<LinkSimple aria-hidden />} loading={state.status === "sending"} disabled={url.trim() === ""}>
          Send for review
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="resource-file" className="text-sm font-medium">Or upload a file</label>
        <input id="resource-file" type="file" disabled aria-describedby="resource-file-help" className={FILE_INPUT_CLASS} />
        <Text variant="secondary" size="sm" as="span">
          <span id="resource-file-help">File uploads aren't turned on for your district yet. Paste a web address instead.</span>
        </Text>
      </div>
      {state.status === "failed" && <Problem error={state.error} />}
    </form>
  );
};
