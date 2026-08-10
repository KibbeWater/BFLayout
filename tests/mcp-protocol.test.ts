import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { writeBflyt } from '@shared/formats/bflyt'
import { createLayoutDocument, createPicturePane } from '@shared/formats/bflyt/create'
import { dispatch, PROTOCOL_VERSION, type CallRecord } from '../src/mcp/protocol'
import { createTools, type ToolDefinition } from '../src/mcp/tools'

/**
 * The MCP layer itself, which both transports share.
 *
 * Worth testing separately from either of them: the stdio server and the app's
 * HTTP server differ only in how bytes arrive, so a protocol mistake here is one
 * that reaches both — and the app's transport is the harder one to exercise by
 * hand, since it lives inside a running editor.
 */

let scratch: string
let layoutPath: string
let tools: ToolDefinition[]
const recorded: CallRecord[] = []

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'bflayout-mcp-'))
  layoutPath = join(scratch, 'Menu.bflyt')

  const document = createLayoutDocument({ name: 'Menu' })
  document.rootPane!.children.push(createPicturePane('BtnOk', 0))
  writeFileSync(layoutPath, writeBflyt(document, new Map()))

  tools = createTools({
    describe: async () => ({ host: 'test', openLayouts: ['Menu.bflyt'] }),
    // The app's server supplies the open file here; this is what lets a tool call
    // name no path and mean "the layout on screen".
    defaults: async () => ({ path: layoutPath }),
    edited: () => undefined
  })
})

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const call = async (
  name: string,
  args: Record<string, unknown> = {},
  id = 1
): Promise<{ text: string; isError: boolean }> => {
  const response = (await dispatch(
    { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } },
    tools,
    (record) => recorded.push(record)
  )) as { result: { content: { type: string; text?: string }[]; isError?: boolean } }

  return {
    text: response.result.content.find((part) => part.type === 'text')?.text ?? '',
    isError: response.result.isError === true
  }
}

describe('the MCP protocol', () => {
  it('answers initialize with a version and a name', async () => {
    const response = (await dispatch(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      tools
    )) as { result: { protocolVersion: string; serverInfo: { name: string } } }

    expect(response.result.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(response.result.serverInfo.name).toBe('bflayout')
  })

  /**
   * A notification carries no id and expects no reply. Answering one is a protocol
   * error rather than a harmless extra — and over HTTP it is the difference
   * between a 202 and a body the client did not ask for.
   */
  it('says nothing to a notification', async () => {
    expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools)).toBeNull()
  })

  it('lists every tool with a schema', async () => {
    const response = (await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, tools)) as {
      result: { tools: { name: string; description: string; inputSchema: unknown }[] }
    }

    expect(response.result.tools.length).toBeGreaterThan(25)
    for (const tool of response.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema).toBeTruthy()
    }
    expect(response.result.tools.map((tool) => tool.name)).toContain('current_context')
  })

  it('rejects an unknown method as a JSON-RPC error', async () => {
    const response = (await dispatch(
      { jsonrpc: '2.0', id: 3, method: 'nonsense' },
      tools
    )) as { error: { code: number } }
    expect(response.error.code).toBe(-32601)
  })
})

describe('tool calls', () => {
  it('reads a layout', async () => {
    const result = await call('read_layout', { path: layoutPath })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.text).name).toBe('Menu')
  })

  /**
   * The whole point of the in-app server: an assistant working alongside someone
   * should not have to be told which of 544 layouts is on screen.
   */
  it('falls back to the file the host has open', async () => {
    const result = await call('read_layout', {})
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.text).name).toBe('Menu')
  })

  /**
   * A failed tool is information the model should act on — "no pane called X,
   * here are the names" is a useful turn. A JSON-RPC error would instead say the
   * transport is broken.
   */
  it('reports a tool failure as isError, not as a transport error', async () => {
    const result = await call('edit_pane', { path: layoutPath, pane: 'Ghost', alpha: 10 })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/no pane called Ghost/)
  })

  it('reports an unknown tool as a failed call rather than a crash', async () => {
    const result = await call('no_such_tool', {})
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/no tool called/)
  })

  it('records every call for the activity log', async () => {
    recorded.length = 0
    await call('read_layout', { path: layoutPath })
    await call('read_layout', { path: join(scratch, 'missing.bflyt') })

    expect(recorded.map((entry) => entry.tool)).toEqual(['read_layout', 'read_layout'])
    expect(recorded.map((entry) => entry.ok)).toEqual([true, false])
    expect(recorded[0]!.summary.length).toBeGreaterThan(0)
  })

  /**
   * Two calls against one file otherwise interleave into read-read-write-write and
   * the second write discards the first edit. The queue is what stops that, and it
   * is shared by both transports.
   */
  it('serializes calls so concurrent edits cannot lose one another', async () => {
    const order: string[] = []
    const slow = createTools({
      describe: async () => ({}),
      defaults: async () => ({})
    })
    // Two edits to the same pane, issued at once. Both must land, in order.
    await Promise.all([
      call('edit_pane', { path: layoutPath, pane: 'BtnOk', alpha: 10 }, 10).then(() =>
        order.push('first')
      ),
      call('edit_pane', { path: layoutPath, pane: 'BtnOk', alpha: 20 }, 11).then(() =>
        order.push('second')
      )
    ])

    expect(order).toEqual(['first', 'second'])
    const after = await call('read_layout', { path: layoutPath })
    const root = JSON.parse(after.text).root as { children: { name: string; alpha: number }[] }
    expect(root.children.find((child) => child.name === 'BtnOk')?.alpha).toBe(20)
    expect(slow.length).toBeGreaterThan(0)
  })
})
