import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      // Renderer modules are testable here as long as they touch no DOM APIs.
      // `editor/commands` is pure document manipulation, and its undo behaviour is
      // worth covering without booting Electron.
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@main': resolve(__dirname, 'src/main'),
      '@headless': resolve(__dirname, 'src/headless')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    globals: false
  }
})
