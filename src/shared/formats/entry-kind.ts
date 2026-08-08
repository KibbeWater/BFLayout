export type ArchiveEntryKind =
  | 'layout'
  | 'animation'
  | 'texture'
  | 'font'
  | 'archive'
  | 'other'

const BY_EXTENSION: Record<string, ArchiveEntryKind> = {
  bflyt: 'layout',
  bclyt: 'layout',
  brlyt: 'layout',
  bflan: 'animation',
  bclan: 'animation',
  brlan: 'animation',
  bntx: 'texture',
  bflim: 'texture',
  bclim: 'texture',
  tpl: 'texture',
  bti: 'texture',
  bffnt: 'font',
  bcfnt: 'font',
  brfnt: 'font',
  szs: 'archive',
  sarc: 'archive',
  arc: 'archive',
  lyarc: 'archive',
  // Modern Switch titles use these for layout and font archives.
  blarc: 'archive',
  bfarc: 'archive',
  pack: 'archive'
}

/**
 * Outer compression suffixes, stripped before the real extension is read.
 *
 * A romfs stacks them: `Foo.Nin_NX_NVN.blarc.zs` is a ZSTD-compressed layout
 * archive, and reading only the last extension classifies it as "zs" — which is
 * how a file that opens perfectly well came to be reported as unopenable.
 */
const COMPRESSION_SUFFIXES = ['zs', 'zst', 'zstd']

export function classifyEntry(name: string): ArchiveEntryKind {
  const base = name.split(/[\\/]/).pop() ?? name
  let candidate = base.toLowerCase()

  const firstDot = candidate.lastIndexOf('.')
  if (firstDot >= 0 && COMPRESSION_SUFFIXES.includes(candidate.slice(firstDot + 1))) {
    candidate = candidate.slice(0, firstDot)
  }

  const dot = candidate.lastIndexOf('.')
  if (dot < 0) return 'other'
  return BY_EXTENSION[candidate.slice(dot + 1)] ?? 'other'
}
