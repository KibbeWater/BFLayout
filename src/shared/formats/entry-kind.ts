export type ArchiveEntryKind =
  | 'layout'
  | 'animation'
  | 'texture'
  | 'font'
  | 'archive'
  | 'data'
  | 'message'
  | 'model'
  | 'audio'
  | 'shader'
  | 'logic'
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
  /*
   * The scalable fonts a `.bfcpx` complex points at, and the complex itself.
   *
   * Missing from this table meant every one of them classified as "other" — so the typefaces the
   * canvas draws real text with were, from the browser's point of view, unrecognised files.
   */
  bfttf: 'font',
  bfotf: 'font',
  bfcpx: 'font',

  /*
   * BYML and its `.bgyml` spelling.
   *
   * `bgyml` is the single most common file type in a modern romfs — 38,265 entries inside the
   * archives of one title, against 2,187 animations — and it is ordinary BYML: all 1,763 loose
   * ones in that dump parse with the existing reader. Leaving the extension off this table meant
   * forty thousand readable files presented as unrecognised.
   */
  byml: 'data',
  bgyml: 'data',
  aamp: 'data',

  msbt: 'message',
  msbp: 'message',

  bfres: 'model',
  bnsh: 'shader',
  bfsha: 'shader',
  sharcb: 'shader',

  bwav: 'audio',
  bars: 'audio',
  bfsar: 'audio',

  ainb: 'logic',
  asb: 'logic',
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
