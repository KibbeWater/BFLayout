import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Ban, Download, Loader2, Upload } from 'lucide-react'

import type { LayoutSource, TextureInfo } from '@shared/contract'
import { getClient, getOrpc } from '@renderer/lib/orpc'
import { describeError } from '@renderer/lib/errors'
import { reportError, reportSuccess } from '@renderer/lib/toast'
import { useActiveTab } from '@renderer/editor/store/document'

/**
 * Lists the textures reachable from the active layout, with a decoded thumbnail
 * for each.
 *
 * Thumbnails are fetched one at a time by the rows themselves rather than in a
 * batch: a layout can reference dozens of textures and decoding all of them at
 * once would stall the main process for no benefit, since only a handful are on
 * screen. Rows that cannot be decoded say why instead of showing nothing.
 */
export function TexturePanel(): ReactNode {
  const orpc = getOrpc()
  const tab = useActiveTab()

  const query = useQuery({
    ...orpc.textures.list.queryOptions({ input: { source: tab?.source as LayoutSource } }),
    enabled: tab !== undefined
  })

  if (!tab) {
    return <Empty>Open a layout to see its textures.</Empty>
  }

  if (query.isPending) {
    return (
      <Empty>
        <Loader2 className="mr-1.5 inline size-3 animate-spin" />
        Looking for textures…
      </Empty>
    )
  }

  if (query.isError) {
    const described = describeError(query.error)
    return (
      <div className="p-3 text-xs">
        <p className="flex items-center gap-1.5 text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          {described.title}
        </p>
        <p className="mt-1 select-text text-muted-foreground">{described.detail}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="mt-2 rounded border px-2 py-1 hover:bg-accent"
        >
          Try again
        </button>
      </div>
    )
  }

  const { textures, unreadable, containerCount } = query.data

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {unreadable.length > 0 ? (
        <div className="m-2 rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px]">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-3.5 shrink-0" />
            {unreadable.length} texture{unreadable.length === 1 ? '' : 's'} could not be read
          </p>
          <ul className="mt-1 space-y-0.5 text-muted-foreground">
            {unreadable.map((entry) => (
              <li key={entry.container} className="select-text">
                <span className="font-mono">{entry.container}</span> — {entry.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {textures.length === 0 ? (
        <Empty>
          {containerCount === 0
            ? 'No BNTX containers found next to this layout.'
            : 'The containers hold no textures.'}
        </Empty>
      ) : (
        <ul className="p-1">
          {textures.map((texture) => (
            <TextureRow key={texture.name} texture={texture} source={tab.source} />
          ))}
        </ul>
      )}
    </div>
  )
}

function TextureRow({
  texture,
  source
}: {
  texture: TextureInfo
  source: LayoutSource
}): ReactNode {
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const orpc = getOrpc()
  const queryClient = useQueryClient()

  /**
   * Writes the decoded texture out as a PNG.
   *
   * The only way to get a texture *out* of an archive: the files ship BNTX with Tegra
   * swizzling and BCn or ASTC compression, which no image editor opens. Offered only
   * where a decoder exists, because there is nothing to write otherwise.
   */
  const exportPng = (): void => {
    setExporting(true)
    void (async () => {
      const client = getClient()
      try {
        const chosen = await client.dialog.saveFileAs({
          purpose: 'image',
          defaultName: `${texture.name.replace(/\.bntx$/i, '')}.png`
        })
        if (chosen.canceled || !chosen.path) return

        const written = await client.textures.exportPng({
          source,
          name: texture.name,
          path: chosen.path
        })
        reportSuccess(
          'Exported',
          `${texture.name} written as ${written.width}×${written.height} PNG (${written.bytes} bytes).`
        )
      } catch (cause) {
        reportError(cause, { retry: exportPng })
      } finally {
        setExporting(false)
      }
    })()
  }

  /**
   * Replaces this texture's pixels from an image on disk.
   *
   * Written in place, so the container's structure is untouched: the image has to
   * be the same size, and the texture has to be in a format there is an encoder
   * for — uncompressed, in practice. Main refuses with the reason and the
   * alternative when either is not true, which is more useful than hiding the
   * button on formats someone might reasonably expect to work.
   */
  const importPng = (): void => {
    setImporting(true)
    void (async () => {
      const client = getClient()
      try {
        const chosen = await client.dialog.openFiles({ purpose: 'image' })
        if (chosen.canceled || chosen.paths.length === 0) return

        const result = await client.textures.importPng({
          source,
          name: texture.name,
          path: chosen.paths[0]!
        })
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.textures.list.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.textures.get.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.archive.get.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.project.status.key() })
        ])
        reportSuccess(
          result.redirected ? 'Imported into the mod' : 'Imported',
          result.path === null
            ? `${texture.name} replaced in ${result.container} (${result.mipsWritten} mip level${result.mipsWritten === 1 ? '' : 's'}). Save the archive to write it to disk.`
            : `${texture.name} replaced in ${result.container} (${result.mipsWritten} mip level${result.mipsWritten === 1 ? '' : 's'}), written to ${result.path}.`
        )
      } catch (cause) {
        reportError(cause, { retry: importPng })
      } finally {
        setImporting(false)
      }
    })()
  }

  return (
    <li className="group flex items-start gap-2 rounded p-1.5 hover:bg-accent/40">
      <Thumbnail texture={texture} source={source} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs" title={texture.name}>
          {texture.name}
        </p>
        <p className="font-mono text-[10px] text-muted-foreground">
          {texture.width}×{texture.height}
          {texture.mipCount > 1 ? ` · ${texture.mipCount} mips` : ''}
        </p>
        <p
          className={`truncate text-[10px] ${
            texture.decodable ? 'text-muted-foreground/70' : 'text-amber-500'
          }`}
          title={texture.container}
        >
          {texture.format}
          {texture.decodable ? '' : ' · no decoder'}
        </p>
      </div>

      <button
        type="button"
        onClick={importPng}
        disabled={importing}
        title={`Replace ${texture.name} from an image (same size; uncompressed formats only)`}
        aria-label={`Replace ${texture.name} from an image`}
        className="shrink-0 rounded p-1 opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
      >
        {importing ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Upload className="size-3.5 text-muted-foreground" />
        )}
      </button>

      {texture.decodable ? (
        <button
          type="button"
          onClick={exportPng}
          disabled={exporting}
          title={`Export ${texture.name} as a PNG`}
          aria-label={`Export ${texture.name} as a PNG`}
          className="shrink-0 rounded p-1 opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
        >
          {exporting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5 text-muted-foreground" />
          )}
        </button>
      ) : null}
    </li>
  )
}

const THUMBNAIL_SIZE = 44

function Thumbnail({
  texture,
  source
}: {
  texture: TextureInfo
  source: LayoutSource
}): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    if (!texture.decodable) return
    let cancelled = false

    void (async () => {
      try {
        const decoded = await getClient().textures.get({ source, name: texture.name })
        if (cancelled) return
        const rgba = new Uint8ClampedArray(await decoded.rgba.arrayBuffer())
        if (cancelled) return

        const canvas = canvasRef.current
        if (!canvas) return
        const context = canvas.getContext('2d')
        if (!context) {
          setFailed('no 2D canvas')
          return
        }

        // Draw at full size into an offscreen bitmap, then let the canvas scale
        // it down — putImageData ignores any transform, so it cannot scale.
        const image = new ImageData(rgba, decoded.width, decoded.height)
        const bitmap = await createImageBitmap(image)
        if (cancelled) return

        const scale = Math.min(
          THUMBNAIL_SIZE / decoded.width,
          THUMBNAIL_SIZE / decoded.height
        )
        const width = Math.max(1, Math.round(decoded.width * scale))
        const height = Math.max(1, Math.round(decoded.height * scale))
        canvas.width = width
        canvas.height = height
        context.drawImage(bitmap, 0, 0, width, height)
        bitmap.close()
      } catch (cause) {
        if (!cancelled) setFailed(describeError(cause).title)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [texture.name, texture.decodable, source])

  if (!texture.decodable || failed) {
    return (
      <div
        className="flex shrink-0 items-center justify-center rounded bg-muted/40 text-muted-foreground/60"
        style={{ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }}
        title={failed ?? `${texture.format} has no decoder in this build`}
      >
        <Ban className="size-4" />
      </div>
    )
  }

  return (
    <div
      className="flex shrink-0 items-center justify-center rounded bg-[repeating-conic-gradient(#3a3a3a_0_25%,#2a2a2a_0_50%)] bg-[length:12px_12px]"
      style={{ width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE }}
    >
      <canvas ref={canvasRef} className="max-h-full max-w-full" />
    </div>
  )
}

function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="p-3 text-xs text-muted-foreground/60">{children}</p>
}
