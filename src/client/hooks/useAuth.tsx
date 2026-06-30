import { useState, useEffect, useCallback, useContext, createContext } from 'react'
import type { ReactNode } from 'react'
import {
  api,
  buildApiUrl,
  clearNativeSessionToken,
  isNativeApiRuntime,
  setNativeSessionToken,
  withNativeAuthTransport,
} from '@/client/lib/api'
import i18n, { changeAppLanguage } from '@/client/lib/i18n'

interface UserProfile {
  id: string
  email: string
  firstName: string
  lastName: string
  pseudonym: string
  /** Interface (UI translation) language — one of SUPPORTED_LANGUAGES. */
  language: string
  /** Language Agents speak to this user (AGENT_LANGUAGES code). Null = follow `language`. */
  agentLanguage?: string | null
  role: 'admin' | 'member'
  avatarUrl: string | null
  agentOrder: string | null
  /** Set once the user dismisses the conversational onboarding modal (DB-backed
   *  so a fresh DB re-shows it; persists across devices/browsers). */
  onboardingModalDismissed?: boolean
  /** Appearance preferences (DB-backed, synced across devices). Null = unset
   *  (the client uses its localStorage cache / defaults). See ThemeDbSync. */
  theme?: 'light' | 'dark' | 'system' | null
  palette?: string | null
  contrastMode?: 'normal' | 'soft' | null
  createdAt: number | null
  /** IANA timezone the server uses to interpret cron schedules. */
  serverTimezone: string
}

interface AuthState {
  user: UserProfile | null
  isLoading: boolean
  isAuthenticated: boolean
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>
  register: (data: { name: string; email: string; password: string }) => Promise<void>
  logout: () => Promise<void>
  refetch: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isLoading: true,
    isAuthenticated: false,
  })

  const fetchUser = useCallback(async () => {
    try {
      const user = await api.get<UserProfile>('/me')
      if (user.language && user.language !== i18n.language) {
        await changeAppLanguage(user.language)
      }
      setState({ user, isLoading: false, isAuthenticated: true })
    } catch {
      setState({ user: null, isLoading: false, isAuthenticated: false })
    }
  }, [])

  useEffect(() => {
    fetchUser()
  }, [fetchUser])

  const login = async (email: string, password: string) => {
    const response = await fetch(buildApiUrl('/auth/sign-in/email'), withNativeAuthTransport({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }))

    const body = await response.json().catch(() => ({})) as { message?: string; token?: string }

    if (!response.ok) {
      throw new Error(body?.message ?? 'Login failed')
    }

    const nativeToken = response.headers.get('set-auth-token') ?? body.token
    if (isNativeApiRuntime() && nativeToken) {
      setNativeSessionToken(nativeToken)
    }

    // Verify the session was actually established — throws if not
    const user = await api.get<UserProfile>('/me')
    if (user.language && user.language !== i18n.language) {
      await changeAppLanguage(user.language)
    }
    setState({ user, isLoading: false, isAuthenticated: true })
  }

  const register = async (data: {
    name: string
    email: string
    password: string
  }) => {
    const response = await fetch(buildApiUrl('/auth/sign-up/email'), withNativeAuthTransport({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }))

    const body = await response.json().catch(() => ({})) as { token?: string }

    if (!response.ok) {
      throw body
    }

    const nativeToken = response.headers.get('set-auth-token') ?? body.token
    if (isNativeApiRuntime() && nativeToken) {
      setNativeSessionToken(nativeToken)
    }

    await fetchUser()
  }

  const logout = async () => {
    try {
      await fetch(buildApiUrl('/auth/sign-out'), withNativeAuthTransport({
        method: 'POST',
      }))
    } finally {
      if (isNativeApiRuntime()) clearNativeSessionToken()
      window.location.href = '/'
    }
  }

  return (
    <AuthContext.Provider value={{
      ...state,
      login,
      register,
      logout,
      refetch: fetchUser,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
