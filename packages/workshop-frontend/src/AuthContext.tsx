import { createContext, useContext, useState, useEffect, ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

interface AuthContextType {
  authenticatedApi: RpcStub<AuthenticatedApi>
  logout: () => void
  /** Last confirmed user; retained while an API reconnect is being authenticated. */
  currentUser: AiChatAuthorInfo | null
  /** True only when the current API, not a previous connection, confirmed the user. */
  isCurrentUserConfirmed: boolean
  /** Whether the current user is a deployment admin. False while loading / for non-admins. */
  isAdmin: boolean
  /**
   * The model the user chose at onboarding (`AuthenticatedApi.getPreferredModel`), which a picker
   * starts on when this browser has no pick of its own. Null while loading or when there is none.
   */
  preferredModel: string | null
}

const AuthContext = createContext<AuthContextType | null>(null)

interface AuthProviderProps {
  children: ReactNode
  authenticatedApi: RpcStub<AuthenticatedApi>
  onLogout: () => void
}

export function AuthProvider({ children, authenticatedApi, onLogout }: AuthProviderProps) {
  const [identity, setIdentity] = useState<{
    api: RpcStub<AuthenticatedApi>
    user: AiChatAuthorInfo
  } | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [preferredModel, setPreferredModel] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryCount = 0
    const retryDelays = [250, 1000, 2000]
    const confirmUser = () => {
      authenticatedApi.whoami().then((info) => {
        if (!cancelled) setIdentity({ api: authenticatedApi, user: info })
      }).catch(() => {
        if (cancelled || retryCount >= retryDelays.length) return
        retryTimer = setTimeout(confirmUser, retryDelays[retryCount++])
      })
    }
    confirmUser()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.amIAdmin().then((admin) => {
      if (!cancelled) setIsAdmin(admin)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getPreferredModel().then((id) => {
      if (!cancelled) setPreferredModel(id)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  return (
    <AuthContext.Provider value={{
      authenticatedApi, logout: onLogout, currentUser: identity?.user ?? null,
      isCurrentUserConfirmed: identity?.api === authenticatedApi, isAdmin, preferredModel,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthenticatedApi() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuthenticatedApi must be used within an AuthProvider')
  }
  return context
}

/** Returns the auth context when inside an AuthProvider, or null on public pages. */
export function useOptionalAuthenticatedApi(): AuthContextType | null {
  return useContext(AuthContext)
}
