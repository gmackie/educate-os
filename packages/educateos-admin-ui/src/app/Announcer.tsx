import { createContext, useContext, useState, type ReactNode } from "react";

const AnnounceContext = createContext<((message: string) => void) | undefined>(undefined);

/**
 * A polite live region for state changes that do not move focus, such as a preview finishing or a
 * change being applied. Screen readers read each message once.
 */
export const AnnouncerProvider = ({ children }: { children: ReactNode }) => {
  const [message, setMessage] = useState("");
  return (
    <AnnounceContext.Provider value={setMessage}>
      {children}
      <div role="status" aria-live="polite" className="sr-only" data-testid="announcer">{message}</div>
    </AnnounceContext.Provider>
  );
};

/** Announces a state change to assistive technology. */
export const useAnnounce = (): ((message: string) => void) => {
  const announce = useContext(AnnounceContext);
  if (announce === undefined) throw new Error("useAnnounce needs an AnnouncerProvider");
  return announce;
};
