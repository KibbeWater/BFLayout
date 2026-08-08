import { Data } from 'effect'

import type {
  BinaryReadError,
  FormatParseError,
  FormatWriteError,
  UnsupportedFormatError
} from '@shared/binary/errors'

/** Main-process failures. Format-level failures come from @shared/binary/errors. */

export class DbError extends Data.TaggedError('DbError')<{
  readonly detail: string
}> {}

export class IoError extends Data.TaggedError('IoError')<{
  readonly path?: string
  readonly detail: string
}> {}

export class FileNotFoundError extends Data.TaggedError('FileNotFoundError')<{
  readonly path: string
}> {}

export class NotFoundError extends Data.TaggedError('NotFoundError')<{
  readonly kind: string
  readonly id: string
}> {}

/**
 * The complete set of expected failures crossing the RPC boundary. Adding a
 * member here forces a new branch in toORPCError's exhaustive match.
 */
export type AppError =
  | DbError
  | IoError
  | FileNotFoundError
  | NotFoundError
  | BinaryReadError
  | FormatParseError
  | FormatWriteError
  | UnsupportedFormatError
