import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

/**
 * A deliberately narrow lint config: rules that catch *crashes*, not style.
 *
 * Formatting is Prettier's job and the compiler already covers types, so a broad ruleset
 * here would mostly produce noise for a codebase that has none of it enabled today. What
 * is worth having is the one rule the compiler cannot express.
 *
 * `react-hooks/rules-of-hooks` exists because the same mistake shipped twice: a `useMemo`
 * placed below an early return, so a panel rendered fewer hooks than the previous pass and
 * React threw straight to the error boundary. It happened in `properties.tsx`, was found
 * and fixed and documented, and then happened again in `materials.tsx` — which is the
 * signature of a problem that needs a tool rather than more attention. Both are also
 * covered end-to-end now, but a build-time error beats a runtime check.
 *
 * `exhaustive-deps` is a warning rather than an error on purpose. Several memos here key
 * on a revision counter instead of the object it derives from, which is intentional and
 * documented — the object is fresh every render, so depending on it would never hit — and
 * that is precisely the pattern the rule cannot tell from a bug.
 */
export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'drizzle/**', 'tests/fixtures/**']
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    // The TypeScript parser, without type-aware linting: none of the rules below need
    // type information, and a project-wide type check per lint run would cost as much as
    // `pnpm typecheck` for no extra findings.
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
)
