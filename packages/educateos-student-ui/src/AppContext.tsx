// App-wide values: the features this deployment turns on, and the polite live region that
// announces saves, submissions and failures to screen reader users.
import { createContext, use, useState, type ReactNode } from "react";

/** Features that wait on district routes still to come. Each is off unless the deployment turns it on. */
export interface StudentFeatures {
  /**
   * The class helper's entry point on activities that allow it. Its route is still to come
   * (SCHO-107), so this only reserves its place.
   */
  aiHelp: boolean;
}

const FeaturesContext = createContext<StudentFeatures>({ aiHelp: false });
const AnnounceContext = createContext<(message: string) => void>(() => {});

/** Provides the features and the announcer, and renders the live region. */
export const AppContextProvider = ({ features, children }: { features: StudentFeatures; children: ReactNode }) => {
  // The region stays mounted, as screen readers only announce changes to a region they already
  // know; the alternating no-break space makes a repeated message ("Saved", "Saved") a change.
  const [announcement, setAnnouncement] = useState({ message: "", count: 0 });
  const announce = (message: string) => setAnnouncement((previous) => ({ message, count: previous.count + 1 }));
  return (
    <FeaturesContext value={features}>
      <AnnounceContext value={announce}>
        {children}
        <div role="status" aria-live="polite" className="sr-only">
          {announcement.message + (announcement.count % 2 === 1 ? "\u00a0" : "")}
        </div>
      </AnnounceContext>
    </FeaturesContext>
  );
};

/** The features in force. */
export const useFeatures = (): StudentFeatures => use(FeaturesContext);

/** Announces a state change to assistive technology, politely. */
export const useAnnounce = (): ((message: string) => void) => use(AnnounceContext);
