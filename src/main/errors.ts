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
 * A write that was refused because its destination is mounted read-only.
 *
 * In practice: the pristine romfs dump of an open mod project. Distinct from
 * `IoError` on purpose — the filesystem is fine and retrying will not help, so
 * the message has to say what to do instead rather than report a failure.
 */
export class ReadOnlyError extends Data.TaggedError('ReadOnlyError')<{
  readonly path: string
  readonly detail: string
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
  | ReadOnlyError
  | BinaryReadError
  | FormatParseError
  | FormatWriteError
  | UnsupportedFormatError
