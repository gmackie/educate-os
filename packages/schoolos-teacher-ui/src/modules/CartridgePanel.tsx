import { useState } from "react";
import { Banner, Button, LayerCard, Text } from "@cloudflare/kumo";
import { DownloadSimple, UploadSimple } from "@phosphor-icons/react";
import { Problem } from "../Problem.tsx";
import type { CartridgeExport, CartridgePreview } from "../types.ts";
import { fileToBase64, MAX_CARTRIDGE_BYTES } from "./fileToBase64.ts";
import { useAction } from "./useAction.ts";

type Upload = { fileName: string; base64: string; preview: CartridgePreview };

const SKIP_REASONS: Record<string, string> = {
  "lti-tool": "an external tool",
  "unsupported-type": "a kind of content modules can't hold, such as a quiz or a file",
  "link-refused": "a link to an address SchoolOS won't open",
  "invalid-link": "a link with no usable address",
  "missing-resource": "something the package names but doesn't contain",
  "missing-file": "something the package names but doesn't contain",
  "page-not-utf8": "a page in an unreadable text encoding",
  "not-acceptable": "text SchoolOS can't store, such as a script",
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Moving a class's content in and out as a Common Cartridge (.imscc), the format other learning
 * systems export. An import is previewed first and arrives as unpublished modules; an export
 * carries pages and links, and says which activities it had to leave behind.
 */
export const CartridgePanel = ({ offeringId, onImported }: { offeringId: string; onImported: () => void }) => {
  const action = useAction(onImported);
  const [upload, setUpload] = useState<Upload | undefined>();
  const [exported, setExported] = useState<CartridgeExport | undefined>();
  const [tooLarge, setTooLarge] = useState(false);

  const preview = async (file: File) => {
    setUpload(undefined);
    setTooLarge(file.size > MAX_CARTRIDGE_BYTES);
    if (file.size > MAX_CARTRIDGE_BYTES) return;
    const base64 = await fileToBase64(file);
    await action.run("preview", async (client) => {
      const result = await client.call("teacher.previewCartridge", { params: { offeringId }, body: { fileName: file.name, base64 } });
      setUpload({ fileName: file.name, base64, preview: result });
      return `${file.name} would add ${plural(result.modules.length, "module")}.`;
    });
  };

  const modules = upload?.preview.modules ?? [];
  return (
    <LayerCard className="flex flex-col gap-4 p-4">
      <h2><Text variant="heading" as="span">Common Cartridge</Text></h2>
      <div className="flex flex-col gap-1">
        <label htmlFor="cartridge-file" className="text-sm font-medium">Import a cartridge (.imscc)</label>
        <input
          id="cartridge-file"
          type="file"
          accept=".imscc,.zip,application/zip"
          aria-describedby="cartridge-file-help"
          className="text-sm"
          disabled={action.busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void preview(file);
          }}
        />
        <Text variant="secondary" size="sm" as="span">
          <span id="cartridge-file-help">You'll see what it adds before anything changes. Imported modules start as drafts.</span>
        </Text>
      </div>
      {tooLarge && <Banner variant="error" title="That file is too large" description="Cartridges up to 5 MB can be imported." />}
      {upload !== undefined && (
        <section aria-label="Import preview" className="flex flex-col gap-3">
          <Text>{`${upload.fileName} would add ${plural(modules.length, "module")} with ${plural(modules.reduce((n, m) => n + m.items.length, 0), "item")}.`}</Text>
          <ul className="list-disc pl-6">
            {modules.map((module, index) => (
              <li key={index}>{`${module.title}: ${[...module.items.map((item) => item.title), ...(module.discussions ?? []).map((topic) => `${topic.title} (discussion)`)].join(", ")}`}</li>
            ))}
          </ul>
          {upload.preview.skipped.length > 0 && (
            <Banner
              variant="alert"
              title={`${plural(upload.preview.skipped.length, "item")} won't come across`}
              description={[...new Set(upload.preview.skipped.map((skip) => SKIP_REASONS[skip.reason] ?? "content SchoolOS can't hold"))].join("; ")}
            />
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              icon={<UploadSimple aria-hidden />}
              loading={action.running("import")}
              disabled={action.busy || modules.length === 0}
              onClick={() =>
                void action.run("import", async (client) => {
                  const result = await client.call("teacher.importCartridge", {
                    params: { offeringId },
                    body: { fileName: upload.fileName, base64: upload.base64, packageDigest: upload.preview.packageDigest },
                  });
                  setUpload(undefined);
                  const topics = result.topics?.length ?? 0;
                  return `Imported ${plural(result.modules.length, "module")} as drafts${topics === 0 ? "" : `, with ${plural(topics, "discussion")}`}.`;
                })}
            >
              {`Import ${plural(modules.length, "module")}`}
            </Button>
            <Button variant="secondary" onClick={() => setUpload(undefined)}>Cancel</Button>
          </div>
        </section>
      )}
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
                {`${plural(exported.losses.length, "activity")} stayed behind: other systems can't run SchoolOS activities.`}
              </Text>
            )}
          </div>
        )}
      </div>
      {action.state.status === "failed" && <Problem error={action.state.error} />}
    </LayerCard>
  );
};
