import { config } from '@/server/config'

const MOBILE_ORIGINS = [
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
]

const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:3000',
]

function parseOrigins(value: string | undefined) {
  return value?.split(',').map((origin) => origin.trim()).filter(Boolean) ?? []
}

function uniqueOrigins(origins: Array<string | undefined>) {
  return [...new Set(origins.filter((origin): origin is string => Boolean(origin)))]
}

export const trustedOrigins = process.env.TRUSTED_ORIGINS
  ? uniqueOrigins([...parseOrigins(process.env.TRUSTED_ORIGINS), ...MOBILE_ORIGINS])
  : uniqueOrigins([config.publicUrl, ...MOBILE_ORIGINS, ...DEV_ORIGINS])

export function isTrustedOrigin(origin: string | undefined) {
  return Boolean(origin && trustedOrigins.includes(origin))
}
