import { createContext, use, useState, type ReactNode } from "react";

const AnnounceContext = createContext<((message: string) => void) | null>(null);

/**
 * A polite live region for the whole app: screen readers hear each change a teacher's action
 * causes ("Approved for this class", "Official grade recorded") without focus moving.
 */
export const AnnouncerProvider = ({ children }: { children: ReactNode }) => {
  const [message, setMessage] = useState("");
  return (
    <AnnounceContext value={setMessage}>
      {children}
      <div role="status" aria-live="polite" className="sr-only">
        {message}
      </div>
    </AnnounceContext>
  );
};

/** Announces a state change to assistive technology. */
export const useAnnounce = (): ((message: string) => void) => {
  const announce = use(AnnounceContext);
  if (announce === null) throw new Error("useAnnounce needs an AnnouncerProvider");
  return announce;
};
