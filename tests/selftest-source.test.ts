import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A guard on the end-to-end suite's own source, because one mistake in it is unusually costly.
 *
 * `src/main/selftest.ts` injects its renderer-side scripts as template literals. A backtick anywhere
 * inside one — including inside a comment — ends the literal early, and the build then fails with a
 * parse error pointing at the *comment* rather than at the quoting. That has cost four separate
 * debugging detours in this file alone, always while chasing something else.
 *
 * A comment saying "do not do this" was not enough, and ESLint cannot see it: by the time rules run,
 * the parser has already resolved the literal, so the raw case is only ever a build error. Reading
 * the source as text is the one way to catch it before the build does, and to say *why* when it does.
 */
describe('selftest source', () => {
  const source = readFileSync(join(__dirname, '..', 'src', 'main', 'selftest.ts'), 'utf8')

  it('has no backtick inside an injected renderer script', () => {
    /*
     * The injected scripts are the `executeJavaScript(\`…\`)` arguments. Rather than parse the file,
     * this walks it and tracks whether it is inside one — which is enough, because every injected
     * script in this file opens the same way.
     */
    const opener = 'executeJavaScript(`'
    const offenders: string[] = []

    let at = source.indexOf(opener)
    while (at >= 0) {
      const bodyStart = at + opener.length
      // The literal ends at the first unescaped backtick after it opens.
      let end = bodyStart
      while (end < source.length) {
        if (source[end] === '`' && source[end - 1] !== '\\') break
        end++
      }

      /*
       * A backtick *inside* the body would have ended the literal early, so the body measured above
       * is shorter than intended — which shows up as the closing backtick not being followed by the
       * `)` that every injected call has.
       */
      const closer = source.slice(end, end + 5)
      if (!closer.startsWith('`))') && !closer.startsWith('`)')) {
        const line = source.slice(0, end).split('\n').length
        offenders.push(
          `line ${line}: an injected script ends unexpectedly, which a backtick inside it would cause`
        )
      }

      at = source.indexOf(opener, end)
    }

    expect(offenders).toEqual([])
  })

  it('injects at least a dozen renderer scripts, so the guard above is measuring something', () => {
    // If the opener ever changes shape, the check above would silently pass over everything.
    const count = source.split('executeJavaScript(`').length - 1
    expect(count).toBeGreaterThan(12)
  })
})
