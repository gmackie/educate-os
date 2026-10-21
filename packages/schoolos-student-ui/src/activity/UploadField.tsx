import { useState } from "react";
import { Text } from "@cloudflare/kumo";

/** The largest file the Learning Home reads in, well under the district's text limits. */
const MAX_UPLOAD_BYTES = 1024 * 1024;

/**
 * Picks a text or CSV file from the device and hands its text to the editor, where it is saved like
 * typed work. Only the types the step permits are offered, and anything else is refused here with a
 * reason rather than at save time.
 */
export const UploadField = ({ id, accept, disabled, onLoaded }: { id: string; accept: string; disabled: boolean; onLoaded: (text: string, fileName: string) => void }) => {
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const extensions = accept.split(",").filter((type) => type.startsWith("."));

  const onFile = async (file: File | undefined) => {
    if (file === undefined) return;
    if (!extensions.some((extension) => file.name.toLowerCase().endsWith(extension))) {
      setProblem(`Choose a ${extensions.join(" or ")} file.`);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setProblem("That file is too big. Choose one under 1 MB.");
      return;
    }
    setProblem(undefined);
    onLoaded(await file.text(), file.name);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        Upload a file ({extensions.join(", ")})
      </label>
      <input
        id={id}
        type="file"
        accept={accept}
        disabled={disabled}
        aria-describedby={problem === undefined ? undefined : `${id}-problem`}
        onChange={(event) => void onFile(event.target.files?.[0])}
        className="text-sm file:mr-3 file:rounded file:border-0 file:bg-kumo-tint file:px-3 file:py-2"
      />
      {problem === undefined ? null : (
        <Text variant="error" size="sm">
          <span id={`${id}-problem`} role="alert">
            {problem}
          </span>
        </Text>
      )}
    </div>
  );
};
