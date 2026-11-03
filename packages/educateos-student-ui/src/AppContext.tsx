// App-wide values: the features this deployment turns on, and the polite live region that
// announces saves, submissions and failures to screen reader users.
import { createContext, use, useState, type ReactNode } from "react";
import type { AssignedActivity } from "./model.ts";

/** Features that wait on district routes still to come. Each is off unless the deployment turns it on. */
export interface StudentFeatures {
  /**
   * The class helper's entry point on activities that allow it. Its route is still to come
   * (SCHO-107), so this only reserves its place.
   */
  aiHelp: boolean;
}

/**
 * How the Learning Home runs inside a host that is not the district's own site, such as the
 * Workshop's School app: it has no address of its own to put in links, and the host signs people
 * in and out.
 */
export interface Embedding {
  /** The district's public origin, for links that leave the app, such as the calendar feed. */
  districtOrigin: string;
}

/**
 * What a host that runs the Learning Home outside a district, such as the educateos.io demo, puts
 * in place of the district's own pieces.
 */
export interface StudentHost {
  /** Signs out the host's way, in place of the district's sign-out: the demo returns to its persona picker. */
  onSignOut?: () => void;
  /**
   * The class helper an activity offers where its AI-help level allows one, in place of the
   * district's: the demo's simulated tutor.
   */
  aiHelp?: (activity: AssignedActivity) => ReactNode;
}

const FeaturesContext = createContext<StudentFeatures>({ aiHelp: false });
const HostContext = createContext<StudentHost>({});
const EmbeddingContext = createContext<Embedding | undefined>(undefined);
const AnnounceContext = createContext<(message: string) => void>(() => {});

/** Provides the features and the announcer, and renders the live region. */
export const AppContextProvider = ({ features, embedding, host = {}, children }: { features: StudentFeatures; embedding?: Embedding; host?: StudentHost; children: ReactNode }) => {
  // The region stays mounted, as screen readers only announce changes to a region they already
  // know; the alternating no-break space makes a repeated message ("Saved", "Saved") a change.
  const [announcement, setAnnouncement] = useState({ message: "", count: 0 });
  const announce = (message: string) => setAnnouncement((previous) => ({ message, count: previous.count + 1 }));
  return (
    <FeaturesContext value={features}>
      <HostContext value={host}>
      <EmbeddingContext value={embedding}>
        <AnnounceContext value={announce}>
          {children}
          <div role="status" aria-live="polite" className="sr-only">
            {announcement.message + (announcement.count % 2 === 1 ? "\u00a0" : "")}
          </div>
        </AnnounceContext>
      </EmbeddingContext>
      </HostContext>
    </FeaturesContext>
  );
};

/** The features in force. */
export const useFeatures = (): StudentFeatures => use(FeaturesContext);

/** What the host puts in place of the district's own pieces; nothing on the district's own site. */
export const useHost = (): StudentHost => use(HostContext);

/** How the app is embedded in a host, or undefined on the district's own site. */
export const useEmbedding = (): Embedding | undefined => use(EmbeddingContext);

/** The district's public origin: the page's own, unless a host embeds the app. */
export const useDistrictOrigin = (): string => use(EmbeddingContext)?.districtOrigin ?? window.location.origin;

/** Announces a state change to assistive technology, politely. */
export const useAnnounce = (): ((message: string) => void) => use(AnnounceContext);
