import type { GatekeeperAppInfo } from '@gadgets/workshop-shared/api'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { Button } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../../AuthContext'
import SidebarGatekeeperAppSection from '../../components/AppShell/SidebarGatekeeperAppSection'
import AppShell from '../../components/AppShell/AppShell'
import { isSchoolRoute, schoolViews } from './schoolMode'

export const SchoolShell = ({ children }: { children: ReactNode }) => {
  const { authenticatedApi, logout } = useAuthenticatedApi()
  const [creator, setCreator] = useState<{ api: object; allowed: boolean } | null>(null)
  const [workshop, setWorkshop] = useState(false)
  useEffect(() => {
    let cancelled = false
    authenticatedApi.amIAdmin().then((allowed) => {
      if (!cancelled) setCreator({ api: authenticatedApi, allowed })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])
  const canOpenWorkshop = creator?.api === authenticatedApi && creator.allowed
  const [connection, setConnection] = useState<{ api: object; apps: GatekeeperAppInfo[] } | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    setConnection(null)
    authenticatedApi.listGatekeeperApps().then((apps) => {
      if (!cancelled) setConnection({ api: authenticatedApi, apps })
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi, retry])
  const app = connection?.api === authenticatedApi
    ? connection.apps.find(({ id }) => id === 'educateos') : undefined
  const views = schoolViews(app)
  const [selectedRole, setSelectedRole] = useState('')
  const active = views.find(({ role }) => role === selectedRole) ?? views[0]
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const nav = app?.nav?.filter(({ path }) => {
    if (!active) return false
    if (active.role === 'student') return path === '/learn' || path.startsWith('/learn/courses/')
    if (active.role === 'guardian') return path === '/learn/family' || path.startsWith('/learn/family/')
    if (active.role === 'teacher') return path === '/teach' || path.startsWith('/teach/')
    return path === '/admin' || path.startsWith('/admin/') || path.startsWith('/schools/')
  }) ?? []

  if (workshop && canOpenWorkshop) return <div className="flex h-full flex-col">
    <Button variant="secondary" onClick={() => setWorkshop(false)}>Return to School</Button>
    <div className="min-h-0 flex-1"><AppShell>{children}</AppShell></div>
  </div>

  return (
    <div className="flex h-full flex-col bg-kumo-base text-kumo-default">
      <a href="#school-content" className="sr-only focus:not-sr-only">Skip to school content</a>
      <header className="flex flex-wrap items-center gap-4 border-b border-kumo-line p-4">
        <span className="font-semibold">EducateOS</span>
        {views.length > 0 && <nav aria-label="Active school view" className="flex flex-wrap gap-3">
          {views.map((view) => <Link key={view.role} to="/gatekeepers/$appId"
            params={{ appId: 'educateos' }} search={{ path: view.path }}
            aria-current={active?.role === view.role ? 'true' : undefined}
            onClick={() => setSelectedRole(view.role)} className="text-kumo-brand underline">
            {view.label}
          </Link>)}
        </nav>}
        {canOpenWorkshop && <Button variant="secondary" onClick={() => setWorkshop(true)}>Advanced Workshop</Button>}
        <Button variant="secondary" onClick={logout}>Sign out</Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto md:flex-row">
        {app && nav.length > 0 && <aside className="md:w-60 md:shrink-0">
          <SidebarGatekeeperAppSection app={app} nav={nav} />
        </aside>}
        <main id="school-content" tabIndex={-1} className="min-h-0 min-w-0 flex-1">
          {app && isSchoolRoute(pathname) ? children : <section className="mx-auto max-w-xl space-y-4 p-8">
            <h1 className="text-2xl font-semibold">Welcome to your school</h1>
            <p>Use your district account to open your classes, teaching, family, or administration pages. Your district determines which records and actions are available.</p>
            {app ? <Link to="/gatekeepers/$appId" params={{ appId: app.id }}
              search={{ path: active?.path }} className="text-kumo-brand underline">Open School</Link>
              : <><p role="status">School is loading or disconnected. Ask your school administrator to connect your district account if it remains unavailable.</p>
                <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>Check connection</Button></>}
          </section>}
        </main>
      </div>
    </div>
  )
}
