import { useState } from "react";
import { Banner, Button, LayerCard, Text } from "@cloudflare/kumo";
import { DownloadSimple, Warning } from "@phosphor-icons/react";
import { useAdminClient } from "../app/AdminClientContext.tsx";
import { useAnnounce } from "../app/Announcer.tsx";
import { errorMessage } from "../app/useLoad.ts";

/** The file name the district gave a download, from its `Content-Disposition`. */
const fileNameOf = (response: Response) => /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "district-export.zip";

/**
 * Downloads the whole district as one ZIP (SCHO-364, SCHO-367): the district's records and its
 * students' course work, for its own copy or to leave EducateOS. Shown only where the console's
 * client can stream a file.
 */
export const DistrictExportCard = () => {
  const client = useAdminClient();
  const announce = useAnnounce();
  const [state, setState] = useState<{ status: "idle" | "running" } | { status: "failed"; message: string }>({ status: "idle" });
  const download = client.download;
  if (download === undefined) return null;

  const run = async () => {
    setState({ status: "running" });
    try {
      const response = await download("admin.exportDistrict");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = fileNameOf(response);
      link.click();
      // After the click has started the download: revoking at once can cancel it in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setState({ status: "idle" });
      announce("The district export is downloading.");
    } catch (error) {
      const message = errorMessage(error);
      setState({ status: "failed", message });
      announce(`The district was not exported. ${message}`);
    }
  };

  return (
    <LayerCard className="flex flex-col gap-3 p-4">
      <Text as="h3" variant="secondary">Export the district</Text>
      <Text variant="secondary">
        One ZIP of the district's records and its students' class work and submissions, with their files. It holds students' personal information: keep it under your data rules. Students' personal work is not in it; each student downloads their own.
      </Text>
      <div>
        <Button variant="secondary" icon={<DownloadSimple aria-hidden />} loading={state.status === "running"} onClick={() => void run()}>Export</Button>
      </div>
      {state.status === "failed" && <Banner variant="error" icon={<Warning weight="fill" />} title="The district was not exported." description={state.message} />}
    </LayerCard>
  );
};
