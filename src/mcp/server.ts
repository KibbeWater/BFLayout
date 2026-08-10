import { createInterface } from 'node:readline'

import { loadActiveProject } from '@headless/project'
import { createTools, type ToolContext } from './tools'
import { dispatch, type Request } from './protocol'

/**
 * The stdio MCP server, which Claude Code launches itself.
 *
 * The other transport is the one the running app hosts
 * (`main/services/mcp-http.ts`), and the only difference between them is what
 * they can see. This one has no editor to ask, so its context is whatever the app
 * last wrote to its database: the active mod project, and therefore where writes
 * are allowed to land.
 *
 * That is enough to be safe and not enough to be convenient — it cannot know
 * which layout someone is looking at. When the app is running, its own server is
 * the better one to point at.
 */

const context: ToolContext = {
  describe: async () => {
    const lookup = loadActiveProject()
    return {
      host: 'stdio — BFLayout is not necessarily running',
      project: lookup.project,
      detail: lookup.detail,
      writesAreProtected: lookup.project !== null,
      openFiles:
        'not visible from here. Start the in-app server from BFLayout to work on whatever is open.'
    }
  },
  // Nothing is open, so there is nothing to default to.
  defaults: async () => ({})
}

const tools = createTools(context)

// Loaded once at startup so the read-only guard is installed before any tool can
// run, and re-read by `current_context` when asked.
loadActiveProject()

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/*
 * stdout is the transport, so nothing else may write to it — a stray log line is
 * a parse error at the other end. Diagnostics go to stderr.
 */
const input = createInterface({ input: process.stdin })

/**
 * Requests still being served.
 *
 * Exiting the moment stdin closes drops whatever is in flight — which is what
 * happens when a client pipes a batch of calls and closes the stream, and it
 * loses the last reply rather than failing. The close is recorded and acted on
 * once the work is done.
 */
const inFlight = new Set<Promise<void>>()
let closed = false

const finishWhenIdle = (): void => {
  if (closed && inFlight.size === 0) process.exit(0)
}

input.on('line', (line) => {
  const trimmed = line.trim()
  if (trimmed === '') return

  let request: Request
  try {
    request = JSON.parse(trimmed) as Request
  } catch {
    process.stderr.write('[bflayout-mcp] ignoring unparseable line\n')
    return
  }

  const work = dispatch(request, tools)
    .then((response) => {
      if (response !== null) send(response)
    })
    .finally(() => {
      inFlight.delete(work)
      finishWhenIdle()
    })
  inFlight.add(work)
})

input.on('close', () => {
  closed = true
  finishWhenIdle()
})
