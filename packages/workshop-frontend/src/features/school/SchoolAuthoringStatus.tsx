import { useEffect, useState } from 'react'
import { useAuthenticatedApi } from '../../AuthContext'

/** Discovery is presentation only. No editor opens until its scoped action path is safe. */
export const SchoolAuthoringStatus = () => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [decision, setDecision] = useState<{ api: object; allowed: boolean } | null>(null)
  useEffect(() => {
    let cancelled = false
    authenticatedApi.getWorkshopAuthoringCapability({ operation: 'create' }).then(({ allowed }) => {
      if (!cancelled) setDecision({ api: authenticatedApi, allowed: allowed === true })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])
  const allowed = decision?.api === authenticatedApi && decision.allowed
  return <p role="status">{allowed
    ? 'Your district has approved authoring, but the school creator is not ready. Contact your school administrator for access when it becomes available.'
    : 'Gadget creation and Blueprint adaptation are not available in this school view yet. Your district must approve authoring and provide a focused creator before these actions can open.'}</p>
}
