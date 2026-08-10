import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Copy,
  Loader2,
  Radio,
  Trash2,
  XCircle
} from 'lucide-react'

import { getClient, getOrpc } from '@renderer/lib/orpc'
import { reportError, reportInfo, reportSuccess } from '@renderer/lib/toast'

/**
 * The MCP server the app hosts, and what it has been doing.
 *
 * Two reasons this is a panel rather than a setting. An agent with write access
 * to a mod is something to watch, not something to trust blindly — so every call
 * it makes appears here as it happens. And running inside the editor is what lets
 * a tool call mean "the layout that is open", which is the difference between an
 * assistant that has to be told which of 544 files you are looking at and one
 * that already knows.
 */

const PORT = 47601

function timeOf(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

export function AgentPanel(): ReactNode {
  const orpc = getOrpc()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  const status = useQuery({
    ...orpc.mcp.status.queryOptions(),
    // Polled only while it is running: an idle panel should not wake anything up.
    refetchInterval: (result) => (result.state.data?.listening ? 1000 : false)
  })
  const listening = status.data?.listening === true

  const activity = useQuery({
    ...orpc.mcp.activity.queryOptions({ input: { limit: 50 } }),
    enabled: listening,
    refetchInterval: listening ? 1000 : false
  })

  /*
   * An agent writing a file the editor has open would otherwise be silently
   * undone: the open tab still holds its own copy, and its next save writes that
   * over the change. Reporting it is the honest minimum — the tab is not
   * reloaded automatically, because doing so to a tab with unsaved edits would
   * throw away the person's work to make room for the agent's.
   */
  const editedFiles = status.data?.edited ?? []
  useEffect(() => {
    if (editedFiles.length === 0) return
    reportInfo(
      `The agent wrote ${editedFiles.length} file${editedFiles.length === 1 ? '' : 's'}`,
      `${editedFiles.map((path) => path.split('/').pop()).join(', ')}. Reopen ${
        editedFiles.length === 1 ? 'it' : 'them'
      } to see the change — an open tab still holds the copy it was opened with.`
    )
    void getClient().mcp.acknowledgeEdits()
    void queryClient.invalidateQueries({ queryKey: orpc.project.status.key() })
    void queryClient.invalidateQueries({ queryKey: orpc.folder.list.key() })
  }, [editedFiles, orpc, queryClient])

  const toggle = (): void => {
    setBusy(true)
    void (async () => {
      try {
        const client = getClient()
        if (listening) {
          await client.mcp.stop()
          reportSuccess('Agent server stopped', 'Claude Code can no longer reach this app.')
        } else {
          const started = await client.mcp.start({ port: PORT })
          reportSuccess(
            'Agent server running',
            `Listening on 127.0.0.1:${started.port}. Point Claude Code at it — the Copy button gives you the config.`
          )
        }
        void queryClient.invalidateQueries({ queryKey: orpc.mcp.status.key() })
      } catch (cause) {
        reportError(cause, { retry: toggle })
      } finally {
        setBusy(false)
      }
    })()
  }

  const copyConfig = (): void => {
    const config = {
      mcpServers: {
        'bflayout-app': {
          type: 'http',
          url: `http://127.0.0.1:${status.data?.port ?? PORT}`
        }
      }
    }
    void navigator.clipboard
      .writeText(JSON.stringify(config, null, 2))
      .then(() =>
        reportSuccess(
          'Config copied',
          'Paste it into .mcp.json in the project you are modding, then run /mcp in Claude Code.'
        )
      )
      .catch((cause: unknown) => reportError(cause))
  }

  const clear = (): void => {
    void (async () => {
      try {
        await getClient().mcp.clear()
        void queryClient.invalidateQueries({ queryKey: orpc.mcp.activity.key() })
      } catch (cause) {
        reportError(cause)
      }
    })()
  }

  const calls = activity.data ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b p-2">
        <div className="flex items-center gap-1.5">
          <Bot className="size-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 text-xs font-medium">Agent access</span>
          <Radio
            className={`size-3 shrink-0 ${listening ? 'text-emerald-500' : 'text-muted-foreground/40'}`}
          />
        </div>

        <p className="text-[11px] text-muted-foreground">
          {listening ? (
            <>
              Serving MCP on{' '}
              <span className="font-mono">127.0.0.1:{status.data?.port}</span>. Tools that take
              a file will use whatever you have open.
            </>
          ) : (
            <>
              Lets Claude Code read and edit the layouts you have open, and see what you are
              looking at. Loopback only, and off until you start it.
            </>
          )}
        </p>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-[11px] disabled:opacity-50 ${
              listening
                ? 'border hover:bg-accent'
                : 'bg-primary font-medium text-primary-foreground hover:opacity-90'
            }`}
          >
            {busy ? <Loader2 className="size-3 animate-spin" /> : null}
            {listening ? 'Stop' : 'Start server'}
          </button>
          {listening ? (
            <button
              type="button"
              onClick={copyConfig}
              className="flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] hover:bg-accent"
              title="Copy the .mcp.json snippet that points Claude Code here"
            >
              <Copy className="size-3" />
              Copy config
            </button>
          ) : null}
          {calls.length > 0 ? (
            <button
              type="button"
              onClick={clear}
              className="ml-auto flex items-center gap-1 rounded p-1 text-[10px] text-muted-foreground hover:bg-accent"
              title="Clear the log"
            >
              <Trash2 className="size-3" />
            </button>
          ) : null}
        </div>

        {status.data?.error ? (
          <p className="flex items-start gap-1.5 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            {status.data.error}
          </p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {!listening ? (
          <p className="p-3 text-[11px] text-muted-foreground/60">
            Nothing is listening. Start the server and calls will appear here as they happen.
          </p>
        ) : calls.length === 0 ? (
          <p className="p-3 text-[11px] text-muted-foreground/60">
            Waiting for Claude Code. Paste the config, then run <span className="font-mono">/mcp</span>{' '}
            to check it connected.
          </p>
        ) : (
          <ul>
            {calls.map((call, index) => (
              <li key={`${call.at}-${index}`} className="border-b px-2 py-1.5 last:border-b-0">
                <p className="flex items-center gap-1.5">
                  {call.ok ? (
                    <CheckCircle2 className="size-3 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="size-3 shrink-0 text-destructive" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                    {call.tool}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground/50">
                    {timeOf(call.at)}
                  </span>
                </p>
                <p
                  className="mt-0.5 truncate pl-4 font-mono text-[10px] text-muted-foreground/60"
                  title={call.input}
                >
                  {call.input}
                </p>
                <p
                  className={`mt-0.5 line-clamp-2 pl-4 text-[11px] ${
                    call.ok ? 'text-muted-foreground' : 'text-destructive'
                  }`}
                >
                  {call.summary}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
