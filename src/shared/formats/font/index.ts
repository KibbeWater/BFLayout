/**
 * Scalable game fonts: the obfuscated `.bfttf`/`.bfotf` faces and the `.bfcpx`
 * descriptors that group them into fallback chains.
 *
 * Between them these are what a layout's `fnl1` entry actually resolves to. This game
 * ships no BFFNT bitmap fonts at all, so this is the whole font story for it.
 */

export type { DecodedFont, SfntKind } from './bfttf'
export { decodeBfttf, isBfttf } from './bfttf'

export type { FontComplex } from './bfcpx'
export { isBfcpx, parseBfcpx } from './bfcpx'
