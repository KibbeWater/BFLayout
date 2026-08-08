/**
 * BC7 (BPTC) decoder.
 *
 * BC7 packs a 4x4 block into 16 bytes using one of eight modes, each with its own bit
 * layout, endpoint precision, subset count and index width. That variety is why it was
 * left undecoded for so long: a mistake in any one mode produces plausible-looking
 * pixels rather than an obvious failure, and there was nothing to check against.
 *
 * There is now. `EXT_texture_compression_bptc` is available in this Electron, so the GPU
 * decodes BC7 natively — which makes it ground truth. The self-test uploads real blocks
 * from a game texture, renders them, reads the pixels back and compares them against this
 * decoder, so every mode that appears in shipped art is checked against hardware rather
 * than against my reading of the spec.
 *
 * The partition and fix-up tables were extracted mechanically from the reference
 * implementation Switch-Toolbox ships (`CSharpImageLibrary/DX10_Helpers.cs`) rather than
 * retyped, because 192 rows of sixteen values is exactly the kind of thing a transcription
 * error hides in.
 */

/**
 * Which subset each of the 16 texels belongs to, indexed by [subsets - 1][partition].
 * The one-subset row is all zeroes, kept so the index arithmetic needs no special case.
 */
const PARTITIONS: readonly (readonly (readonly number[])[])[] = [
  [
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
  ],
  [
    [0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1],
    [0,0,0,1,0,0,0,1,0,0,0,1,0,0,0,1],
    [0,1,1,1,0,1,1,1,0,1,1,1,0,1,1,1],
    [0,0,0,1,0,0,1,1,0,0,1,1,0,1,1,1],
    [0,0,0,0,0,0,0,1,0,0,0,1,0,0,1,1],
    [0,0,1,1,0,1,1,1,0,1,1,1,1,1,1,1],
    [0,0,0,1,0,0,1,1,0,1,1,1,1,1,1,1],
    [0,0,0,0,0,0,0,1,0,0,1,1,0,1,1,1],
    [0,0,0,0,0,0,0,0,0,0,0,1,0,0,1,1],
    [0,0,1,1,0,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,0,0,0,0,0,1,0,1,1,1,1,1,1,1],
    [0,0,0,0,0,0,0,0,0,0,0,1,0,1,1,1],
    [0,0,0,1,0,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1],
    [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1],
    [0,0,0,0,1,0,0,0,1,1,1,0,1,1,1,1],
    [0,1,1,1,0,0,0,1,0,0,0,0,0,0,0,0],
    [0,0,0,0,0,0,0,0,1,0,0,0,1,1,1,0],
    [0,1,1,1,0,0,1,1,0,0,0,1,0,0,0,0],
    [0,0,1,1,0,0,0,1,0,0,0,0,0,0,0,0],
    [0,0,0,0,1,0,0,0,1,1,0,0,1,1,1,0],
    [0,0,0,0,0,0,0,0,1,0,0,0,1,1,0,0],
    [0,1,1,1,0,0,1,1,0,0,1,1,0,0,0,1],
    [0,0,1,1,0,0,0,1,0,0,0,1,0,0,0,0],
    [0,0,0,0,1,0,0,0,1,0,0,0,1,1,0,0],
    [0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0],
    [0,0,1,1,0,1,1,0,0,1,1,0,1,1,0,0],
    [0,0,0,1,0,1,1,1,1,1,1,0,1,0,0,0],
    [0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0],
    [0,1,1,1,0,0,0,1,1,0,0,0,1,1,1,0],
    [0,0,1,1,1,0,0,1,1,0,0,1,1,1,0,0],
    [0,1,0,1,0,1,0,1,0,1,0,1,0,1,0,1],
    [0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1],
    [0,1,0,1,1,0,1,0,0,1,0,1,1,0,1,0],
    [0,0,1,1,0,0,1,1,1,1,0,0,1,1,0,0],
    [0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0],
    [0,1,0,1,0,1,0,1,1,0,1,0,1,0,1,0],
    [0,1,1,0,1,0,0,1,0,1,1,0,1,0,0,1],
    [0,1,0,1,1,0,1,0,1,0,1,0,0,1,0,1],
    [0,1,1,1,0,0,1,1,1,1,0,0,1,1,1,0],
    [0,0,0,1,0,0,1,1,1,1,0,0,1,0,0,0],
    [0,0,1,1,0,0,1,0,0,1,0,0,1,1,0,0],
    [0,0,1,1,1,0,1,1,1,1,0,1,1,1,0,0],
    [0,1,1,0,1,0,0,1,1,0,0,1,0,1,1,0],
    [0,0,1,1,1,1,0,0,1,1,0,0,0,0,1,1],
    [0,1,1,0,0,1,1,0,1,0,0,1,1,0,0,1],
    [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
    [0,1,0,0,1,1,1,0,0,1,0,0,0,0,0,0],
    [0,0,1,0,0,1,1,1,0,0,1,0,0,0,0,0],
    [0,0,0,0,0,0,1,0,0,1,1,1,0,0,1,0],
    [0,0,0,0,0,1,0,0,1,1,1,0,0,1,0,0],
    [0,1,1,0,1,1,0,0,1,0,0,1,0,0,1,1],
    [0,0,1,1,0,1,1,0,1,1,0,0,1,0,0,1],
    [0,1,1,0,0,0,1,1,1,0,0,1,1,1,0,0],
    [0,0,1,1,1,0,0,1,1,1,0,0,0,1,1,0],
    [0,1,1,0,1,1,0,0,1,1,0,0,1,0,0,1],
    [0,1,1,0,0,0,1,1,0,0,1,1,1,0,0,1],
    [0,1,1,1,1,1,1,0,1,0,0,0,0,0,0,1],
    [0,0,0,1,1,0,0,0,1,1,1,0,0,1,1,1],
    [0,0,0,0,1,1,1,1,0,0,1,1,0,0,1,1],
    [0,0,1,1,0,0,1,1,1,1,1,1,0,0,0,0],
    [0,0,1,0,0,0,1,0,1,1,1,0,1,1,1,0],
    [0,1,0,0,0,1,0,0,0,1,1,1,0,1,1,1]
  ],
  [
    [0,0,1,1,0,0,1,1,0,2,2,1,2,2,2,2],
    [0,0,0,1,0,0,1,1,2,2,1,1,2,2,2,1],
    [0,0,0,0,2,0,0,1,2,2,1,1,2,2,1,1],
    [0,2,2,2,0,0,2,2,0,0,1,1,0,1,1,1],
    [0,0,0,0,0,0,0,0,1,1,2,2,1,1,2,2],
    [0,0,1,1,0,0,1,1,0,0,2,2,0,0,2,2],
    [0,0,2,2,0,0,2,2,1,1,1,1,1,1,1,1],
    [0,0,1,1,0,0,1,1,2,2,1,1,2,2,1,1],
    [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2],
    [0,0,0,0,1,1,1,1,1,1,1,1,2,2,2,2],
    [0,0,0,0,1,1,1,1,2,2,2,2,2,2,2,2],
    [0,0,1,2,0,0,1,2,0,0,1,2,0,0,1,2],
    [0,1,1,2,0,1,1,2,0,1,1,2,0,1,1,2],
    [0,1,2,2,0,1,2,2,0,1,2,2,0,1,2,2],
    [0,0,1,1,0,1,1,2,1,1,2,2,1,2,2,2],
    [0,0,1,1,2,0,0,1,2,2,0,0,2,2,2,0],
    [0,0,0,1,0,0,1,1,0,1,1,2,1,1,2,2],
    [0,1,1,1,0,0,1,1,2,0,0,1,2,2,0,0],
    [0,0,0,0,1,1,2,2,1,1,2,2,1,1,2,2],
    [0,0,2,2,0,0,2,2,0,0,2,2,1,1,1,1],
    [0,1,1,1,0,1,1,1,0,2,2,2,0,2,2,2],
    [0,0,0,1,0,0,0,1,2,2,2,1,2,2,2,1],
    [0,0,0,0,0,0,1,1,0,1,2,2,0,1,2,2],
    [0,0,0,0,1,1,0,0,2,2,1,0,2,2,1,0],
    [0,1,2,2,0,1,2,2,0,0,1,1,0,0,0,0],
    [0,0,1,2,0,0,1,2,1,1,2,2,2,2,2,2],
    [0,1,1,0,1,2,2,1,1,2,2,1,0,1,1,0],
    [0,0,0,0,0,1,1,0,1,2,2,1,1,2,2,1],
    [0,0,2,2,1,1,0,2,1,1,0,2,0,0,2,2],
    [0,1,1,0,0,1,1,0,2,0,0,2,2,2,2,2],
    [0,0,1,1,0,1,2,2,0,1,2,2,0,0,1,1],
    [0,0,0,0,2,0,0,0,2,2,1,1,2,2,2,1],
    [0,0,0,0,0,0,0,2,1,1,2,2,1,2,2,2],
    [0,2,2,2,0,0,2,2,0,0,1,2,0,0,1,1],
    [0,0,1,1,0,0,1,2,0,0,2,2,0,2,2,2],
    [0,1,2,0,0,1,2,0,0,1,2,0,0,1,2,0],
    [0,0,0,0,1,1,1,1,2,2,2,2,0,0,0,0],
    [0,1,2,0,1,2,0,1,2,0,1,2,0,1,2,0],
    [0,1,2,0,2,0,1,2,1,2,0,1,0,1,2,0],
    [0,0,1,1,2,2,0,0,1,1,2,2,0,0,1,1],
    [0,0,1,1,1,1,2,2,2,2,0,0,0,0,1,1],
    [0,1,0,1,0,1,0,1,2,2,2,2,2,2,2,2],
    [0,0,0,0,0,0,0,0,2,1,2,1,2,1,2,1],
    [0,0,2,2,1,1,2,2,0,0,2,2,1,1,2,2],
    [0,0,2,2,0,0,1,1,0,0,2,2,0,0,1,1],
    [0,2,2,0,1,2,2,1,0,2,2,0,1,2,2,1],
    [0,1,0,1,2,2,2,2,2,2,2,2,0,1,0,1],
    [0,0,0,0,2,1,2,1,2,1,2,1,2,1,2,1],
    [0,1,0,1,0,1,0,1,0,1,0,1,2,2,2,2],
    [0,2,2,2,0,1,1,1,0,2,2,2,0,1,1,1],
    [0,0,0,2,1,1,1,2,0,0,0,2,1,1,1,2],
    [0,0,0,0,2,1,1,2,2,1,1,2,2,1,1,2],
    [0,2,2,2,0,1,1,1,0,1,1,1,0,2,2,2],
    [0,0,0,2,1,1,1,2,1,1,1,2,0,0,0,2],
    [0,1,1,0,0,1,1,0,0,1,1,0,2,2,2,2],
    [0,0,0,0,0,0,0,0,2,1,1,2,2,1,1,2],
    [0,1,1,0,0,1,1,0,2,2,2,2,2,2,2,2],
    [0,0,2,2,0,0,1,1,0,0,1,1,0,0,2,2],
    [0,0,2,2,1,1,2,2,1,1,2,2,0,0,2,2],
    [0,0,0,0,0,0,0,0,0,0,0,0,2,1,1,2],
    [0,0,0,2,0,0,0,1,0,0,0,2,0,0,0,1],
    [0,2,2,2,1,2,2,2,0,2,2,2,1,2,2,2],
    [0,1,0,1,2,2,2,2,2,2,2,2,2,2,2,2],
    [0,1,1,1,2,0,1,1,2,2,0,1,2,2,2,0]
  ]
]

/**
 * The texel that carries the implicit high bit of each subset's index, by
 * [subsets - 1][partition]. One index per subset is stored a bit short, because the
 * endpoint ordering is chosen so its top bit is always zero.
 */
const FIXUPS: readonly (readonly (readonly number[])[])[] = [
  [
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0],
    [0,0,0]
  ],
  [
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,2,0],
    [0,8,0],
    [0,2,0],
    [0,2,0],
    [0,8,0],
    [0,8,0],
    [0,15,0],
    [0,2,0],
    [0,8,0],
    [0,2,0],
    [0,2,0],
    [0,8,0],
    [0,8,0],
    [0,2,0],
    [0,2,0],
    [0,15,0],
    [0,15,0],
    [0,6,0],
    [0,8,0],
    [0,2,0],
    [0,8,0],
    [0,15,0],
    [0,15,0],
    [0,2,0],
    [0,8,0],
    [0,2,0],
    [0,2,0],
    [0,2,0],
    [0,15,0],
    [0,15,0],
    [0,6,0],
    [0,6,0],
    [0,2,0],
    [0,6,0],
    [0,8,0],
    [0,15,0],
    [0,15,0],
    [0,2,0],
    [0,2,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,15,0],
    [0,2,0],
    [0,2,0],
    [0,15,0]
  ],
  [
    [0,3,15],
    [0,3,8],
    [0,15,8],
    [0,15,3],
    [0,8,15],
    [0,3,15],
    [0,15,3],
    [0,15,8],
    [0,8,15],
    [0,8,15],
    [0,6,15],
    [0,6,15],
    [0,6,15],
    [0,5,15],
    [0,3,15],
    [0,3,8],
    [0,3,15],
    [0,3,8],
    [0,8,15],
    [0,15,3],
    [0,3,15],
    [0,3,8],
    [0,6,15],
    [0,10,8],
    [0,5,3],
    [0,8,15],
    [0,8,6],
    [0,6,10],
    [0,8,15],
    [0,5,15],
    [0,15,10],
    [0,15,8],
    [0,8,15],
    [0,15,3],
    [0,3,15],
    [0,5,10],
    [0,6,10],
    [0,10,8],
    [0,8,9],
    [0,15,10],
    [0,15,6],
    [0,3,15],
    [0,15,8],
    [0,5,15],
    [0,15,3],
    [0,15,6],
    [0,15,6],
    [0,15,8],
    [0,3,15],
    [0,15,3],
    [0,5,15],
    [0,5,15],
    [0,5,15],
    [0,8,15],
    [0,5,15],
    [0,10,15],
    [0,5,15],
    [0,10,15],
    [0,8,15],
    [0,13,15],
    [0,15,3],
    [0,12,15],
    [0,3,15],
    [0,3,8]
  ]
]

/** Interpolation weights for 2-, 3- and 4-bit indices, on a 0..64 scale. */
const WEIGHTS: Record<number, readonly number[]> = {
  2: [0, 21, 43, 64],
  3: [0, 9, 18, 27, 37, 46, 55, 64],
  4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]
}

interface ModeInfo {
  /** Subsets, i.e. how many endpoint pairs the block carries. */
  readonly subsets: number
  readonly partitionBits: number
  readonly rotationBits: number
  readonly indexSelectionBits: number
  readonly colorBits: number
  readonly alphaBits: number
  /** Per-endpoint parity bits, which extend the stored precision by one. */
  readonly endpointPBits: number
  /** Parity bits shared between the two endpoints of a subset. */
  readonly sharedPBits: number
  readonly indexBits: number
  readonly indexBits2: number
}

/**
 * Table C.2 of the BPTC specification, one row per mode.
 *
 * Modes 4 and 5 carry alpha in its own channel with a rotation, which is how BC7 handles
 * art whose alpha is uncorrelated with colour; modes 0-3 have no alpha at all and decode
 * fully opaque.
 */
const MODES: readonly ModeInfo[] = [
  { subsets: 3, partitionBits: 4, rotationBits: 0, indexSelectionBits: 0, colorBits: 4, alphaBits: 0, endpointPBits: 1, sharedPBits: 0, indexBits: 3, indexBits2: 0 },
  { subsets: 2, partitionBits: 6, rotationBits: 0, indexSelectionBits: 0, colorBits: 6, alphaBits: 0, endpointPBits: 0, sharedPBits: 1, indexBits: 3, indexBits2: 0 },
  { subsets: 3, partitionBits: 6, rotationBits: 0, indexSelectionBits: 0, colorBits: 5, alphaBits: 0, endpointPBits: 0, sharedPBits: 0, indexBits: 2, indexBits2: 0 },
  { subsets: 2, partitionBits: 6, rotationBits: 0, indexSelectionBits: 0, colorBits: 7, alphaBits: 0, endpointPBits: 1, sharedPBits: 0, indexBits: 2, indexBits2: 0 },
  { subsets: 1, partitionBits: 0, rotationBits: 2, indexSelectionBits: 1, colorBits: 5, alphaBits: 6, endpointPBits: 0, sharedPBits: 0, indexBits: 2, indexBits2: 3 },
  { subsets: 1, partitionBits: 0, rotationBits: 2, indexSelectionBits: 0, colorBits: 7, alphaBits: 8, endpointPBits: 0, sharedPBits: 0, indexBits: 2, indexBits2: 2 },
  { subsets: 1, partitionBits: 0, rotationBits: 0, indexSelectionBits: 0, colorBits: 7, alphaBits: 7, endpointPBits: 1, sharedPBits: 0, indexBits: 4, indexBits2: 0 },
  { subsets: 2, partitionBits: 6, rotationBits: 0, indexSelectionBits: 0, colorBits: 5, alphaBits: 5, endpointPBits: 1, sharedPBits: 0, indexBits: 2, indexBits2: 0 }
]

/** Reads a bit run from the block, least-significant bit first. */
class BlockReader {
  private pos = 0
  constructor(private readonly bytes: Uint8Array, private readonly base: number) {}

  bits(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
      const at = this.pos + i
      value |= ((this.bytes[this.base + (at >> 3)]! >> (at & 7)) & 1) << i
    }
    this.pos += count
    return value
  }

  get offset(): number {
    return this.pos
  }
}

/** Widens a `from`-bit value to 8 bits by repeating its own high bits. */
function expand(value: number, from: number): number {
  if (from >= 8) return value & 0xff
  const shifted = (value << (8 - from)) & 0xff
  return shifted | (shifted >> from)
}

function interpolate(a: number, b: number, weight: number): number {
  return (a * (64 - weight) + b * weight + 32) >> 6
}

/**
 * Decodes one BC7 block into `out` as a 4x4 RGBA8 tile, row-major.
 *
 * A block whose mode bits are all zero is reserved; it fills transparent black, which is
 * what the specification requires and what hardware does.
 */
export function decodeBc7Block(data: Uint8Array, offset: number, out: Uint8Array): void {
  const reader = new BlockReader(data, offset)

  // The mode is unary: the number of zero bits before the first one.
  let mode = -1
  for (let i = 0; i < 8; i++) {
    if (reader.bits(1) === 1) {
      mode = i
      break
    }
  }

  if (mode < 0) {
    out.fill(0, 0, 64)
    return
  }

  const info = MODES[mode]!
  const partition = info.partitionBits > 0 ? reader.bits(info.partitionBits) : 0
  const rotation = info.rotationBits > 0 ? reader.bits(info.rotationBits) : 0
  const indexSelection = info.indexSelectionBits > 0 ? reader.bits(info.indexSelectionBits) : 0

  const endpointCount = info.subsets * 2

  // Colour endpoints are stored channel-major: every R, then every G, then every B.
  const red: number[] = []
  const green: number[] = []
  const blue: number[] = []
  const alpha: number[] = []
  for (let i = 0; i < endpointCount; i++) red.push(reader.bits(info.colorBits))
  for (let i = 0; i < endpointCount; i++) green.push(reader.bits(info.colorBits))
  for (let i = 0; i < endpointCount; i++) blue.push(reader.bits(info.colorBits))
  if (info.alphaBits > 0) {
    for (let i = 0; i < endpointCount; i++) alpha.push(reader.bits(info.alphaBits))
  }

  /*
   * Parity bits extend each endpoint by one bit at the bottom.
   *
   * `endpointPBits` gives every endpoint its own; `sharedPBits` gives the two endpoints of
   * a subset one between them. Applying them in the wrong place shifts every colour by a
   * fraction of a step, which is exactly the sort of error that looks fine until compared
   * against hardware.
   */
  const parity: number[] = new Array(endpointCount).fill(0)
  if (info.endpointPBits > 0) {
    for (let i = 0; i < endpointCount; i++) parity[i] = reader.bits(1)
  } else if (info.sharedPBits > 0) {
    for (let subset = 0; subset < info.subsets; subset++) {
      const bit = reader.bits(1)
      parity[subset * 2] = bit
      parity[subset * 2 + 1] = bit
    }
  }

  const colorPrecision = info.colorBits + (info.endpointPBits || info.sharedPBits ? 1 : 0)
  const alphaPrecision = info.alphaBits + (info.endpointPBits || info.sharedPBits ? 1 : 0)

  const endpoints: { r: number; g: number; b: number; a: number }[] = []
  for (let i = 0; i < endpointCount; i++) {
    const extend = info.endpointPBits > 0 || info.sharedPBits > 0
    const r = extend ? (red[i]! << 1) | parity[i]! : red[i]!
    const g = extend ? (green[i]! << 1) | parity[i]! : green[i]!
    const b = extend ? (blue[i]! << 1) | parity[i]! : blue[i]!
    const a =
      info.alphaBits > 0 ? (extend ? (alpha[i]! << 1) | parity[i]! : alpha[i]!) : 255

    endpoints.push({
      r: expand(r, colorPrecision),
      g: expand(g, colorPrecision),
      b: expand(b, colorPrecision),
      a: info.alphaBits > 0 ? expand(a, alphaPrecision) : 255
    })
  }

  const subsetOf = PARTITIONS[info.subsets - 1]![partition]!
  const fixups = FIXUPS[info.subsets - 1]![partition]!

  /*
   * Index bits are stored with one index per subset a bit short.
   *
   * The encoder orders each subset's endpoints so that its anchor texel's index has a zero
   * top bit, which is then not written. Reading them at full width shifts every index in
   * the block.
   */
  const readIndices = (width: number): number[] => {
    const out: number[] = []
    for (let texel = 0; texel < 16; texel++) {
      const anchor = fixups.includes(texel) || texel === 0
      out.push(reader.bits(anchor ? width - 1 : width))
    }
    return out
  }

  const primary = readIndices(info.indexBits)
  const secondary = info.indexBits2 > 0 ? readIndices(info.indexBits2) : null

  const colorWeights = WEIGHTS[secondary && indexSelection === 1 ? info.indexBits2 : info.indexBits]!
  const alphaWeights = WEIGHTS[secondary ? (indexSelection === 1 ? info.indexBits : info.indexBits2) : info.indexBits]!

  for (let texel = 0; texel < 16; texel++) {
    const subset = subsetOf[texel]!
    const low = endpoints[subset * 2]!
    const high = endpoints[subset * 2 + 1]!

    /*
     * With two index sets, one drives colour and one drives alpha; the index-selection bit
     * says which way round. Without them both come from the same set.
     */
    const colorIndex = secondary && indexSelection === 1 ? secondary[texel]! : primary[texel]!
    const alphaIndex = secondary
      ? indexSelection === 1
        ? primary[texel]!
        : secondary[texel]!
      : primary[texel]!

    const cw = colorWeights[colorIndex] ?? 0
    const aw = alphaWeights[alphaIndex] ?? 0

    let r = interpolate(low.r, high.r, cw)
    let g = interpolate(low.g, high.g, cw)
    let b = interpolate(low.b, high.b, cw)
    let a = info.alphaBits > 0 ? interpolate(low.a, high.a, aw) : 255

    /*
     * Rotation swaps alpha with one colour channel, which is how modes 4 and 5 store art
     * whose alpha varies independently of its colour.
     */
    if (rotation === 1) [r, a] = [a, r]
    else if (rotation === 2) [g, a] = [a, g]
    else if (rotation === 3) [b, a] = [a, b]

    const at = texel * 4
    out[at] = r
    out[at + 1] = g
    out[at + 2] = b
    out[at + 3] = a
  }
}
