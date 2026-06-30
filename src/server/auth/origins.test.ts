import { describe, expect, it } from 'bun:test'
import { isTrustedOrigin, trustedOrigins } from './origins'

const capacitorAndroidWebViewOrigin = 'http://localhost'
const tauriMacWebViewOrigin = 'tauri://localhost'
const tauriWindowsWebViewOrigin = 'http://tauri.localhost'

// CORS and Better Auth both import this same allowlist, so these tests guard the
// Android WebView origin reviewers asked about and prevent the two configs from
// drifting apart again.
describe('auth origins', () => {
  it('trusts the observed Android Capacitor WebView origin', () => {
    expect(trustedOrigins).toContain(capacitorAndroidWebViewOrigin)
    expect(isTrustedOrigin(capacitorAndroidWebViewOrigin)).toBe(true)
  })

  it('keeps native app origins in the shared CORS/Better Auth allowlist', () => {
    expect(trustedOrigins).toEqual(expect.arrayContaining([
      'capacitor://localhost',
      'http://localhost',
      'https://localhost',
      tauriMacWebViewOrigin,
      tauriWindowsWebViewOrigin,
    ]))
    expect(isTrustedOrigin(tauriMacWebViewOrigin)).toBe(true)
    expect(isTrustedOrigin(tauriWindowsWebViewOrigin)).toBe(true)
  })
})
