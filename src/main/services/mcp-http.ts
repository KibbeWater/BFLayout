import { createServer, type Server } from 'node:http'
import { Effect } from 'effect'

import type { McpActivity, McpStatus } from '@shared/contract'
import { IoError } from '@main/errors'
import { dispatch, type CallRecord, type Request } from '../../mcp/protocol'
import { createTools, type ToolContext } from '../../mcp/tools'
import { ArchiveService } from './archive'
import { LayoutService } from './layout'
import { ProjectService } from './projects'

/**
 * The MCP server the app hosts, rather than the one Claude Code launches.
 *
 * Two things follow from it running *inside* the editor, and both are the reason
 * to want it.
 *
 * It can see what is open. A tool call that names no file means the layout on
 * screen, so an assistant working alongside someone does not have to be told —
 * or worse, guess — which of 544 layouts is being looked at. `current_context`
 * reports the project, the folder being browsed, the open archives and the open
 * tabs.
 *
 * And it is visible. Every call is recorded and shown in the app, so the work an
 * agent is doing to your files is something you watch rather than infer. A tool
 * with write access that leaves no trace is one you have to trust blindly.
 *
 * Loopback only, and off until started — the same posture as the game link, and
 * for a stronger reason: these tools write files.
 */

const MAX_BODY = 4 * 1024 * 1024
const MAX_ACTIVITY = 200

export class McpHttpService extends Effect.Service<McpHttpService>()('McpHttpService', {
  scoped: Effect.gen(function* () {
    const projects = yield* ProjectService
    const layouts = yield* LayoutService
    const archives = yield* ArchiveService

    let server: Server | null = null
    let port = 0
    let error: string | null = null
    const activity: McpActivity[] = []
    /** Files an agent has written, so the renderer can reload what it has open. */
    const edited = new Set<string>()

    /**
     * What the app can see, handed to the tools.
     *
     * `defaults` is what makes "no path" mean something: the active layout tab,
     * falling back to the archive being browsed. It is deliberately the *most
     * recently opened* document rather than a guess at focus — main does not know
     * which tab is selected, and the newest is the one someone just opened.
     */
    const context: ToolContext = {
      describe: async () => {
        const project = await Effect.runPromise(
          Effect.orElseSucceed(projects.active, () => null)
        )
        const open = await Effect.runPromise(Effect.orElseSucceed(layouts.list, () => []))
        const openArchives = await Effect.runPromise(
          Effect.orElseSucceed(archives.list, () => [])
        )

        return {
          host: 'BFLayout (in-app server)',
          project,
          writesAreProtected: project !== null,
          detail: project
            ? `${project.dumpPath} is read-only; edits land in ${project.modPath}`
            : 'no mod project is active, so writes go straight to the files named',
          openLayouts: open.map((entry) => ({
            name: entry.displayName,
            source: entry.source
          })),
          openArchives: openArchives.map((archive) => ({
            path: archive.path,
            name: archive.displayName,
            entries: archive.entries.length,
            unsavedChanges: archive.dirty
          })),
          hint: 'Tools that take a path will use the open layout if you leave it out.'
        }
      },

      defaults: async () => {
        const open = await Effect.runPromise(Effect.orElseSucceed(layouts.list, () => []))
        const newest = open[open.length - 1]
        if (!newest) return {}

        if (newest.source.kind === 'file') return { path: newest.source.path }

        const descriptor = await Effect.runPromise(
          Effect.orElseSucceed(archives.describeOne(newest.source.archiveId), () => null)
        )
        if (!descriptor) return {}
        return { path: descriptor.path, entry: newest.source.entryKey }
      },

      edited: (path) => {
        edited.add(path)
      }
    }

    const tools = createTools(context)

    const record = (call: CallRecord): void => {
      activity.push({
        tool: call.tool,
        summary: call.summary,
        ok: call.ok,
        at: call.at,
        /* The arguments matter for reading back what happened, but a base64 image
         * or a whole YAML document would swamp the panel. */
        input: JSON.stringify(call.input).slice(0, 400)
      })
      while (activity.length > MAX_ACTIVITY) activity.shift()
    }

    const status: Effect.Effect<McpStatus> = Effect.sync(() => ({
      listening: server !== null,
      port,
      error,
      calls: activity.length,
      /** Files written since the renderer last asked, so it can reload them. */
      edited: [...edited]
    }))

    const stop: Effect.Effect<void> = Effect.async<void>((resume) => {
      if (!server) {
        resume(Effect.void)
        return
      }
      const closing = server
      server = null
      port = 0
      closing.close(() => resume(Effect.void))
    })

    const start = (requestedPort: number): Effect.Effect<McpStatus, IoError> =>
      Effect.gen(function* () {
        yield* stop
        error = null

        const created = createServer((request, response) => {
          /*
           * No CORS headers, deliberately. This speaks to a local MCP client, and
           * every capability it does not have is one a page in a browser cannot
           * borrow — these tools write files.
           */
          if (request.method === 'GET') {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ ok: true, app: 'bflayout', transport: 'mcp/http' }))
            return
          }
          if (request.method !== 'POST') {
            response.writeHead(405, { 'content-type': 'text/plain' })
            response.end('bflayout MCP: POST JSON-RPC here')
            return
          }

          let body = ''
          let tooBig = false
          request.on('data', (chunk: Buffer) => {
            if (tooBig) return
            body += chunk.toString('utf8')
            if (body.length > MAX_BODY) {
              tooBig = true
              response.writeHead(413).end()
              request.destroy()
            }
          })

          request.on('end', () => {
            if (tooBig) return
            void (async () => {
              try {
                const parsed = JSON.parse(body) as Request | Request[]
                const batch = Array.isArray(parsed) ? parsed : [parsed]

                const answers: unknown[] = []
                for (const item of batch) {
                  const answer = await dispatch(item, tools, record)
                  if (answer !== null) answers.push(answer)
                }

                // A body of only notifications earns 202 and no content, which is
                // what the transport expects rather than an empty JSON object.
                if (answers.length === 0) {
                  response.writeHead(202).end()
                  return
                }
                response.writeHead(200, { 'content-type': 'application/json' })
                response.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]))
              } catch (cause) {
                response.writeHead(400, { 'content-type': 'application/json' })
                response.end(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                      code: -32700,
                      message: cause instanceof Error ? cause.message : 'could not parse the request'
                    }
                  })
                )
              }
            })()
          })
        })

        yield* Effect.async<void, IoError>((resume) => {
          const onError = (cause: Error): void => {
            created.removeListener('error', onError)
            resume(
              Effect.fail(
                new IoError({
                  detail: `could not listen on 127.0.0.1:${requestedPort}: ${cause.message}. Another program may already be using that port — pick a different one.`
                })
              )
            )
          }
          created.once('error', onError)
          created.listen(requestedPort, '127.0.0.1', () => {
            created.removeListener('error', onError)
            resume(Effect.void)
          })
        })

        created.on('error', (cause: Error) => {
          error = cause.message
        })

        server = created
        const address = created.address()
        port = typeof address === 'object' && address !== null ? address.port : requestedPort
        return yield* status
      })

    const recent = (limit: number): Effect.Effect<McpActivity[]> =>
      Effect.sync(() => activity.slice(-limit).reverse())

    /** Clears the edited set once the renderer has reloaded what it holds. */
    const acknowledgeEdits: Effect.Effect<void> = Effect.sync(() => edited.clear())

    const clear: Effect.Effect<void> = Effect.sync(() => {
      activity.length = 0
    })

    // Releases the port on dispose; without it a dev reload leaves the old server
    // holding it and the next start fails with EADDRINUSE.
    yield* Effect.addFinalizer(() => stop)

    return { status, start, stop, recent, clear, acknowledgeEdits } as const
  })
}) {}
