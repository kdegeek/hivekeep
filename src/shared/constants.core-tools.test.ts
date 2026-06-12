import { describe, it, expect } from 'bun:test'
import { CORE_TOOLS } from '@/shared/constants'

describe('CORE_TOOLS', () => {
  it('includes the protocol minimum that the sub-Agent runner assumes', () => {
    for (const required of [
      'read_file',
      'edit_file',
      'multi_edit',
      'run_shell',
      'grep',
      'list_directory',
      'update_task_status',
      'request_input',
      'prompt_human',
      'prompt_secret',
    ]) {
      expect(CORE_TOOLS).toContain(required)
    }
  })

  it('contains no duplicate entries', () => {
    expect(new Set(CORE_TOOLS).size).toBe(CORE_TOOLS.length)
  })
})
