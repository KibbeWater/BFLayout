import { Data } from 'effect'

/**
 * Format errors are Data.TaggedError subclasses so they work three ways:
 * plain `Error` instances for the renderer and unit tests, discriminable by
 * `_tag`, and directly usable in Effect's typed error channel in the main
 * process (see src/main/errors.ts for the mapping to oRPC errors).
 */

export class BinaryReadError extends Data.TaggedError('BinaryReadError')<{
  readonly offset: number
  readonly length: number
  readonly available: number
  readonly message: string
}> {}

export class FormatParseError extends Data.TaggedError('FormatParseError')<{
  readonly format: string
  readonly offset: number
  readonly section?: string
  readonly message: string
}> {}

export class FormatWriteError extends Data.TaggedError('FormatWriteError')<{
  readonly format: string
  readonly section?: string
  readonly message: string
}> {}

export class UnsupportedFormatError extends Data.TaggedError('UnsupportedFormatError')<{
  readonly detected: string
  readonly message: string
}> {}
