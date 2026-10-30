import { useState } from "react";
import { Badge, Code, Collapsible, Text } from "@cloudflare/kumo";
import type { HopExchange, InstantLoginHop } from "./instantLogin.ts";

interface UnderTheHoodProps {
  /** The hops of the last Instant Login, in the order they ran. */
  hops: readonly InstantLoginHop[];
  /** Open on first render, as after a refusal, where the hops say why. */
  defaultOpen?: boolean;
}

/**
 * "Under the hood": every hop of a Clever Instant Login as it ran in the page, from the portal's
 * link to the principal EducateOS resolved, with what was sent and answered. Codes and tokens show
 * only their first characters, and the app's client secret never.
 */
export const UnderTheHood = ({ hops, defaultOpen = false }: UnderTheHoodProps) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="rounded-lg border border-kumo-line bg-kumo-elevated px-4 py-2">
      <Collapsible.DefaultTrigger>{`Under the hood: the Clever sign-in, step by step (${hops.length} steps)`}</Collapsible.DefaultTrigger>
      <Collapsible.DefaultPanel>
        <ol aria-label="Clever sign-in steps" className="flex flex-col gap-4 py-2">
          {hops.map((hop, index) => (
            <li key={`${hop.id}-${index}`} className="flex flex-col gap-1 border-l-2 border-kumo-line pl-3">
              <div className="flex flex-wrap items-center gap-2">
                <Text as="h4" variant="heading">{`${index + 1}. ${hop.title}`}</Text>
                <Badge variant={hop.ok ? "success" : "error"}>{hop.ok ? "Passed" : "Didn't pass"}</Badge>
              </div>
              <Text>{hop.summary}</Text>
              {hop.exchange !== undefined && <Exchange exchange={hop.exchange} />}
              {hop.data !== undefined && <Code.Block lang="jsonc" code={JSON.stringify(hop.data, null, 2)} />}
            </li>
          ))}
        </ol>
      </Collapsible.DefaultPanel>
    </Collapsible.Root>
  );
};

/** One request and its answer. */
const Exchange = ({ exchange }: { exchange: HopExchange }) => {
  const lines = [
    `${exchange.method} ${exchange.url}`,
    ...Object.entries(exchange.sent ?? {}).map(([key, value]) => `  ${key}: ${value}`),
    `→ ${exchange.status}${exchange.location === undefined ? "" : ` Location: ${exchange.location}`}`,
  ];
  return (
    <div className="flex flex-col gap-1">
      <Code.Block lang="bash" code={lines.join("\n")} />
      {exchange.body !== undefined && <Code.Block lang="jsonc" code={JSON.stringify(exchange.body, null, 2)} />}
    </div>
  );
};
