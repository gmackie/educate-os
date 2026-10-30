import { Button, LayerCard } from '@cloudflare/kumo'
import { ArrowUpLeft } from '@phosphor-icons/react'
import { useDistrictSidebar } from '../../features/district-frame/districtFrame'
import { schoolHomeContent } from './schoolHomeContent'

export const SchoolTaskSuggestions = ({ onPick }: { onPick: (prompt: string) => void }) => {
  const district = useDistrictSidebar()
  const { suggestions } = schoolHomeContent(district?.principal?.role)

  return (
    <section aria-labelledby="school-starters-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="school-starters-heading" className="text-sm font-semibold text-kumo-default">A place to start</h2>
        <p className="text-xs text-kumo-subtle">Choose an idea, then make it your own.</p>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {suggestions.map(({ label, description, prompt, icon: Icon }) => (
          <li key={label} className="min-w-0">
            <LayerCard
              render={<Button variant="ghost" type="button" onClick={() => onPick(prompt)} />}
              className="group h-full w-full items-start justify-start gap-3 whitespace-normal rounded-xl p-4 text-left font-normal"
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-kumo-fill text-kumo-brand">
                <Icon size={22} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold leading-5 text-kumo-default">{label}</span>
                <span className="mt-1 block text-sm leading-5 text-kumo-subtle">{description}</span>
              </span>
              <ArrowUpLeft size={16} className="mt-0.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
            </LayerCard>
          </li>
        ))}
      </ul>
    </section>
  )
}
