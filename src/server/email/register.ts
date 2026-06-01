import { registerEmailProvider } from '@/server/email/registry'
import { gmailProvider } from '@/server/email/providers/gmail'
import { microsoftProvider } from '@/server/email/providers/microsoft'

/** Register the built-in email providers. Called once at server boot, alongside
 *  the other provider families (see src/server/index.ts). */
export function registerBuiltinEmailProviders(): void {
  registerEmailProvider(gmailProvider)
  registerEmailProvider(microsoftProvider)
}
