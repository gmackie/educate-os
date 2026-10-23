import { useEffect, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";

const EXTENSIONS: Readonly<Record<string, string>> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };

/**
 * A `blob:` URL for base64 bytes, revoked when they change or the viewer closes. The file is shown
 * from the bytes the review already loaded, so opening it needs no second request and puts no
 * credential in a link.
 */
const useObjectUrl = (base64: string, mediaType: string): string | undefined => {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const created = URL.createObjectURL(new Blob([bytes], { type: mediaType }));
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
      setUrl(undefined);
    };
  }, [base64, mediaType]);
  return url;
};

/**
 * A file the student turned in, exactly as submitted: a picture shown inline, a PDF in the
 * browser's own viewer, and every file with a link to download it.
 */
export const SubmittedFile = ({ base64, mediaType, label }: { base64: string; mediaType: string; label: string }) => {
  const url = useObjectUrl(base64, mediaType);
  if (url === undefined) return null;
  const download = (
    <a href={url} download={`${label}.${EXTENSIONS[mediaType] ?? "bin"}`} className="inline-flex items-center gap-1">
      <DownloadSimple aria-hidden />
      {`Download ${label}`}
    </a>
  );
  return (
    <div className="flex flex-col gap-2">
      {mediaType.startsWith("image/") && <img src={url} alt={label} className="max-h-[70vh] max-w-full rounded border border-kumo-line" />}
      {mediaType === "application/pdf" && (
        <object data={url} type="application/pdf" aria-label={label} className="h-[70vh] w-full rounded border border-kumo-line">
          This browser can't show the PDF here. Download it below.
        </object>
      )}
      <div>{download}</div>
    </div>
  );
};
