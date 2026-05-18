/**
 * Tiny Replicate REST client used by the three native providers.
 *
 * We go through `ctx.http.fetch` rather than `globalThis.fetch` so the
 * plugin's manifest `http:api.replicate.com` / `http:replicate.delivery`
 * permissions are enforced (and every call audited) on the same code
 * path third-party plugins would use.
 *
 * Replicate's prediction API is asynchronous by default — create a
 * prediction, poll until it reaches a terminal status. We use the
 * `Prefer: wait=<seconds>` header so the API blocks up to that long
 * before returning (typically enough for LLM + embedding; image
 * generation may exceed it and fall through to one round of polling).
 */

const API_BASE = 'https://api.replicate.com/v1'

export type ReplicateStatus =
  | 'starting'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export interface ReplicatePrediction<Output = unknown> {
  id: string
  status: ReplicateStatus
  /** Whatever the model returned. Shape varies per model. */
  output: Output | null
  error: string | null
  /** Prediction wall-clock metrics. Used for token-count fallback. */
  metrics?: {
    predict_time?: number
    input_token_count?: number
    output_token_count?: number
    total_token_count?: number
  }
  urls?: {
    get?: string
    cancel?: string
  }
}

interface CreatePredictionParams {
  /** `<owner>/<name>` for "official models" routing, OR omit and pass `version`. */
  model?: string
  /** Specific model version hash. */
  version?: string
  /** Model-specific input shape. */
  input: Record<string, unknown>
  /** Stream events via SSE. Some Replicate models support it. */
  stream?: boolean
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export class ReplicateApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'ReplicateApiError'
  }
}

export class Replicate {
  constructor(
    private readonly fetch: Fetch,
    private readonly token: string,
  ) {}

  private async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const res = await this.fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText)
      throw new ReplicateApiError(
        `Replicate API ${method} ${path} failed (${res.status}): ${text}`,
        res.status,
      )
    }
    return res
  }

  /** Lightweight auth probe — `GET /account` returns `{ type, username }`. */
  async account(): Promise<{ username?: string; type?: string }> {
    const res = await this.request('GET', '/account')
    return res.json() as Promise<{ username?: string; type?: string }>
  }

  /**
   * Create a prediction and return it. When `wait > 0` the API blocks
   * server-side for up to that many seconds before returning, so the
   * response is usually already in a terminal state on common workloads.
   * If it's still running, callers should poll via {@link getPrediction}.
   */
  async createPrediction<Output = unknown>(
    params: CreatePredictionParams & { wait?: number },
  ): Promise<ReplicatePrediction<Output>> {
    const { wait, ...body } = params
    const headers: Record<string, string> = {}
    if (typeof wait === 'number' && wait > 0) {
      headers['Prefer'] = `wait=${Math.min(60, Math.max(1, wait))}`
    }
    const path = body.model ? `/models/${body.model}/predictions` : '/predictions'
    // When using the model-routed endpoint, drop the `model` field — the
    // path identifies it. When using `/predictions` we need `version`.
    const payload = body.model
      ? { input: body.input, ...(body.stream ? { stream: true } : {}) }
      : { version: body.version, input: body.input, ...(body.stream ? { stream: true } : {}) }
    const res = await this.request('POST', path, payload, headers)
    return res.json() as Promise<ReplicatePrediction<Output>>
  }

  /** Fetch the current state of a prediction by ID. */
  async getPrediction<Output = unknown>(
    id: string,
  ): Promise<ReplicatePrediction<Output>> {
    const res = await this.request('GET', `/predictions/${id}`)
    return res.json() as Promise<ReplicatePrediction<Output>>
  }

  /**
   * Poll a prediction until it reaches a terminal status or the deadline
   * is hit. Returns the final prediction. Throws if it failed or got
   * canceled.
   */
  async waitForPrediction<Output = unknown>(
    id: string,
    opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ReplicatePrediction<Output>> {
    const interval = opts.intervalMs ?? 1000
    const timeout = opts.timeoutMs ?? 120_000
    const start = Date.now()
    while (true) {
      if (opts.signal?.aborted) throw new ReplicateApiError('Aborted')
      const p = await this.getPrediction<Output>(id)
      if (p.status === 'succeeded') return p
      if (p.status === 'failed' || p.status === 'canceled') {
        throw new ReplicateApiError(
          `Replicate prediction ${id} ${p.status}: ${p.error ?? 'no error message'}`,
        )
      }
      if (Date.now() - start > timeout) {
        throw new ReplicateApiError(`Replicate prediction ${id} timed out after ${timeout}ms`)
      }
      await new Promise((r) => setTimeout(r, interval))
    }
  }

  /**
   * Convenience helper: create + wait. Always returns a `succeeded`
   * prediction. Throws on failure / cancellation / timeout.
   */
  async runPrediction<Output = unknown>(
    params: CreatePredictionParams,
    opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ReplicatePrediction<Output>> {
    const initial = await this.createPrediction<Output>({ ...params, wait: 60 })
    if (initial.status === 'succeeded') return initial
    if (initial.status === 'failed' || initial.status === 'canceled') {
      throw new ReplicateApiError(
        `Replicate prediction ${initial.id} ${initial.status}: ${initial.error ?? 'no error message'}`,
      )
    }
    return this.waitForPrediction<Output>(initial.id, opts)
  }
}
