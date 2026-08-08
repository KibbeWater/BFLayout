import { ORPCError } from '@orpc/server'
import { Cause, type Effect, Exit, Option } from 'effect'

import type { AppError } from '@main/errors'
import { runtime, type AppServices } from '@main/runtime'
import { toORPCError } from './errors'

/**
 * The single bridge between Effect and oRPC.
 *
 * Expected failures (AppError) become the contract's declared error codes.
 * Defects — thrown exceptions, missing services — become INTERNAL_SERVER_ERROR
 * with the full cause preserved for the log, never leaked to the renderer as a
 * pretend domain error.
 */
export const run = async <A, E extends AppError>(
  effect: Effect.Effect<A, E, AppServices>
): Promise<A> => {
  const exit = await runtime.runPromiseExit(effect)

  if (Exit.isSuccess(exit)) return exit.value

  const failure = Cause.failureOption(exit.cause)
  if (Option.isSome(failure)) throw toORPCError(failure.value)

  const pretty = Cause.pretty(exit.cause)
  console.error('[rpc] defect:', pretty)
  throw new ORPCError('INTERNAL_SERVER_ERROR', { message: pretty })
}
