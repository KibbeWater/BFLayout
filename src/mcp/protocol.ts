import type { ToolDefinition } from './tools'

/**
 * MCP itself, separated from how the bytes arrive.
 *
 * The protocol is JSON-RPC 2.0 with three methods that matter, and it is identical
 * whether the messages come down stdin or through an HTTP POST. Keeping it here is
 * what lets the app host the same server Claude Code launches, rather than a
 * second implementation that answers slightly differently.
 */

export const PROTOCOL_VERSION = '2024-11-05'

export interface Request {
  readonly jsonrpc: '2.0'
  readonly id?: number | string | null
  readonly method: string
  readonly params?: Record<string, unknown>
}

export interface CallRecord {
  readonly tool: string
  readonly input: Record<string, unknown>
  readonly ok: boolean
  readonly summary: string
  readonly at: number
}

/**
 * Answers one request, or returns null when there is nothing to answer.
 *
 * A notification carries no id and expects no reply; replying to one is a
 * protocol error rather than a harmless extra.
 */
export async function dispatch(
  request: Request,
  tools: readonly ToolDefinition[],
  onCall?: (record: CallRecord) => void
): Promise<unknown | null> {
  const isNotification = request.id === undefined || request.id === null

  try {
    switch (request.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'bflayout', version: '0.1.0' }
          }
        }

      case 'notifications/initialized':
        return null

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          }
        }

      case 'tools/call': {
        const name = String(request.params?.['name'] ?? '')
        const tool = tools.find((candidate) => candidate.name === name)
        if (!tool) throw new Error(`no tool called ${name}`)

        const input = (request.params?.['arguments'] ?? {}) as Record<string, unknown>
        const result = await serialized(() => tool.run(input))

        onCall?.({
          tool: name,
          input,
          ok: result.isError !== true,
          summary: summarize(result),
          at: Date.now()
        })
        return { jsonrpc: '2.0', id: request.id, result }
      }

      default:
        if (isNotification) return null
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: `unknown method ${request.method}` }
        }
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (isNotification) return null

    if (request.method === 'tools/call') {
      onCall?.({
        tool: String(request.params?.['name'] ?? 'unknown'),
        input: (request.params?.['arguments'] ?? {}) as Record<string, unknown>,
        ok: false,
        summary: message,
        at: Date.now()
      })
      /*
       * A tool that failed reports through `result.isError`, not through a JSON-RPC
       * error. The distinction matters: a JSON-RPC error is a broken client, while a
       * failed tool call is information the model should see and act on — "no pane
       * called X, here are the names" is a useful turn, not a transport fault.
       */
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: { content: [{ type: 'text', text: message }], isError: true }
      }
    }
    return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message } }
  }
}

function summarize(result: { content: readonly { type: string; text?: string }[] }): string {
  const text = result.content.find((part) => part.type === 'text')?.text
  if (text) return text.slice(0, 200).replace(/\s+/g, ' ')
  return result.content.some((part) => part.type === 'image') ? 'rendered an image' : 'done'
}

/**
 * Tool calls run one at a time.
 *
 * They edit files, and two calls against one file interleave into
 * read-read-write-write — the second write silently discards the first edit. A
 * *read* running during a write is worse: it sees a half-written archive and
 * reports that the file is not an archive at all, which sends everything after it
 * chasing the wrong problem.
 *
 * The queue is module-level rather than per-transport on purpose: with the app
 * hosting one server while a stdio one runs in the same process, both would
 * otherwise write the same files concurrently.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  // The chain must not stay rejected, or one failed call would poison every call
  // after it.
  queue = next.then(
    () => undefined,
    () => undefined
  )
  return next
}
