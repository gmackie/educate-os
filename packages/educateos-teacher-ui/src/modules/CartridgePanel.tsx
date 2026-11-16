import { useState } from "react";
import { Button, LayerCard, Text } from "@cloudflare/kumo";
import { DownloadSimple } from "@phosphor-icons/react";
import { Problem } from "../Problem.tsx";
import type { CartridgeExport } from "../types.ts";
import { CartridgeImport } from "./CartridgeImport.tsx";
import { useAction } from "./useAction.ts";

/** What an export left behind: activities other systems can't run, quizzes not written as QTI yet (SCHO-191), and teacher-only notes (SCHO-331). */
const lossText = (losses: CartridgeExport["losses"]) => {
  const activities = losses.filter((loss) => loss.kind === "activity").length;
  const quizzes = losses.filter((loss) => loss.kind === "quiz").length;
  const notes = losses.filter((loss) => loss.kind === "teacher-note").length;
  return [
    activities === 0 ? "" : `${activities} ${activities === 1 ? "activity" : "activities"} stayed behind: other systems can't run EducateOS activities.`,
    quizzes === 0 ? "" : `${quizzes} ${quizzes === 1 ? "quiz" : "quizzes"} stayed behind: cartridges don't carry EducateOS quizzes yet.`,
    notes === 0 ? "" : `${notes} teacher-only ${notes === 1 ? "note" : "notes"} stayed behind: a cartridge has no way to hide them from students.`,
  ].filter((text) => text !== "").join(" ");
};

/**
 * Moving a class's content in and out as a Common Cartridge (.imscc), the format other learning
 * systems export. An import is previewed first and arrives as unpublished modules; an export
 * carries pages and links, and says which activities it had to leave behind.
 */
export const CartridgePanel = ({ offeringId, onImported }: { offeringId: string; onImported: () => void }) => {
  const action = useAction(onImported);
  const [exported, setExported] = useState<CartridgeExport | undefined>();

  return (
    <LayerCard className="flex flex-col gap-4 p-4">
      <h2><Text variant="heading" as="span">Common Cartridge</Text></h2>
      <CartridgeImport offeringId={offeringId} onImported={onImported} />
      <div className="flex flex-col gap-2 border-t border-kumo-line pt-4">
        <div>
          <Button
            variant="secondary"
            icon={<DownloadSimple aria-hidden />}
            loading={action.running("export")}
            disabled={action.busy}
            onClick={() =>
              void action.run("export", async (client) => {
                const result = await client.call("teacher.exportCartridge", { params: { offeringId } });
                setExported(result);
                return `${result.fileName} is ready to download.`;
              })}
          >
            Export as a cartridge
          </Button>
        </div>
        {exported !== undefined && (
          <div className="flex flex-col gap-1">
            <a href={`data:application/zip;base64,${exported.base64}`} download={exported.fileName}>{`Download ${exported.fileName}`}</a>
            {exported.losses.length > 0 && (
              <Text variant="secondary" size="sm" as="span">
                {lossText(exported.losses)}
              </Text>
            )}
          </div>
        )}
      </div>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </LayerCard>
  );
};
