import { BookOpen } from '@phosphor-icons/react'
import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'

/**
 * A gatekeeper app's (monochrome) icon, rendered as a CSS mask filled with the current text color
 * so it tints like the Phosphor icons beside it; a book when the app has none.
 */
const GatekeeperAppIcon = ({ icon }: { icon: GatekeeperAppInfo['icon'] }) => {
  if (!icon) return <BookOpen size={14} weight="regular" />
  // Escape the icon URL for safe interpolation into a CSS url("…") string.
  const maskUrl = `url("${icon.url.replace(/[\\"]/g, '\\$&')}")`
  return (
    <span
      aria-hidden
      className="h-3.5 w-3.5 bg-current"
      style={{
        maskImage: maskUrl,
        WebkitMaskImage: maskUrl,
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: 'center',
        WebkitMaskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskSize: 'contain',
      }}
    />
  )
}

export default GatekeeperAppIcon
