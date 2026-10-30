import { Sparkle, X } from '@phosphor-icons/react'
import { SCHOOL_CONTEXT_LABELS, type SchoolContext } from '@gadgets/workshop-shared/school-context'

/**
 * The context an "Ask AI about this" link attached to the new chat (SCHO-260), shown above the
 * composer: what it is and its title, as the district confirmed them. Removing it starts the chat
 * without it.
 */
export function SchoolContextChip({ context, onRemove }: { context: SchoolContext; onRemove: () => void }) {
  const label = SCHOOL_CONTEXT_LABELS[context.kind]
  return (
    <div
      role="group"
      aria-label="Chat context"
      className="-mb-5 flex max-w-full items-center gap-2 self-start rounded-full border border-kumo-line bg-kumo-elevated py-1 pl-3 pr-1 text-sm text-kumo-default"
    >
      <Sparkle aria-hidden size={14} className="shrink-0 text-kumo-brand" />
      <span className="shrink-0 font-medium">{label}</span>
      <span aria-hidden className="text-kumo-subtle">·</span>
      <span className="min-w-0 truncate" title={context.title}>{context.title}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${label.toLowerCase()} ${context.title} from this chat`}
        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
      >
        <X aria-hidden size={12} />
      </button>
    </div>
  )
}
