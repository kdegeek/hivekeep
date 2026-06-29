import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Loader2, Server } from 'lucide-react'
import { Alert, AlertDescription } from '@/client/components/ui/alert'
import { Button } from '@/client/components/ui/button'
import { Input } from '@/client/components/ui/input'
import { Label } from '@/client/components/ui/label'
import { HivekeepLogo } from '@/client/components/common/HivekeepLogo'
import { getErrorMessage, setHivekeepServerUrl, validateHivekeepServerConnection } from '@/client/lib/api'

interface MobileServerConnectionPageProps {
  initialServerUrl?: string | null
  onConnected: (serverUrl: string) => Promise<void>
}

export function MobileServerConnectionPage({
  initialServerUrl,
  onConnected,
}: MobileServerConnectionPageProps) {
  const { t } = useTranslation()
  const [serverUrl, setServerUrl] = useState(initialServerUrl ?? '')
  const [error, setError] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsConnecting(true)
    try {
      const normalized = await validateHivekeepServerConnection(serverUrl)
      setHivekeepServerUrl(normalized)
      await onConnected(normalized)
    } catch (err) {
      setError(getErrorMessage(err))
    } finally {
      setIsConnecting(false)
    }
  }

  return (
    <div className="surface-base flex min-h-screen items-center justify-center px-4 py-8">
      <div className="theme-orb theme-orb-1 fixed left-1/4 top-1/4 h-64 w-64 aurora-drift" />
      <div className="theme-orb theme-orb-2 fixed right-1/4 bottom-1/4 h-48 w-48 aurora-drift delay-3" />
      <div className="theme-orb theme-orb-3 fixed left-1/2 top-2/3 h-56 w-56 aurora-drift delay-5" />

      <div className="relative z-10 w-full max-w-md animate-fade-in-up">
        <div className="glass-strong rounded-2xl p-8 shadow-lg">
          <div className="mb-8 text-center">
            <HivekeepLogo size={64} title={null} className="mx-auto mb-3" />
            <h1 className="text-3xl font-extrabold text-foreground">Hivekeep</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('mobile.connection.subtitle', 'Connect this phone to your Hivekeep server.')}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {error && (
              <Alert variant="destructive" className="animate-scale-in">
                <AlertCircle className="size-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="hivekeep-server-url">
                {t('mobile.connection.serverUrl', 'Server URL')}
              </Label>
              <Input
                id="hivekeep-server-url"
                type="url"
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                required
                placeholder="https://hivekeep.example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="url"
              />
              <p className="text-xs text-muted-foreground">
                {t('mobile.connection.serverUrlHint', 'The app will validate /api/health before continuing.')}
              </p>
            </div>

            <Button
              type="submit"
              disabled={isConnecting}
              className="btn-shine w-full"
              size="lg"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('mobile.connection.connecting', 'Connecting…')}
                </>
              ) : (
                <>
                  <Server className="size-4" />
                  {initialServerUrl
                    ? t('mobile.connection.reconnect', 'Reconnect')
                    : t('mobile.connection.connect', 'Connect')}
                </>
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
