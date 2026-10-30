import { Badge } from '@cloudflare/kumo'
import { GraduationCap, Sparkle } from '@phosphor-icons/react'
import { useDistrictSidebar } from '../../features/district-frame/districtFrame'
import { schoolHomeContent } from './schoolHomeContent'

export const SchoolHomeIntro = () => {
  const district = useDistrictSidebar()
  if (!district) return null
  const content = schoolHomeContent(district.principal?.role)

  return (
    <header className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-kumo-subtle">
          <GraduationCap size={20} className="shrink-0 text-kumo-brand" aria-hidden="true" />
          <span className="min-w-0 break-words">{district.school.name}</span>
        </p>
        <Badge variant="secondary" icon={<Sparkle size={14} aria-hidden="true" />}>
          {content.label}
        </Badge>
      </div>
      <div className="max-w-xl">
        {district.principal?.name && (
          <p className="mb-3 break-words text-sm text-kumo-subtle">Welcome, {district.principal.name}</p>
        )}
        <h1 className="text-3xl font-semibold leading-tight tracking-tight text-kumo-default sm:text-4xl">
          {content.title}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-kumo-subtle">{content.description}</p>
      </div>
    </header>
  )
}
