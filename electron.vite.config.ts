import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': shared,
        '@main': resolve(__dirname, 'src/main'),
        '@headless': resolve(__dirname, 'src/headless')
      }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        /*
         * Three entry points, not one.
         *
         * The CLI and the MCP server are Node programs sharing the main process's
         * codecs, and building them here is what makes them work outside a source
         * checkout: a packaged app carries no TypeScript and no `tsx`, so
         * `pnpm mcp` would be the only way to run them and only from the repo.
         * Built alongside main they ship in the app and run under Electron's own
         * Node — see docs/mcp.md.
         */
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'cli/main': resolve(__dirname, 'src/cli/main.ts'),
          'mcp/server': resolve(__dirname, 'src/mcp/server.ts')
        },
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      // The RPC client awaits its MessagePort at module scope, so the renderer
      // bundle must keep top-level await.
      target: 'esnext',
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    }
  }
})
