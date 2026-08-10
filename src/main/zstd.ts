/**
 * The one ZSTD instance this process gets.
 *
 * `@bokuweb/zstd-wasm` is a WASM module with internal state, and `init()`
 * instantiates it. Two callers each doing their own lazy init works right up
 * until both run — the second instantiation replaces the first's memory, and the
 * failure that follows looks nothing like its cause: files that opened a moment
 * ago start reporting themselves as an unrecognised format, because the
 * decompression underneath quietly failed and only the still-compressed bytes
 * came back.
 *
 * That is exactly what happened when the headless tools grew their own loader and
 * the app began hosting them in-process. One module, one init, cached — including
 * the in-flight promise, so two concurrent first calls cannot race into two.
 */

type ZstdModule = typeof import('@bokuweb/zstd-wasm')

let loaded: ZstdModule | undefined
let loading: Promise<ZstdModule> | undefined

export async function zstd(): Promise<ZstdModule> {
  if (loaded) return loaded
  loading ??= (async () => {
    const module_ = await import('@bokuweb/zstd-wasm')
    await module_.init()
    loaded = module_
    return module_
  })()
  return loading
}
