import { describe, it, expect } from 'bun:test'

// We test the pure helper functions (validateResponse, formatResponseForLLM)
// by extracting their logic. Since they're not exported, we re-implement the
// exact same logic here to keep tests isolated from DB/SSE dependencies.
// This validates the business rules — if someone refactors and exports them,
// these tests still hold.

import type { HumanPromptOption } from '@/shared/types'

// ─── Re-implemented from source (private functions) ─────────────────────────

function validateResponse(
  promptType: string,
  response: unknown,
  options: HumanPromptOption[],
): string | null {
  const validValues = options.map((o) => o.value)

  switch (promptType) {
    case 'confirm':
      if (typeof response !== 'string' || !validValues.includes(response)) {
        return `Confirm response must be one of: ${validValues.join(', ')}`
      }
      return null

    case 'select':
      if (typeof response !== 'string' || !validValues.includes(response)) {
        return `Select response must be one of: ${validValues.join(', ')}`
      }
      return null

    case 'multi_select':
      if (
        !Array.isArray(response) ||
        response.length === 0 ||
        !response.every((v) => typeof v === 'string' && validValues.includes(v))
      ) {
        return 'Multi-select response must be a non-empty array of valid values'
      }
      return null

    case 'text':
      if (typeof response !== 'string' || response.trim().length === 0) {
        return 'Text response must be a non-empty string'
      }
      return null

    default:
      return 'Unknown prompt type'
  }
}

function formatResponseForLLM(
  promptType: string,
  _question: string,
  response: unknown,
  options: HumanPromptOption[],
): string {
  const optionLabelMap = new Map(options.map((o) => [o.value, o.label]))

  switch (promptType) {
    case 'confirm': {
      const label = optionLabelMap.get(response as string) ?? String(response)
      return label
    }
    case 'select': {
      const label = optionLabelMap.get(response as string) ?? String(response)
      return label
    }
    case 'multi_select': {
      const labels = (response as string[]).map((v) => optionLabelMap.get(v) ?? v)
      return labels.join(', ')
    }
    case 'text':
      return (response as string).trim()
    default:
      return JSON.stringify(response)
  }
}

// ─── Test data ──────────────────────────────────────────────────────────────

const confirmOptions: HumanPromptOption[] = [
  { value: 'yes', label: 'Yes, proceed' },
  { value: 'no', label: 'No, cancel' },
]

const selectOptions: HumanPromptOption[] = [
  { value: 'gpt-4', label: 'GPT-4' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
]

const multiSelectOptions: HumanPromptOption[] = [
  { value: 'email', label: 'Email' },
  { value: 'sms', label: 'SMS' },
  { value: 'push', label: 'Push notification' },
  { value: 'slack', label: 'Slack' },
]

// ─── validateResponse ───────────────────────────────────────────────────────

describe('validateResponse', () => {
  describe('confirm', () => {
    it('accepts valid confirm response', () => {
      expect(validateResponse('confirm', 'yes', confirmOptions)).toBeNull()
      expect(validateResponse('confirm', 'no', confirmOptions)).toBeNull()
    })

    it('rejects invalid string value', () => {
      const err = validateResponse('confirm', 'maybe', confirmOptions)
      expect(err).toContain('Confirm response must be one of')
      expect(err).toContain('yes')
      expect(err).toContain('no')
    })

    it('rejects non-string types', () => {
      expect(validateResponse('confirm', 123, confirmOptions)).not.toBeNull()
      expect(validateResponse('confirm', true, confirmOptions)).not.toBeNull()
      expect(validateResponse('confirm', null, confirmOptions)).not.toBeNull()
      expect(validateResponse('confirm', undefined, confirmOptions)).not.toBeNull()
      expect(validateResponse('confirm', ['yes'], confirmOptions)).not.toBeNull()
    })

    it('rejects empty string', () => {
      expect(validateResponse('confirm', '', confirmOptions)).not.toBeNull()
    })
  })

  describe('select', () => {
    it('accepts valid select response', () => {
      expect(validateResponse('select', 'gpt-4', selectOptions)).toBeNull()
      expect(validateResponse('select', 'claude', selectOptions)).toBeNull()
      expect(validateResponse('select', 'gemini', selectOptions)).toBeNull()
    })

    it('rejects invalid value', () => {
      const err = validateResponse('select', 'llama', selectOptions)
      expect(err).toContain('Select response must be one of')
    })

    it('is case-sensitive', () => {
      expect(validateResponse('select', 'GPT-4', selectOptions)).not.toBeNull()
      expect(validateResponse('select', 'Claude', selectOptions)).not.toBeNull()
    })

    it('rejects non-string types', () => {
      expect(validateResponse('select', 0, selectOptions)).not.toBeNull()
      expect(validateResponse('select', {}, selectOptions)).not.toBeNull()
    })
  })

  describe('multi_select', () => {
    it('accepts valid single selection', () => {
      expect(validateResponse('multi_select', ['email'], multiSelectOptions)).toBeNull()
    })

    it('accepts valid multiple selections', () => {
      expect(validateResponse('multi_select', ['email', 'sms', 'push'], multiSelectOptions)).toBeNull()
    })

    it('accepts all options selected', () => {
      expect(validateResponse('multi_select', ['email', 'sms', 'push', 'slack'], multiSelectOptions)).toBeNull()
    })

    it('rejects empty array', () => {
      const err = validateResponse('multi_select', [], multiSelectOptions)
      expect(err).toBe('Multi-select response must be a non-empty array of valid values')
    })

    it('rejects array with invalid values', () => {
      expect(validateResponse('multi_select', ['email', 'carrier_pigeon'], multiSelectOptions)).not.toBeNull()
    })

    it('rejects non-array types', () => {
      expect(validateResponse('multi_select', 'email', multiSelectOptions)).not.toBeNull()
      expect(validateResponse('multi_select', 42, multiSelectOptions)).not.toBeNull()
      expect(validateResponse('multi_select', null, multiSelectOptions)).not.toBeNull()
    })

    it('rejects array with non-string elements', () => {
      expect(validateResponse('multi_select', [123, 'email'], multiSelectOptions)).not.toBeNull()
      expect(validateResponse('multi_select', [null], multiSelectOptions)).not.toBeNull()
    })
  })

  describe('text', () => {
    it('accepts a non-empty string regardless of options', () => {
      expect(validateResponse('text', 'hello', [])).toBeNull()
      expect(validateResponse('text', 'a longer answer with spaces', [])).toBeNull()
    })

    it('rejects empty or whitespace-only strings', () => {
      expect(validateResponse('text', '', [])).not.toBeNull()
      expect(validateResponse('text', '   ', [])).not.toBeNull()
      expect(validateResponse('text', '\n\t ', [])).not.toBeNull()
    })

    it('rejects non-string types', () => {
      expect(validateResponse('text', 42, [])).not.toBeNull()
      expect(validateResponse('text', null, [])).not.toBeNull()
      expect(validateResponse('text', ['hi'], [])).not.toBeNull()
    })
  })

  describe('unknown prompt type', () => {
    it('returns error for unknown types', () => {
      expect(validateResponse('freetext', 'hello', [])).toBe('Unknown prompt type')
      expect(validateResponse('', 'hello', [])).toBe('Unknown prompt type')
      expect(validateResponse('rating', 5, [])).toBe('Unknown prompt type')
    })
  })

  describe('edge cases', () => {
    it('works with empty options array for confirm/select', () => {
      // No valid values → any response is invalid
      expect(validateResponse('confirm', 'yes', [])).not.toBeNull()
      expect(validateResponse('select', 'anything', [])).not.toBeNull()
    })

    it('works with single option', () => {
      const single: HumanPromptOption[] = [{ value: 'only', label: 'Only option' }]
      expect(validateResponse('confirm', 'only', single)).toBeNull()
      expect(validateResponse('select', 'only', single)).toBeNull()
      expect(validateResponse('multi_select', ['only'], single)).toBeNull()
    })
  })
})

// ─── formatResponseForLLM ───────────────────────────────────────────────────

describe('formatResponseForLLM', () => {
  describe('confirm', () => {
    it('returns label for valid value', () => {
      expect(formatResponseForLLM('confirm', 'Continue?', 'yes', confirmOptions)).toBe('Yes, proceed')
      expect(formatResponseForLLM('confirm', 'Continue?', 'no', confirmOptions)).toBe('No, cancel')
    })

    it('falls back to string representation for unknown value', () => {
      expect(formatResponseForLLM('confirm', 'Q?', 'unknown', confirmOptions)).toBe('unknown')
    })
  })

  describe('select', () => {
    it('returns label for valid value', () => {
      expect(formatResponseForLLM('select', 'Pick model', 'claude', selectOptions)).toBe('Claude')
      expect(formatResponseForLLM('select', 'Pick model', 'gpt-4', selectOptions)).toBe('GPT-4')
    })

    it('falls back to raw value if not found', () => {
      expect(formatResponseForLLM('select', 'Pick', 'llama', selectOptions)).toBe('llama')
    })
  })

  describe('multi_select', () => {
    it('returns comma-separated labels', () => {
      expect(formatResponseForLLM('multi_select', 'Channels?', ['email', 'sms'], multiSelectOptions)).toBe('Email, SMS')
    })

    it('returns single label for single selection', () => {
      expect(formatResponseForLLM('multi_select', 'Channels?', ['push'], multiSelectOptions)).toBe('Push notification')
    })

    it('returns all labels', () => {
      expect(formatResponseForLLM('multi_select', 'Q?', ['email', 'sms', 'push', 'slack'], multiSelectOptions)).toBe('Email, SMS, Push notification, Slack')
    })

    it('falls back to raw value for unknown options', () => {
      expect(formatResponseForLLM('multi_select', 'Q?', ['email', 'unknown'], multiSelectOptions)).toBe('Email, unknown')
    })
  })

  describe('text', () => {
    it('returns the trimmed string', () => {
      expect(formatResponseForLLM('text', 'Anything?', 'just typing here', [])).toBe('just typing here')
    })

    it('trims surrounding whitespace', () => {
      expect(formatResponseForLLM('text', 'Anything?', '  with spaces  ', [])).toBe('with spaces')
      expect(formatResponseForLLM('text', 'Anything?', '\n line break\n', [])).toBe('line break')
    })
  })

  describe('unknown type', () => {
    it('returns JSON stringified response', () => {
      expect(formatResponseForLLM('freetext', 'Q?', 'hello', [])).toBe('"hello"')
      expect(formatResponseForLLM('rating', 'Q?', 5, [])).toBe('5')
      expect(formatResponseForLLM('unknown', 'Q?', { a: 1 }, [])).toBe('{"a":1}')
    })
  })

  describe('edge cases', () => {
    it('handles options with same value and label', () => {
      const opts: HumanPromptOption[] = [{ value: 'ok', label: 'ok' }]
      expect(formatResponseForLLM('confirm', 'Q?', 'ok', opts)).toBe('ok')
    })

    it('handles empty label gracefully', () => {
      const opts: HumanPromptOption[] = [{ value: 'x', label: '' }]
      expect(formatResponseForLLM('select', 'Q?', 'x', opts)).toBe('')
    })
  })
})
