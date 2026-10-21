import { Banner, Button } from "@cloudflare/kumo";
import { WarningCircle } from "@phosphor-icons/react";
import { describeProblem } from "./errorMessage.ts";

/** A failed load or action, in plain words, with a way to try again where that makes sense. */
export const Problem = ({ error, onRetry }: { error: unknown; onRetry?: () => void }) => {
  const { message, detail, reference } = describeProblem(error);
  const description = [detail, reference === undefined ? undefined : `Reference: ${reference}`].filter((part) => part !== undefined).join(" · ");
  return (
    <div role="alert">
      <Banner
        variant="error"
        icon={<WarningCircle aria-hidden />}
        title={message}
        {...(description === "" ? {} : { description })}
        {...(onRetry === undefined ? {} : { action: <Button size="sm" onClick={onRetry}>Try again</Button> })}
      />
    </div>
  );
};
