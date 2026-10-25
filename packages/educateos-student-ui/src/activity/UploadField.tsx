import { useState } from "react";
import { Text } from "@cloudflare/kumo";
import { acceptAttribute, formatList, readUpload, type PickedFile, type UploadFormat } from "./uploadFormats.ts";

/**
 * Picks a file from the device and hands it over read. Only the formats the step permits are
 * offered, and anything else, or anything too big, is refused here with a reason rather than at
 * save time. It is a native file input, so it is reached with Tab and opened with Enter or Space.
 */
export const UploadField = ({ id, formats, disabled, onPicked }: {
  id: string;
  formats: readonly UploadFormat[];
  disabled: boolean;
  onPicked: (file: PickedFile) => void;
}) => {
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const onFile = async (file: File | undefined) => {
    if (file === undefined) return;
    const read = await readUpload(file, formats).catch(() => ({ problem: "We couldn't read that file. Try choosing it again." }));
    if ("problem" in read) {
      setProblem(read.problem);
      return;
    }
    setProblem(undefined);
    onPicked(read.file);
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        Upload a file ({formatList(formats)})
      </label>
      <input
        id={id}
        type="file"
        accept={acceptAttribute(formats)}
        disabled={disabled}
        aria-describedby={problem === undefined ? undefined : `${id}-problem`}
        onChange={(event) => {
          void onFile(event.target.files?.[0]);
          // Choosing the same file again, after a failed save, should still be noticed.
          event.target.value = "";
        }}
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
