import { Link, Text } from "@cloudflare/kumo";
import { useObjectUrl } from "./useObjectUrl.ts";

/**
 * A saved file: an image inline, a PDF in the browser's own viewer with a link to open it as the
 * fallback, and anything else as a download.
 */
export const FileViewer = ({ base64, mediaType, title }: { base64: string; mediaType: string; title: string }) => {
  const url = useObjectUrl(base64, mediaType);
  if (url === undefined) return null;
  if (mediaType.startsWith("image/")) return <img src={url} alt={title} className="max-h-[70vh] max-w-full rounded-lg border border-kumo-hairline" />;
  const download = (
    <Link href={url} download={title}>
      {mediaType === "application/pdf" ? `Open ${title} (PDF)` : `Download ${title}`}
    </Link>
  );
  if (mediaType !== "application/pdf") return download;
  return (
    <object data={url} type="application/pdf" aria-label={title} className="h-[70vh] w-full rounded-lg border border-kumo-hairline">
      <Text>This browser can't show the PDF here. {download}</Text>
    </object>
  );
};
