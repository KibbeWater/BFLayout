import { isDefinedError, ORPCError } from '@orpc/client'

export interface DescribedError {
  readonly title: string
  readonly detail: string
  /** True when retrying could plausibly succeed. */
  readonly retryable: boolean
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/**
 * Turns anything thrown into something worth showing a person.
 *
 * The contract's declared error codes carry structured data, so these messages
 * can name the file, the format and the byte offset instead of saying
 * "something went wrong".
 */
export function describeError(error: unknown): DescribedError {
  if (error instanceof ORPCError && isDefinedError(error)) {
    const data = error.data as Record<string, unknown> | undefined

    switch (error.code) {
      case 'FILE_NOT_FOUND': {
        const path = String(data?.['path'] ?? 'unknown path')
        return {
          title: `Can't find ${basename(path)}`,
          detail: `${path} no longer exists. It may have been moved, renamed or deleted.`,
          retryable: false
        }
      }
      case 'IO_ERROR': {
        const path = data?.['path'] ? String(data['path']) : undefined
        return {
          title: path ? `Can't read ${basename(path)}` : 'Filesystem error',
          detail: String(data?.['detail'] ?? error.message),
          retryable: true
        }
      }
      case 'PARSE_ERROR': {
        const format = String(data?.['format'] ?? 'file')
        const offset = Number(data?.['offset'] ?? 0)
        const section = data?.['section'] ? ` in section ${String(data['section'])}` : ''
        return {
          title: `Couldn't read this ${format.toUpperCase()} file`,
          detail:
            `${String(data?.['detail'] ?? error.message)}${section} at byte 0x${offset.toString(16)}. ` +
            'The file may be corrupt, or use a revision BFLayout does not handle yet.',
          retryable: false
        }
      }
      case 'WRITE_ERROR': {
        const format = String(data?.['format'] ?? 'file')
        return {
          title: `Couldn't save this ${format.toUpperCase()} file`,
          detail: `${String(data?.['detail'] ?? error.message)}. Your changes have not been written.`,
          retryable: true
        }
      }
      case 'UNSUPPORTED_FORMAT':
        return {
          title: 'Unsupported file',
          detail: `Detected ${String(data?.['detected'] ?? 'unknown')}. ${String(data?.['detail'] ?? '')}`.trim(),
          retryable: false
        }
      case 'NOT_FOUND':
        return {
          title: 'Not found',
          detail: `No ${String(data?.['kind'] ?? 'item')} named ${String(data?.['id'] ?? '')}.`,
          retryable: false
        }
      /**
       * Not retryable, and deliberately not phrased as a failure: nothing is
       * broken. The dump is read-only because a mod project is open, and the
       * detail from main already names the mod folder the edit belongs in.
       */
      case 'READ_ONLY': {
        const path = String(data?.['path'] ?? '')
        return {
          title: path ? `${basename(path)} is part of the pristine dump` : 'That location is read-only',
          detail: String(data?.['detail'] ?? error.message),
          retryable: false
        }
      }
      case 'DB_ERROR':
        return {
          title: 'Local database error',
          detail: `${String(data?.['detail'] ?? error.message)}. Settings and recent files may not be saved.`,
          retryable: true
        }
      default:
        break
    }
  }

  if (error instanceof ORPCError) {
    return {
      title: 'Background process error',
      detail: error.message || 'The background process reported an unexpected failure.',
      retryable: true
    }
  }

  if (error instanceof Error) {
    return { title: 'Unexpected error', detail: error.message, retryable: true }
  }

  return { title: 'Unexpected error', detail: String(error), retryable: true }
}
