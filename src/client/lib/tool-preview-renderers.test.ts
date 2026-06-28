import { describe, expect, it } from 'bun:test'
import { getPreviewRenderer } from './tool-registry'
import './tool-preview-renderers'

describe('tool preview renderers', () => {
  const fileToolNames = [
    'read_file',
    'write_file',
    'edit_file',
    'multi_edit',
    'list_directory',
    'write_mini_app_file',
    'read_mini_app_file',
    'delete_mini_app_file',
  ]

  it('does not throw while file tool args are still pending', () => {
    for (const toolName of fileToolNames) {
      const renderer = getPreviewRenderer(toolName)
      expect(renderer, toolName).toBeDefined()
      expect(() => renderer?.({ toolName, args: undefined as unknown as Record<string, unknown>, status: 'pending' })).not.toThrow()
    }
  })

  it('keeps completed file previews when args exist', () => {
    expect(getPreviewRenderer('read_file')?.({ toolName: 'read_file', args: { path: 'src/app.ts' }, status: 'success' })).toBe('src/app.ts')
    expect(getPreviewRenderer('multi_edit')?.({
      toolName: 'multi_edit',
      args: { path: 'src/app.ts', edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }] },
      status: 'success',
    })).toBe('src/app.ts (2 edits)')
    expect(getPreviewRenderer('list_directory')?.({ toolName: 'list_directory', args: {}, status: 'pending' })).toBe('.')
  })
})
