import { Surface, Text } from "@cloudflare/kumo";
import { LinkSimpleIcon } from "@phosphor-icons/react";
import { SafeExternalLink } from "../SafeExternalLink.tsx";

/** Work kept somewhere else, such as a document in the school's office suite: a card with its link. */
export const ExternalLinkCard = ({ url, title }: { url: string; title: string }) => {
  const host = URL.canParse(url) ? new URL(url).host : url;
  return (
    <Surface className="flex items-start gap-3 rounded-lg border border-kumo-hairline p-4">
      <LinkSimpleIcon aria-hidden size={24} />
      <div className="flex min-w-0 flex-col gap-1">
        <SafeExternalLink href={url}>{title}</SafeExternalLink>
        <Text variant="secondary" size="sm" truncate>
          {host}
        </Text>
      </div>
    </Surface>
  );
};
