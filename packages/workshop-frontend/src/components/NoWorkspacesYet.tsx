import { Link } from '@tanstack/react-router'
import { Empty, buttonVariants } from '@cloudflare/kumo'
import { ChatsCircle } from '@phosphor-icons/react'
import { useDistrictSidebar } from '../features/district-frame/districtFrame'

/**
 * The Workspaces page when there are none and no featured blueprint to offer: a workspace starts as
 * a conversation on Home, so point there rather than leave the page blank.
 */
export const NoWorkspacesYet = () => {
  const district = useDistrictSidebar()
  const home = district ? 'AI home' : 'Home'
  return (
    <Empty
      icon={<ChatsCircle size={40} className="text-kumo-brand" aria-hidden="true" />}
      title="No workspaces yet"
      description={district
        ? 'Start a conversation in AI home. Each lesson, practice set, or learning tool you make gets its own workspace here.'
        : 'Start a conversation on Home and the workspace it creates will appear here.'}
      contents={<Link to="/" className={buttonVariants({ variant: 'primary' })}>Go to {home}</Link>}
    />
  )
}
