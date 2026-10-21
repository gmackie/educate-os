import { Banner, Button } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { messageFor } from "./api.tsx";

/** A load that failed, in words the student can act on, with a way to try again. */
export const ErrorState = ({ error, title, onRetry }: { error: unknown; title: string; onRetry?: () => void }) => (
  <div role="alert">
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title={title}
      description={messageFor(error)}
      action={onRetry === undefined ? undefined : <Button size="sm" onClick={onRetry}>Try again</Button>}
    />
  </div>
);
