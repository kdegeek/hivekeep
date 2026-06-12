import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '@/client/lib/api'

export const PRESET_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🎉']

export function useReactions(agentId: string | null) {
  const { t } = useTranslation()

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!agentId) return
      try {
        await api.post(`/agents/${agentId}/messages/${messageId}/reactions`, { emoji })
      } catch {
        toast.error(t('chat.reactionFailed', 'Failed to toggle reaction'))
      }
    },
    [agentId, t],
  )

  return { toggleReaction, presetEmojis: PRESET_EMOJIS }
}
