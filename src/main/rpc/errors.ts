import { ORPCError } from '@orpc/server'
import { Match } from 'effect'

import type { AppError } from '@main/errors'

/**
 * Maps Effect tagged errors onto the contract's declared error codes.
 *
 * Match.exhaustive is the enforcement point for end-to-end typed errors: add a
 * member to AppError without a branch here and this stops compiling. Throwing
 * an ORPCError whose code is declared in the contract is what lets the renderer
 * narrow it with isDefinedError.
 */
export const toORPCError = (error: AppError): ORPCError<string, unknown> =>
  Match.value(error).pipe(
    Match.tag(
      'FileNotFoundError',
      (e) =>
        new ORPCError('FILE_NOT_FOUND', {
          message: `File not found: ${e.path}`,
          data: { path: e.path }
        })
    ),
    Match.tag(
      'IoError',
      (e) =>
        new ORPCError('IO_ERROR', {
          message: e.detail,
          data: { path: e.path, detail: e.detail }
        })
    ),
    Match.tag(
      'NotFoundError',
      (e) =>
        new ORPCError('NOT_FOUND', {
          message: `No such ${e.kind}: ${e.id}`,
          data: { kind: e.kind, id: e.id }
        })
    ),
    Match.tag(
      'ReadOnlyError',
      (e) =>
        new ORPCError('READ_ONLY', {
          message: e.detail,
          data: { path: e.path, detail: e.detail }
        })
    ),
    Match.tag(
      'DbError',
      (e) => new ORPCError('DB_ERROR', { message: e.detail, data: { detail: e.detail } })
    ),
    Match.tag(
      'BinaryReadError',
      (e) =>
        new ORPCError('PARSE_ERROR', {
          message: e.message,
          data: {
            format: 'binary',
            offset: e.offset,
            detail: `${e.message} (wanted ${e.length} bytes, ${e.available} available)`
          }
        })
    ),
    Match.tag(
      'FormatParseError',
      (e) =>
        new ORPCError('PARSE_ERROR', {
          message: e.message,
          data: {
            format: e.format,
            offset: e.offset,
            section: e.section,
            detail: e.message
          }
        })
    ),
    Match.tag(
      'FormatWriteError',
      (e) =>
        new ORPCError('WRITE_ERROR', {
          message: e.message,
          data: { format: e.format, section: e.section, detail: e.message }
        })
    ),
    Match.tag(
      'UnsupportedFormatError',
      (e) =>
        new ORPCError('UNSUPPORTED_FORMAT', {
          message: e.message,
          data: { detected: e.detected, detail: e.message }
        })
    ),
    Match.exhaustive
  )
