import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { DownloadSimple, FileCsv } from "@phosphor-icons/react";
import { useAnnounce } from "../Announcer.tsx";
import { useDistrictApi } from "../DistrictApi.tsx";
import { Problem } from "../Problem.tsx";

type ExportState =
  | { status: "idle" | "exporting" }
  | { status: "ready"; fileName: string; href: string }
  | { status: "failed"; error: unknown };

/**
 * Exports the gradebook as a CSV file for a spreadsheet or another system. The district prepares
 * the file, with every cell a spreadsheet could run as a formula already defused; the teacher then
 * downloads it.
 */
export const CsvExport = ({ offeringId }: { offeringId: string }) => {
  const client = useDistrictApi();
  const announce = useAnnounce();
  const [state, setState] = useState<ExportState>({ status: "idle" });

  const prepare = async () => {
    setState({ status: "exporting" });
    try {
      const exported = await client.call("teacher.exportGradebookCsv", { params: { offeringId } });
      setState({ status: "ready", fileName: exported.fileName, href: `data:text/csv;charset=utf-8,${encodeURIComponent(exported.csv)}` });
      announce(`${exported.fileName} is ready to download.`);
    } catch (error) {
      setState({ status: "failed", error });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button icon={<FileCsv aria-hidden />} loading={state.status === "exporting"} onClick={() => void prepare()}>Export CSV</Button>
        {state.status === "ready" ? (
          <a href={state.href} download={state.fileName} className="inline-flex items-center gap-1">
            <DownloadSimple aria-hidden />
            {`Download ${state.fileName}`}
          </a>
        ) : null}
      </div>
      {state.status === "failed" ? <Problem error={state.error} /> : null}
    </div>
  );
};
