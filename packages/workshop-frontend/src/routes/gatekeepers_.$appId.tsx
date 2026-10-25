import { createFileRoute } from '@tanstack/react-router'
import GatekeeperAppPage from '../GatekeeperAppPage'
import { parseGatekeeperAppSearch } from '../gatekeeperAppNavigation'
import { useDocumentTitle } from '../useDocumentTitle'
import { useGatekeeperApps } from '../useGatekeeperApps'

/**
 * Generic host for any gatekeeper-served management app (VendorDescription.providesUi). The set of
 * apps and their nav entries come from the backend (useGatekeeperApps); nothing about a specific
 * gatekeeper is hardcoded here. GatekeeperAppPage renders "not available" if the id isn't bound.
 * `?path=` is the place in the app the page shows, kept in step with the app without reloading it.
 *
 * The file is `gatekeepers_.$appId` (trailing underscore) so the URL is /gatekeepers/$appId without
 * nesting inside the /gatekeepers connectors page's component.
 */
export const Route = createFileRoute('/gatekeepers_/$appId')({
  validateSearch: parseGatekeeperAppSearch,
  component: GatekeeperApp,
})

function GatekeeperApp() {
  const { appId } = Route.useParams()
  const { path } = Route.useSearch()
  const navigate = Route.useNavigate()
  const app = useGatekeeperApps().find((a) => a.id === appId)
  useDocumentTitle(app?.title ?? 'App')
  return (
    <GatekeeperAppPage
      appId={appId}
      path={path ?? '/'}
      onPathChange={(next, { replace }) => navigate({ search: { path: next }, replace })}
    />
  )
}
