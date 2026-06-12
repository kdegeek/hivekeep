import { describe, it, expect, mock, beforeEach } from 'bun:test'

// Mock the tasks service
const mockReportToParent = mock(() => Promise.resolve(true))
const mockUpdateTaskStatus = mock(() => Promise.resolve(true))
const mockRequestInput = mock(() => Promise.resolve({ success: true }))

// Mocks via `mock.module` are global to the Bun worker — they leak across
// test files. Any export consumed transitively by another test's SUT must be
// present here, otherwise that test fails with "Export named X not found"
// when the two files share a worker. The non-overridden entries below are
// no-op stubs whose only purpose is to satisfy import resolution.
mock.module('@/server/services/tasks', () => ({
  reportToParent: mockReportToParent,
  updateTaskStatus: mockUpdateTaskStatus,
  requestInput: mockRequestInput,
  spawnTask: async () => ({ taskId: 'stub' }),
  respondToTask: async () => true,
  cancelTask: async () => true,
  listAgentTasks: async () => [],
  listSourceAgentTasks: async () => [],
  listTasksFiltered: async () => ({ tasks: [], total: 0 }),
  listTasksPaginated: async () => ({ tasks: [], total: 0 }),
  listAllTasks: async () => [],
  getTask: async () => null,
  getTaskMessages: async () => ({ taskId: '', taskTitle: null, taskStatus: '', total: 0, messages: [] }),
  fetchPreviousCronRuns: async () => [],
  recoverStaleTasks: () => {},
  resumeSubAgent: async () => {},
  resolveTask: async () => {},
  retryTask: async () => ({ taskId: 'stub', queued: false }),
  TaskNotRetryableError: class TaskNotRetryableError extends Error {
    constructor(status: string) { super(`Task status "${status}" is not retryable`); this.name = 'TaskNotRetryableError' }
  },
  TaskNotFoundError: class TaskNotFoundError extends Error {
    constructor(id: string) { super(`Task not found: ${id}`); this.name = 'TaskNotFoundError' }
  },
}))

mock.module('@/server/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}))

const { reportToParentTool, updateTaskStatusTool, requestInputTool } = await import(
  './subtask-tools'
)

// Helper to create a tool instance with given context
function createTool(registration: any, ctx: any) {
  return registration.create(ctx)
}

describe('subtask-tools', () => {
  beforeEach(() => {
    mockReportToParent.mockReset()
    mockUpdateTaskStatus.mockReset()
    mockRequestInput.mockReset()
    mockReportToParent.mockResolvedValue(true)
    mockUpdateTaskStatus.mockResolvedValue(true)
    mockRequestInput.mockResolvedValue({ success: true })
  })

  describe('reportToParentTool', () => {
    it('has sub-agent availability only', () => {
      expect(reportToParentTool.availability).toEqual(['sub-agent'])
    })

    it('returns error when no taskId in context', async () => {
      const tool = createTool(reportToParentTool, { agentId: 'agent-1' })
      const result = await tool.execute({ message: 'hello' }, {} as any)
      expect(result).toEqual({ error: 'No task context — this tool is only available to sub-Agents' })
      expect(mockReportToParent).not.toHaveBeenCalled()
    })

    it('calls reportToParent with taskId and message', async () => {
      const tool = createTool(reportToParentTool, { agentId: 'agent-1', taskId: 'task-42' })
      const result = await tool.execute({ message: 'intermediate result' }, {} as any)
      expect(result).toEqual({ success: true })
      expect(mockReportToParent).toHaveBeenCalledWith('task-42', 'intermediate result')
    })

    it('returns error when reportToParent returns false', async () => {
      mockReportToParent.mockResolvedValue(false)
      const tool = createTool(reportToParentTool, { agentId: 'agent-1', taskId: 'task-42' })
      const result = await tool.execute({ message: 'test' }, {} as any)
      expect(result).toEqual({ error: 'Task not found or not active' })
    })

    it('passes empty string message', async () => {
      const tool = createTool(reportToParentTool, { agentId: 'agent-1', taskId: 'task-1' })
      await tool.execute({ message: '' }, {} as any)
      expect(mockReportToParent).toHaveBeenCalledWith('task-1', '')
    })

    it('passes long message content', async () => {
      const longMsg = 'x'.repeat(10000)
      const tool = createTool(reportToParentTool, { agentId: 'agent-1', taskId: 'task-1' })
      await tool.execute({ message: longMsg }, {} as any)
      expect(mockReportToParent).toHaveBeenCalledWith('task-1', longMsg)
    })

    it('has a description mentioning parent Agent', () => {
      const tool = createTool(reportToParentTool, { agentId: 'agent-1', taskId: 'task-1' })
      expect(tool.description).toContain('parent Agent')
    })
  })

  describe('updateTaskStatusTool', () => {
    it('has sub-agent availability only', () => {
      expect(updateTaskStatusTool.availability).toEqual(['sub-agent'])
    })

    it('returns error when no taskId in context', async () => {
      const tool = createTool(updateTaskStatusTool, { agentId: 'agent-1' })
      const result = await tool.execute({ status: 'completed' }, {} as any)
      expect(result).toEqual({ error: 'No task context — this tool is only available to sub-Agents' })
      expect(mockUpdateTaskStatus).not.toHaveBeenCalled()
    })

    it('calls updateTaskStatus for in_progress', async () => {
      const tool = createTool(updateTaskStatusTool, { agentId: 'agent-1', taskId: 'task-7' })
      const result = await tool.execute({ status: 'in_progress' }, {} as any)
      expect(result).toEqual({ success: true })
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith('task-7', 'in_progress', undefined, undefined)
    })

    it('calls updateTaskStatus for completed with result', async () => {
      const tool = createTool(updateTaskStatusTool, { agentId: 'agent-1', taskId: 'task-7' })
      const result = await tool.execute({ status: 'completed', result: 'all done' }, {} as any)
      expect(result).toEqual({ success: true })
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith('task-7', 'completed', 'all done', undefined)
    })

    it('calls updateTaskStatus for failed with error', async () => {
      const tool = createTool(updateTaskStatusTool, { agentId: 'agent-1', taskId: 'task-7' })
      const result = await tool.execute({ status: 'failed', error: 'something broke' }, {} as any)
      expect(result).toEqual({ success: true })
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith('task-7', 'failed', undefined, 'something broke')
    })

    it('returns error when updateTaskStatus returns false', async () => {
      mockUpdateTaskStatus.mockResolvedValue(false)
      const tool = createTool(updateTaskStatusTool, { agentId: 'agent-1', taskId: 'task-7' })
      const result = await tool.execute({ status: 'completed' }, {} as any)
      expect(result).toEqual({ error: 'Task not found' })
    })

    it('passes both result and error when provided', async () => {
      const tool = createTool(updateTaskStatusTool, { agentId: 'agent-1', taskId: 'task-7' })
      await tool.execute({ status: 'failed', result: 'partial', error: 'timeout' }, {} as any)
      expect(mockUpdateTaskStatus).toHaveBeenCalledWith('task-7', 'failed', 'partial', 'timeout')
    })

    it('has a description mentioning finalization', () => {
      const tool = createTool(updateTaskStatusTool, { agentId: 'agent-1', taskId: 'task-1' })
      expect(tool.description).toContain('completed')
      expect(tool.description).toContain('failed')
      expect(tool.description).toContain('finalize')
    })
  })

  describe('requestInputTool', () => {
    it('has sub-agent availability only', () => {
      expect(requestInputTool.availability).toEqual(['sub-agent'])
    })

    it('returns error when no taskId in context', async () => {
      const tool = createTool(requestInputTool, { agentId: 'agent-1' })
      const result = await tool.execute({ question: 'what color?' }, {} as any)
      expect(result).toEqual({ error: 'No task context — this tool is only available to sub-Agents' })
      expect(mockRequestInput).not.toHaveBeenCalled()
    })

    it('calls requestInput with taskId and question, returns the paused signal so the LLM stops', async () => {
      const tool = createTool(requestInputTool, { agentId: 'agent-1', taskId: 'task-99' })
      const result = await tool.execute({ question: 'which format?' }, {} as any) as {
        success: boolean
        paused?: boolean
        note?: string
      }
      expect(result.success).toBe(true)
      expect(result.paused).toBe(true)
      // The `note` is what nudges the model to stop emitting tool calls this
      // turn — the most important wire to keep intact (cf. prod task #22).
      expect(result.note).toMatch(/PAUSED/)
      expect(result.note).toMatch(/Do NOT emit any further tool calls/)
      expect(mockRequestInput).toHaveBeenCalledWith('task-99', 'which format?')
    })

    it('returns error from requestInput when not successful', async () => {
      mockRequestInput.mockResolvedValue({ success: false, error: 'max requests exceeded' } as any)
      const tool = createTool(requestInputTool, { agentId: 'agent-1', taskId: 'task-99' })
      const result = await tool.execute({ question: 'help?' }, {} as any)
      expect(result).toEqual({ error: 'max requests exceeded' } as any)
    })

    it('returns error undefined when requestInput fails without error message', async () => {
      mockRequestInput.mockResolvedValue({ success: false })
      const tool = createTool(requestInputTool, { agentId: 'agent-1', taskId: 'task-99' })
      const result = await tool.execute({ question: 'help?' }, {} as any)
      expect(result).toEqual({ error: undefined } as any)
    })

    it('has a description mentioning clarification', () => {
      const tool = createTool(requestInputTool, { agentId: 'agent-1', taskId: 'task-1' })
      expect(tool.description).toContain('clarification')
      expect(tool.description).toContain('parent')
    })
  })
})
