import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError } from 'better-auth/api'
import { bearer } from 'better-auth/plugins/bearer'
import { db } from '@/server/db/index'
import * as schema from '@/server/db/schema'
import { config } from '@/server/config'
import { trustedOrigins } from '@/server/auth/origins'

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_BASE_URL ?? config.publicUrl,
  secret: process.env.BETTER_AUTH_SECRET ?? config.encryptionKey,
  database: drizzleAdapter(db, {
    provider: 'sqlite',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Note: open sign-up is gated at the application layer, not here.
    // The onboarding /profile endpoint requires a valid invitation token
    // when an admin already exists. Without a profile, an auth-only user
    // cannot access any protected routes (the /me endpoint returns 404,
    // and the client redirects to onboarding). This is safer than
    // disableSignUp:true which also blocks the onboarding & invitation flows.
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
  trustedOrigins,
  plugins: [bearer()],
})

export type Session = typeof auth.$Infer.Session
