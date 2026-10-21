import { useEffect, useState } from "react";

/**
 * A `blob:` URL for base64 bytes, revoked when the bytes change or the viewer unmounts. Saved files
 * are shown from memory this way rather than from a district URL, so viewing one needs no second
 * request and no credential in a link.
 */
export const useObjectUrl = (base64: string, mediaType: string): string | undefined => {
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
