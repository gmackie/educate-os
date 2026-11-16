import { useState } from "react";
import { Banner, Button, Text } from "@cloudflare/kumo";
import { DownloadSimpleIcon, InfoIcon } from "@phosphor-icons/react";
import type { RouteResponse } from "@educateos/api-client";
import { useApi } from "./api.tsx";
import { useAnnounce } from "./AppContext.tsx";
import { ErrorState } from "./ErrorState.tsx";

type Withheld = RouteResponse<"student.exportArchive">["withheld"];

/** Saves `bytes` as `fileName` through a temporary link, since the archive arrives in a JSON body. */
const save = (base64: string, mediaType: string, fileName: string) => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // After the click has started the download: revoking at once can cancel it in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

/**
 * Downloads the student's own `.educateos` archive (SCHO-371): their personal work, finished
 * classes' work, submissions and the feedback shared with them. Anything left out because it looked
 * like a password or key is listed, so the student can remove it and download again.
 */
export const ArchiveDownload = () => {
  const api = useApi();
  const announce = useAnnounce();
  const [state, setState] = useState<{ status: "idle" | "running" } | { status: "done"; withheld: Withheld } | { status: "failed"; error: unknown }>({ status: "idle" });

  const download = async () => {
    setState({ status: "running" });
    try {
      const archive = await api.call("student.exportArchive");
      save(archive.base64, archive.mediaType, archive.fileName);
      setState({ status: "done", withheld: archive.withheld });
      announce("Your work is downloading");
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Text variant="secondary">
        Download a copy of your work to keep: what's in My space, your work from classes that have ended, what you turned in, and your teachers' feedback.
      </Text>
      <div>
        <Button variant="secondary" icon={<DownloadSimpleIcon aria-hidden />} loading={state.status === "running"} onClick={() => void download()}>
          Download my work
        </Button>
      </div>
      {state.status === "done" && state.withheld.length > 0 ? (
        <Banner
          variant="secondary"
          icon={<InfoIcon weight="fill" />}
          title="Some work was left out because it looks like it has a password or key in it"
          description={`Remove it and download again to include: ${state.withheld.map((item) => item.label).join(", ")}.`}
        />
      ) : null}
      {state.status === "failed" ? <ErrorState error={state.error} title="We couldn't get your work ready" /> : null}
    </div>
  );
};
