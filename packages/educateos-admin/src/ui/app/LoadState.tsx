import type { ReactNode } from "react";
import { Banner, Button, Loader, Text } from "@cloudflare/kumo";
import { Warning } from "@phosphor-icons/react";
import type { Loaded } from "./context.tsx";

/** Renders a load's loading and error states, and `children` with its data once ready. */
export const LoadState = <T,>({ loaded, what, onRetry, children }: {
  loaded: Loaded<T>;
  what: string;
  onRetry?: () => void;
  children: (data: T) => ReactNode;
}) => {
  if (loaded.status === "loading") {
    return <div className="flex items-center gap-2" role="status"><Loader size="sm" /><Text>Loading {what}...</Text></div>;
  }
  if (loaded.status === "error") {
    return (
      <Banner
        variant="error"
        icon={<Warning weight="fill" />}
        title={`Could not load ${what}`}
        description={loaded.message}
        action={onRetry === undefined ? undefined : <Button size="sm" onClick={onRetry}>Try again</Button>}
      />
    );
  }
  return <>{children(loaded.data)}</>;
};
