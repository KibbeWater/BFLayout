import { createServer, type Server } from 'node:http'
import { Effect } from 'effect'

import type { GameLinkStatus, GameScreenReport } from '@shared/contract'
import { IoError } from '@main/errors'

/**
 * A local listener for the running game.
 *
 * The hardest question in layout modding is not how to change a screen, it is
 * *which of 544 layouts is the screen in front of me*. Nothing in the files
 * answers it — the mapping from what the game draws to the file that draws it
 * lives in code. But the game knows, and Colony's per-frame hook is already
 * standing next to the answer, so a plugin that reports the current screen turns
 * an afternoon of guessing into a click.
 *
 * Deliberately narrow: it binds to loopback only, it is off unless switched on,
 * it accepts one shape of message, and it stores the last report rather than
 * acting on it. A tool that opens files because something on a socket told it to
 * is a tool with a remote-control problem; offering the jump keeps the decision
 * with the person.
 *
 * The plugin side lives in Colony (`../Tomodachi-MM`); `docs/game-link.md`
 * documents the contract it has to satisfy.
 */

const MAX_BODY = 16 * 1024

export class GameLinkService extends Effect.Service<GameLinkService>()('GameLinkService', {
  // Scoped rather than plain, so the finalizer below can release the port when the
  // runtime is disposed. Without it a dev reload leaves the old server holding the
  // socket and the next start fails with EADDRINUSE.
  scoped: Effect.gen(function* () {
    let server: Server | null = null
    let port = 0
    let last: GameScreenReport | null = null
    let error: string | null = null

    const status: Effect.Effect<GameLinkStatus> = Effect.sync(() => ({
      listening: server !== null,
      port,
      last,
      error
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

    const start = (requestedPort: number): Effect.Effect<GameLinkStatus, IoError> =>
      Effect.gen(function* () {
        yield* stop
        error = null

        const created = createServer((request, response) => {
          /*
           * CORS is deliberately absent and the method set is tiny. This exists for
           * one caller — a plugin inside the emulator — and every capability it does
           * not have is one a web page cannot borrow.
           */
          if (request.method === 'GET' && request.url === '/health') {
            response.writeHead(200, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ ok: true, app: 'bflayout' }))
            return
          }

          if (request.method !== 'POST' || request.url !== '/screen') {
            response.writeHead(404, { 'content-type': 'text/plain' })
            response.end('bflayout game link: POST /screen')
            return
          }

          let body = ''
          let tooBig = false
          request.on('data', (chunk: Buffer) => {
            if (tooBig) return
            body += chunk.toString('utf8')
            // A plugin sending a screen name has no business sending kilobytes;
            // an unbounded accumulator on a socket is a memory leak with a port.
            if (body.length > MAX_BODY) {
              tooBig = true
              response.writeHead(413).end()
              request.destroy()
            }
          })

          request.on('end', () => {
            if (tooBig) return
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>
              const screen = typeof parsed['screen'] === 'string' ? parsed['screen'] : ''
              if (screen === '') {
                response.writeHead(400, { 'content-type': 'application/json' })
                response.end(JSON.stringify({ error: 'expected { screen: string }' }))
                return
              }

              last = {
                screen,
                layout: typeof parsed['layout'] === 'string' ? parsed['layout'] : null,
                archive: typeof parsed['archive'] === 'string' ? parsed['archive'] : null,
                detail: typeof parsed['detail'] === 'string' ? parsed['detail'] : null,
                receivedAt: Date.now()
              }
              response.writeHead(200, { 'content-type': 'application/json' })
              response.end(JSON.stringify({ ok: true }))
            } catch {
              response.writeHead(400, { 'content-type': 'application/json' })
              response.end(JSON.stringify({ error: 'body was not JSON' }))
            }
          })
        })

        /*
         * A listen failure has to become a typed failure rather than an uncaught
         * event: the usual cause is the port already being in use, which is
         * completely recoverable and needs to be said out loud rather than crashing
         * the main process through an unhandled 'error' event.
         */
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

        // Kept so a failure after startup is visible in the status rather than
        // only in a console nobody is reading.
        created.on('error', (cause: Error) => {
          error = cause.message
        })

        server = created
        const address = created.address()
        port = typeof address === 'object' && address !== null ? address.port : requestedPort
        return yield* status
      })

    const clear: Effect.Effect<void> = Effect.sync(() => {
      last = null
    })

    // Releases the port when the runtime is disposed; without this a dev reload
    // leaves the old server holding it and the next start fails with EADDRINUSE.
    yield* Effect.addFinalizer(() => stop)

    return { status, start, stop, clear } as const
  })
}) {}
