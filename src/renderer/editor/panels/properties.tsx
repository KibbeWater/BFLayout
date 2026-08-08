import { useMemo, useRef, useState, type ReactNode } from 'react'

import type {
  LayoutDocument,
  Pane,
  PicturePane,
  Rgba,
  TextPane,
  WindowPane
} from '@shared/formats/bflyt'
import { walkPanes } from '@shared/formats/bflyt'
import { paneById, useActiveTab, useDocuments } from '@renderer/editor/store/document'
import {
  composeCommands,
  PANE_NAME_BYTES,
  paneNameProblem,
  setMaterialSnapshot,
  setPaneSnapshot,
  snapshotPane
} from '@renderer/editor/commands'
import { ARRANGEMENT_LABELS, arrangeCommand, type Arrangement } from '@renderer/editor/arrange'

const ORIGIN_X = ['Left', 'Center', 'Right']
const ORIGIN_Y = ['Top', 'Center', 'Bottom']

/**
 * Text alignment packs two axes into one byte: bits 0-1 horizontal, bits 2-3 vertical.
 *
 * Edited as two selects over the packed value rather than exposed as a number, and written
 * with a mask so the bits above the two axes survive. `0` means "inherit from the material"
 * in both axes, which is what most shipped panes use, so it is offered rather than folded
 * into Left/Top.
 */
const TEXT_H_ALIGN = ['Inherit', 'Left', 'Right', 'Center']
const TEXT_V_ALIGN = ['Inherit', 'Top', 'Bottom', 'Center']

/**
 * Bits in a text pane's `flags` word that this build understands.
 *
 * Edited individually and never as a word. Shipped files set bits past these, and clearing
 * an unmodelled bit on save was a real bug once — the codec now preserves them, and this
 * keeps the UI from undoing that.
 */
const TEXT_FLAG_SHADOW = 1 << 0
const TEXT_FLAG_RESTRICTED = 1 << 1
const TEXT_FLAG_PER_CHARACTER = 1 << 4

function withBit(word: number, bit: number, on: boolean): number {
  return on ? word | bit : word & ~bit
}

export function PropertiesPanel(): ReactNode {
  const tab = useActiveTab()
  const runCommand = useDocuments((state) => state.runCommand)

  if (!tab) {
    return <Hint>Open a layout to edit pane properties.</Hint>
  }

  const selectedId = tab.selectedPaneIds[0]
  const pane = selectedId ? paneById(tab.document, selectedId) : null

  if (!pane) {
    return <Hint>Select a pane in the hierarchy.</Hint>
  }

  const selection = tab.selectedPaneIds
  const multiple = selection.length > 1

  /**
   * Every selected pane of the same kind as the active one.
   *
   * Kind matters because the fields below are kind-specific past the common header: a
   * `pic1` has vertex colours a `pan1` does not, and writing them onto the wrong pane kind
   * would produce a document the writer cannot encode. The common fields — visible, size,
   * alpha — are shared by every kind, so those fan out across the whole selection.
   *
   * Descendants are *not* excluded, unlike a move. Setting `visible` on a parent and its
   * child is a perfectly meaningful thing to ask for; a move is the case where the parent
   * carries the child anyway.
   */
  const targets = (kindOnly: boolean): Pane[] => {
    const found: Pane[] = []
    for (const id of selection) {
      const candidate = paneById(tab.document, id)
      if (!candidate) continue
      if (kindOnly && candidate.kind !== pane.kind) continue
      found.push(candidate)
    }
    return found.length > 0 ? found : [pane]
  }

  /**
   * Applies a property edit across the selection and records it as one undo entry.
   *
   * Two things this fixes. The panel used to edit only the first selected pane, which made
   * the marquee, shift-click and ancestor filtering the rest of the app implements pointless
   * the moment you wanted to change anything — setting alpha on twelve panes was twelve
   * separate operations and twelve undo entries. And these edits once went straight through
   * `mutate`, which left every field here outside undo and made the history lie: after
   * typing in a width field, Cmd+Z reverted the previous canvas drag while the toolbar still
   * named the drag as the thing about to be undone.
   *
   * The whole pane is snapshotted rather than the fields touched, because `apply` is an
   * opaque closure and every kind has different fields. Panes are small once children are
   * excluded, and one composed command keeps Cmd+Z symmetrical with the edit.
   */
  const edit = (
    // Returns `unknown` rather than `void` so a bare assignment expression is a legal body:
    // `(target) => (target.width = 8)` is the shape every call site here wants.
    apply: (target: Pane) => unknown,
    options?: { activeOnly?: boolean; kindOnly?: boolean }
  ): void => {
    // Some fields cannot sensibly fan out — a name has to be unique per pane.
    const panes = options?.activeOnly ? [pane] : targets(options?.kindOnly ?? false)

    const commands = panes.flatMap((target) => {
      const before = snapshotPane(target)
      apply(target)
      const after = snapshotPane(target)
      return [setPaneSnapshot(target.id, `Edit ${target.name || target.kind}`, before, after)]
    })

    if (commands.length === 0) return
    runCommand(
      commands.length === 1
        ? commands[0]!
        : composeCommands(`Edit ${commands.length} panes`, commands)
    )
  }

  /**
   * The value every selected pane agrees on, or undefined when they differ.
   *
   * A field showing the first pane's value while eleven others hold something else invites
   * a blind overwrite, so a disagreeing field says so instead.
   */
  const shared = <T,>(read: (target: Pane) => T, kindOnly = false): T | undefined => {
    const panes = targets(kindOnly)
    const first = read(panes[0]!)
    return panes.every((target) => read(target) === first) ? first : undefined
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {multiple ? <ArrangeSection count={tab.selectedPaneIds.length} /> : null}

      <Group
        title={
          multiple
            ? `${selection.length} selected · editing all`
            : `${pane.kind} · ${pane.name || '(unnamed)'}`
        }
      >
        <Field label="Name">
          {/* 24 bytes is the width of the field the writer stores it in. */}
          <TextField
            value={pane.name}
            maxLength={PANE_NAME_BYTES}
            onChange={(next) => edit((target) => (target.name = next), { activeOnly: true })}
            validate={(next) => paneNameProblem(tab.document, pane.id, next)}
          />
        </Field>
        <Row>
          <Toggle
            label="Visible"
            checked={pane.visible}
            onChange={(value) => edit((target) => (target.visible = value))}
          />
          <Toggle
            label="Influence alpha"
            checked={pane.influenceAlpha}
            onChange={(value) => edit((target) => (target.influenceAlpha = value))}
          />
        </Row>
        <Field label="Alpha">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={255}
              value={pane.alpha}
              onChange={(event) => edit((target) => (target.alpha = Number(event.target.value)))}
              className="flex-1"
            />
            <span className="w-8 text-right tabular-nums text-muted-foreground">
              {pane.alpha}
            </span>
          </div>
        </Field>
      </Group>

      <Group title="Transform">
        <Row>
          <NumberField
            label="X"
            value={pane.translate[0]}
            mixed={shared((target) => target.translate[0]) === undefined}
            onChange={(value) => edit((target) => (target.translate[0] = value))}
          />
          <NumberField
            label="Y"
            value={pane.translate[1]}
            mixed={shared((target) => target.translate[1]) === undefined}
            onChange={(value) => edit((target) => (target.translate[1] = value))}
          />
          <NumberField
            label="Z"
            value={pane.translate[2]}
            mixed={shared((target) => target.translate[2]) === undefined}
            onChange={(value) => edit((target) => (target.translate[2] = value))}
          />
        </Row>
        <Row>
          <NumberField
            label="Width"
            value={pane.width}
            mixed={shared((target) => target.width) === undefined}
            onChange={(value) => edit((target) => (target.width = value))}
          />
          <NumberField
            label="Height"
            value={pane.height}
            mixed={shared((target) => target.height) === undefined}
            onChange={(value) => edit((target) => (target.height = value))}
          />
        </Row>
        <Row>
          <NumberField
            label="Rot Z"
            value={pane.rotate[2]}
            mixed={shared((target) => target.rotate[2]) === undefined}
            onChange={(value) => edit((target) => (target.rotate[2] = value))}
          />
          <NumberField
            label="Scale X"
            value={pane.scale[0]}
            mixed={shared((target) => target.scale[0]) === undefined}
            step={0.01}
            onChange={(value) => edit((target) => (target.scale[0] = value))}
          />
          <NumberField
            label="Scale Y"
            value={pane.scale[1]}
            mixed={shared((target) => target.scale[1]) === undefined}
            step={0.01}
            onChange={(value) => edit((target) => (target.scale[1] = value))}
          />
        </Row>
        <Row>
          <Select
            label="Origin X"
            options={ORIGIN_X}
            value={pane.origin.x}
            onChange={(value) => edit((target) => (target.origin.x = value))}
          />
          <Select
            label="Origin Y"
            options={ORIGIN_Y}
            value={pane.origin.y}
            onChange={(value) => edit((target) => (target.origin.y = value))}
          />
        </Row>
        <Row>
          <Select
            label="Parent origin X"
            options={ORIGIN_X}
            value={pane.origin.parentX}
            onChange={(value) => edit((target) => (target.origin.parentX = value))}
          />
          <Select
            label="Parent origin Y"
            options={ORIGIN_Y}
            value={pane.origin.parentY}
            onChange={(value) => edit((target) => (target.origin.parentY = value))}
          />
        </Row>
      </Group>

      <KindSpecific pane={pane} edit={edit} />

      <MaterialSection document={tab.document} pane={pane} />

      {pane.userData && pane.userData.entries.length > 0 ? (
        <Group title="User data">
          <dl className="space-y-1">
            {pane.userData.entries.map((entry) => (
              <div key={entry.name} className="flex gap-2">
                <dt className="w-28 shrink-0 truncate text-muted-foreground">{entry.name}</dt>
                <dd className="min-w-0 flex-1 select-text truncate font-mono text-[11px]">
                  {entry.kind === 'string'
                    ? entry.stringValue
                    : entry.kind === 'struct'
                      ? `${entry.structValue?.length ?? 0} bytes`
                      : entry.numberValues.join(', ')}
                </dd>
              </div>
            ))}
          </dl>
        </Group>
      ) : null}
    </div>
  )
}

/**
 * Align and distribute for a multi-pane selection.
 *
 * Distribute needs three panes to mean anything — with two there is no middle to
 * space — so it is disabled rather than hidden, which would make the row jump.
 */
function ArrangeSection({ count }: { count: number }): ReactNode {
  const tab = useActiveTab()
  const runCommand = useDocuments((state) => state.runCommand)

  const run = (how: Arrangement): void => {
    if (!tab) return
    const command = arrangeCommand(tab.document, tab.selectedPaneIds, how)
    if (command) runCommand(command)
  }

  const rows: readonly { title: string; items: readonly Arrangement[] }[] = [
    { title: 'Align', items: ['left', 'centerX', 'right', 'top', 'centerY', 'bottom'] },
    { title: 'Distribute', items: ['distributeX', 'distributeY'] }
  ]

  return (
    <Group title={`Arrange ${count} panes`}>
      {rows.map((row) => (
        <div key={row.title} className="flex items-center gap-1.5">
          <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{row.title}</span>
          <div className="flex flex-wrap gap-1">
            {row.items.map((how) => (
              <button
                key={how}
                type="button"
                onClick={() => run(how)}
                disabled={how.startsWith('distribute') && count < 3}
                title={ARRANGEMENT_LABELS[how]}
                className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-30"
              >
                {ARRANGE_SHORT[how]}
              </button>
            ))}
          </div>
        </div>
      ))}
    </Group>
  )
}

/** Compact labels, since six of them share one row. */
const ARRANGE_SHORT: Record<Arrangement, string> = {
  left: 'L',
  centerX: 'C',
  right: 'R',
  top: 'T',
  centerY: 'M',
  bottom: 'B',
  distributeX: 'Horizontal',
  distributeY: 'Vertical'
}

/** Material indices a pane draws with, in the order the pane uses them. */
function materialIndicesOf(pane: Pane): { label: string; index: number }[] {
  switch (pane.kind) {
    case 'pic1':
      return [{ label: 'Picture', index: (pane as PicturePane).materialIndex }]
    case 'txt1':
      return [{ label: 'Text', index: (pane as TextPane).materialIndex }]
    case 'wnd1': {
      const window = pane as WindowPane
      return [
        { label: 'Content', index: window.content.materialIndex },
        ...window.frames.map((frame, at) => ({
          label: `Frame ${at + 1}`,
          index: frame.materialIndex
        }))
      ]
    }
    default:
      return []
  }
}

const BLEND_OPS = ['Disable', 'Add', 'Subtract', 'ReverseSubtract', 'SelectMin', 'SelectMax']
const BLEND_FACTORS = [
  'Factor0',
  'Factor1',
  'DestColor',
  'DestInvColor',
  'SourceAlpha',
  'SourceInvAlpha',
  'DestAlpha',
  'DestInvAlpha',
  'SourceColor',
  'SourceInvColor'
]
const COMPARE_MODES = [
  'Never',
  'Less',
  'LessOrEqual',
  'Equal',
  'NotEqual',
  'GreaterOrEqual',
  'Greater',
  'Always'
]
const WRAP_MODES = ['Clamp', 'Repeat', 'Mirror']

/**
 * Edits the materials the selected pane draws with.
 *
 * Materials are shared: several panes routinely point at one material, so an
 * edit here changes every pane that uses it. That is why the header states how
 * many panes are affected rather than presenting this as pane-local.
 *
 * Editing sets the material's `dirty` flag, which is what makes the writer
 * rebuild its flags word from the arrays instead of replaying the original.
 */
function MaterialSection({
  document,
  pane
}: {
  document: LayoutDocument
  pane: Pane
}): ReactNode {
  const runCommand = useDocuments((state) => state.runCommand)
  const slots = materialIndicesOf(pane)
  const [slot, setSlot] = useState(0)

  const active = slots.length > 0 ? slots[Math.min(slot, slots.length - 1)] : undefined
  const material = active ? document.materials[active.index] : undefined

  /*
   * Every hook runs before the early returns below.
   *
   * This memo used to sit lower down, after `if (slots.length === 0) return null`.
   * Selecting a pic1 (which has a material) and then a pan1 (which has none)
   * rendered a different number of hooks on the same fiber, which React treats as a
   * fatal invariant violation — a two-click crash of the whole panel.
   *
   * The dependency is `active?.index`, not `active`: `materialIndicesOf` builds a
   * fresh array of fresh objects on every render, so keying on the object meant the
   * memo never hit and the tree walk ran every time anyway.
   */
  const activeIndex = active?.index
  const users = useMemo(
    () => (activeIndex === undefined ? 0 : countMaterialUsers(document, activeIndex)),
    [document, activeIndex]
  )

  if (slots.length === 0) return null

  if (!material) {
    return (
      <Group title="Material">
        <Hint>
          This pane points at material {active?.index ?? '?'}, which the layout does not have.
        </Hint>
      </Group>
    )
  }

  const edit = (apply: () => void): void => {
    const before = structuredClone({ ...material })
    apply()
    const after = structuredClone({ ...material })
    runCommand(
      setMaterialSnapshot(active!.index, `Edit ${material.name || 'material'}`, before, after)
    )
  }

  return (
    <Group title={`Material · ${material.name || '(unnamed)'}`}>
      {slots.length > 1 ? (
        <Field label="Slot">
          <Select
            value={slot}
            options={slots.map((entry, at) => ({
              value: at,
              label: `${entry.label} — ${document.materials[entry.index]?.name ?? entry.index}`
            }))}
            onChange={setSlot}
          />
        </Field>
      ) : null}

      {users > 1 ? (
        <p className="text-[11px] text-amber-500">
          Shared by {users} panes — edits affect all of them.
        </p>
      ) : null}

      <Field label="Name">
        <TextField
          value={material.name}
          maxLength={28}
          onChange={(next) => edit(() => (material.name = next))}
        />
      </Field>

      <Row>
        <ColorField
          label="Black"
          color={material.blackColor}
          onChange={(value) => edit(() => (material.blackColor = value))}
        />
        <ColorField
          label="White"
          color={material.whiteColor}
          onChange={(value) => edit(() => (material.whiteColor = value))}
        />
      </Row>

      <Field label="Textures">
        {material.textureMaps.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60">No texture maps.</p>
        ) : (
          <div className="space-y-1">
            {material.textureMaps.map((map, at) => (
              <div key={at} className="space-y-1 rounded border p-1.5">
                <Select
                  value={map.textureIndex}
                  options={[
                    { value: -1, label: '(none)' },
                    ...document.textures.map((name, index) => ({ value: index, label: name }))
                  ]}
                  onChange={(value) => edit(() => (map.textureIndex = value))}
                />
                <Row>
                  <Select
                    label="Wrap U"
                    value={map.flag1 & 0x3}
                    options={WRAP_MODES.map((label, value) => ({ value, label }))}
                    onChange={(value) =>
                      edit(() => (map.flag1 = (map.flag1 & ~0x3) | (value & 0x3)))
                    }
                  />
                  <Select
                    label="Wrap V"
                    value={map.flag2 & 0x3}
                    options={WRAP_MODES.map((label, value) => ({ value, label }))}
                    onChange={(value) =>
                      edit(() => (map.flag2 = (map.flag2 & ~0x3) | (value & 0x3)))
                    }
                  />
                </Row>
              </div>
            ))}
          </div>
        )}
      </Field>

      {material.textureTransforms.map((transform, at) => (
        <Field key={at} label={`Texture SRT ${at + 1}`}>
          <Row>
            <NumberField
              label="U"
              value={transform.translate[0]}
              onChange={(value) => edit(() => (transform.translate[0] = value))}
            />
            <NumberField
              label="V"
              value={transform.translate[1]}
              onChange={(value) => edit(() => (transform.translate[1] = value))}
            />
          </Row>
          <Row>
            <NumberField
              label="Rotate"
              value={transform.rotate}
              onChange={(value) => edit(() => (transform.rotate = value))}
            />
            <NumberField
              label="Scale U"
              value={transform.scale[0]}
              step={0.1}
              onChange={(value) => edit(() => (transform.scale[0] = value))}
            />
            <NumberField
              label="Scale V"
              value={transform.scale[1]}
              step={0.1}
              onChange={(value) => edit(() => (transform.scale[1] = value))}
            />
          </Row>
        </Field>
      ))}

      {material.blendMode ? (
        <Field label="Blend">
          <Row>
            <Select
              label="Op"
              value={material.blendMode.blendOp}
              options={BLEND_OPS.map((label, value) => ({ value, label }))}
              onChange={(value) => edit(() => (material.blendMode!.blendOp = value))}
            />
          </Row>
          <Row>
            <Select
              label="Source"
              value={material.blendMode.sourceFactor}
              options={BLEND_FACTORS.map((label, value) => ({ value, label }))}
              onChange={(value) => edit(() => (material.blendMode!.sourceFactor = value))}
            />
            <Select
              label="Dest"
              value={material.blendMode.destFactor}
              options={BLEND_FACTORS.map((label, value) => ({ value, label }))}
              onChange={(value) => edit(() => (material.blendMode!.destFactor = value))}
            />
          </Row>
        </Field>
      ) : null}

      {material.alphaCompare ? (
        <Field label="Alpha compare">
          <Row>
            <Select
              label="Mode"
              value={material.alphaCompare.compareMode}
              options={COMPARE_MODES.map((label, value) => ({ value, label }))}
              onChange={(value) => edit(() => (material.alphaCompare!.compareMode = value))}
            />
            <NumberField
              label="Value"
              value={material.alphaCompare.value}
              step={0.05}
              onChange={(value) => edit(() => (material.alphaCompare!.value = value))}
            />
          </Row>
        </Field>
      ) : null}

      <Row>
        <Toggle
          label="Texture only"
          checked={material.useTextureOnly}
          onChange={(value) => edit(() => (material.useTextureOnly = value))}
        />
        <Toggle
          label="Alpha interpolation"
          checked={material.alphaInterpolation}
          onChange={(value) => edit(() => (material.alphaInterpolation = value))}
        />
      </Row>

      <p className="text-[11px] text-muted-foreground/60">
        {material.tevStages.length} TEV stage{material.tevStages.length === 1 ? '' : 's'} ·
        {material.dirty ? ' will be re-encoded on save' : ' original bytes preserved'}
      </p>
    </Group>
  )
}

function countMaterialUsers(document: LayoutDocument, index: number): number {
  let count = 0
  walkPanes(document.rootPane, (pane) => {
    for (const slot of materialIndicesOf(pane)) {
      if (slot.index === index) {
        count++
        return
      }
    }
  })
  return count
}

function ColorField({
  label,
  color,
  onChange
}: {
  label: string
  color: Rgba
  onChange: (value: Rgba) => void
}): ReactNode {
  const hex = `#${[color[0], color[1], color[2]]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`

  return (
    <label className="min-w-0 flex-1 space-y-0.5">
      <span className="block truncate text-[11px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={hex}
          onChange={(event) => {
            const value = event.target.value
            onChange([
              Number.parseInt(value.slice(1, 3), 16),
              Number.parseInt(value.slice(3, 5), 16),
              Number.parseInt(value.slice(5, 7), 16),
              color[3]
            ])
          }}
          className="size-6 shrink-0 rounded border bg-transparent"
        />
        <input
          type="number"
          min={0}
          max={255}
          value={color[3]}
          title="Alpha"
          onChange={(event) =>
            onChange([
              color[0],
              color[1],
              color[2],
              Math.max(0, Math.min(255, Number(event.target.value) || 0))
            ])
          }
          className="min-w-0 flex-1 rounded border bg-input/40 px-1 py-0.5 text-right font-mono"
        />
      </div>
    </label>
  )
}

/**
 * The fields that only exist on one pane kind.
 *
 * `edit` is passed `kindOnly` for every one of these: a `pic1`'s vertex colours mean nothing
 * on a `pan1`, and writing them there would build a document the writer cannot encode. So a
 * mixed selection edits only the panes that share the active pane's kind, while the common
 * fields above it fan out across everything selected.
 */
function KindSpecific({
  pane,
  edit
}: {
  pane: Pane
  edit: (
    apply: (target: Pane) => unknown,
    options?: { activeOnly?: boolean; kindOnly?: boolean }
  ) => void
}): ReactNode {
  /** Every kind-specific write goes through this, so the scoping cannot be forgotten. */
  const editKind = (apply: (target: Pane) => unknown): void => edit(apply, { kindOnly: true })
  switch (pane.kind) {
    case 'pic1': {
      const picture = pane as PicturePane
      return (
        <Group title="Picture">
          <Row>
            <NumberField
              label="Material"
              value={picture.materialIndex}
              step={1}
              onChange={(value) => editKind((target) => ((target as PicturePane).materialIndex = Math.max(0, value | 0)))}
            />
          </Row>
          <Field label="Vertex colours">
            <div className="grid grid-cols-2 gap-1">
              {(
                [
                  ['Top left', 'colorTopLeft'],
                  ['Top right', 'colorTopRight'],
                  ['Bottom left', 'colorBottomLeft'],
                  ['Bottom right', 'colorBottomRight']
                ] as const
              ).map(([label, key]) => (
                <ColorField
                  key={key}
                  label={label}
                  color={picture[key]}
                  onChange={(value) => edit(() => (picture[key] = value))}
                />
              ))}
            </div>
          </Field>
          <p className="text-[11px] text-muted-foreground/60">
            {picture.texCoords.length} UV set{picture.texCoords.length === 1 ? '' : 's'}
          </p>
        </Group>
      )
    }

    case 'txt1': {
      const text = pane as TextPane
      return (
        <Group title="Text">
          <Field label="Content">
            {/*
              Committed on blur rather than per keystroke, like the name fields: a
              caption is re-rasterised and re-uploaded to the GPU on every change, and
              each one was its own undo entry.
            */}
            <TextArea value={text.text} onChange={(next) => editKind((target) => ((target as TextPane).text = next))} />
          </Field>
          <Row>
            <NumberField
              label="Material"
              value={text.materialIndex}
              step={1}
              onChange={(value) => editKind((target) => ((target as TextPane).materialIndex = Math.max(0, value | 0)))}
            />
            <NumberField
              label="Font"
              value={text.fontIndex}
              step={1}
              onChange={(value) => editKind((target) => ((target as TextPane).fontIndex = Math.max(0, value | 0)))}
            />
          </Row>
          <Row>
            <NumberField
              label="Size X"
              value={text.fontSize[0]}
              onChange={(value) => editKind((target) => ((target as TextPane).fontSize[0] = value))}
            />
            <NumberField
              label="Size Y"
              value={text.fontSize[1]}
              onChange={(value) => editKind((target) => ((target as TextPane).fontSize[1] = value))}
            />
          </Row>
          <Row>
            <NumberField
              label="Char space"
              value={text.charSpace}
              onChange={(value) => editKind((target) => ((target as TextPane).charSpace = value))}
            />
            <NumberField
              label="Line space"
              value={text.lineSpace}
              onChange={(value) => editKind((target) => ((target as TextPane).lineSpace = value))}
            />
          </Row>
          {/*
            Everything below was already read by the rasteriser and had no way to be set,
            so a label could be positioned but not centred, and not coloured at all.
          */}
          <Row>
            <Select
              label="Align H"
              options={TEXT_H_ALIGN}
              value={text.textAlignment & 0x3}
              onChange={(value) =>
                editKind((target) => {
                  const box = target as TextPane
                  // Masked, so the vertical bits and anything above them survive.
                  box.textAlignment = (box.textAlignment & ~0x3) | (value & 0x3)
                })
              }
            />
            <Select
              label="Align V"
              options={TEXT_V_ALIGN}
              value={(text.textAlignment >> 2) & 0x3}
              onChange={(value) =>
                editKind((target) => {
                  const box = target as TextPane
                  box.textAlignment = (box.textAlignment & ~0xc) | ((value & 0x3) << 2)
                })
              }
            />
          </Row>
          <Field label="Font colour">
            <Row>
              <ColorField
                label="Top"
                color={text.fontTopColor}
                onChange={(value) =>
                  editKind((target) => ((target as TextPane).fontTopColor = value))
                }
              />
              <ColorField
                label="Bottom"
                color={text.fontBottomColor}
                onChange={(value) =>
                  editKind((target) => ((target as TextPane).fontBottomColor = value))
                }
              />
            </Row>
          </Field>
          <Row>
            <NumberField
              label="Italic"
              value={text.italicTilt}
              step={0.05}
              onChange={(value) => editKind((target) => ((target as TextPane).italicTilt = value))}
            />
          </Row>
          <Row>
            <Toggle
              label="Shadow"
              checked={(text.flags & TEXT_FLAG_SHADOW) !== 0}
              onChange={(on) =>
                editKind((target) => {
                  const box = target as TextPane
                  box.flags = withBit(box.flags, TEXT_FLAG_SHADOW, on)
                })
              }
            />
            <Toggle
              label="Fixed length"
              checked={(text.flags & TEXT_FLAG_RESTRICTED) !== 0}
              onChange={(on) =>
                editKind((target) => {
                  const box = target as TextPane
                  box.flags = withBit(box.flags, TEXT_FLAG_RESTRICTED, on)
                })
              }
            />
          </Row>
          {(text.flags & TEXT_FLAG_SHADOW) !== 0 ? (
            <>
              <Row>
                <NumberField
                  label="Shadow X"
                  value={text.shadowPosition[0]}
                  onChange={(value) =>
                    editKind((target) => ((target as TextPane).shadowPosition[0] = value))
                  }
                />
                <NumberField
                  label="Shadow Y"
                  value={text.shadowPosition[1]}
                  onChange={(value) =>
                    editKind((target) => ((target as TextPane).shadowPosition[1] = value))
                  }
                />
              </Row>
              <Field label="Shadow colour">
                <Row>
                  <ColorField
                    label="Front"
                    color={text.shadowForeColor}
                    onChange={(value) =>
                      editKind((target) => ((target as TextPane).shadowForeColor = value))
                    }
                  />
                  <ColorField
                    label="Back"
                    color={text.shadowBackColor}
                    onChange={(value) =>
                      editKind((target) => ((target as TextPane).shadowBackColor = value))
                    }
                  />
                </Row>
              </Field>
            </>
          ) : null}
          {(text.flags & TEXT_FLAG_PER_CHARACTER) !== 0 ? (
            <p className="text-[11px] text-muted-foreground/60">
              This pane uses a per-character transform, which the canvas does not model — the
              block is preserved on save but the preview ignores it.
            </p>
          ) : null}
        </Group>
      )
    }

    case 'wnd1': {
      const window = pane as WindowPane
      return (
        <Group title="Window">
          <Row>
            <NumberField
              label="Stretch L"
              value={window.stretchLeft}
              step={1}
              onChange={(value) => editKind((target) => ((target as WindowPane).stretchLeft = value | 0))}
            />
            <NumberField
              label="Stretch R"
              value={window.stretchRight}
              step={1}
              onChange={(value) => editKind((target) => ((target as WindowPane).stretchRight = value | 0))}
            />
          </Row>
          <Row>
            <NumberField
              label="Stretch T"
              value={window.stretchTop}
              step={1}
              onChange={(value) => editKind((target) => ((target as WindowPane).stretchTop = value | 0))}
            />
            <NumberField
              label="Stretch B"
              value={window.stretchBottom}
              step={1}
              onChange={(value) => editKind((target) => ((target as WindowPane).stretchBottom = value | 0))}
            />
          </Row>
          <p className="text-[11px] text-muted-foreground/60">
            {window.frames.length} frame{window.frames.length === 1 ? '' : 's'} · content material{' '}
            {window.content.materialIndex}
          </p>
        </Group>
      )
    }

    case 'prt1':
      return (
        <Group title="Part">
          <Field label="External layout">
            <p className="select-text truncate font-mono text-[11px]">
              {pane.externalLayoutName || '(none)'}
            </p>
          </Field>
          <p className="text-[11px] text-muted-foreground/60">
            {pane.properties.length} propert{pane.properties.length === 1 ? 'y' : 'ies'}
          </p>
        </Group>
      )

    default:
      return null
  }
}

// ---------------------------------------------------------------- primitives

function Hint({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground/60">
      {children}
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="border-b p-2">
      <h3 className="mb-2 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function Row({ children }: { children: ReactNode }): ReactNode {
  return <div className="flex gap-1.5">{children}</div>
}

/**
 * Discards a pending draft when the model value moves underneath it.
 *
 * These fields hold uncommitted text until blur, and they live at a stable position in
 * the tree — so selecting a different pane re-renders the same component with a new
 * `value` and a new `onChange` while the draft is still showing. Blurring then committed
 * the text typed for the *previous* pane onto the new one, losing one edit and inventing
 * another. Undo has the same shape: the model changes without the field being touched.
 *
 * Adjusting state during render is the pattern React prescribes for this, and avoids the
 * extra commit an effect would cost.
 */
function useDraftReset(
  value: string,
  draft: string | null,
  setDraft: (draft: string | null) => void
): void {
  const seen = useRef(value)
  if (seen.current !== value) {
    seen.current = value
    if (draft !== null) setDraft(null)
  }
}

/**
 * A text input that commits on blur or Enter, and abandons on Escape.
 *
 * Committing per keystroke pushed one undo entry per character: renaming a pane cost
 * twenty presses of Cmd+Z and evicted twenty real entries from the 200-deep stack.
 * It also meant every intermediate string was written to the document, so a rename
 * passed through prefixes that were not names anyone chose.
 */
function TextField({
  value,
  maxLength,
  onChange,
  validate
}: {
  value: string
  maxLength: number
  onChange: (value: string) => void
  /** Returns why the value is unacceptable, or null when it is fine. */
  validate?: (value: string) => string | null
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null)
  // See NumberField: blur fires synchronously from blur(), before React flushes.
  const cancelling = useRef(false)
  useDraftReset(value, draft, setDraft)

  /**
   * Why the pending draft cannot be committed, or null.
   *
   * Kept visible while the draft stands rather than reverting silently, so a rejected
   * rename says what is wrong instead of appearing to do nothing.
   */
  const problem = draft === null ? null : (validate?.(draft.slice(0, maxLength)) ?? null)

  const commit = (text: string): void => {
    if (cancelling.current) {
      cancelling.current = false
      setDraft(null)
      return
    }
    const trimmed = text.slice(0, maxLength)
    // A rejected value stays in the field so it can be corrected.
    if (validate?.(trimmed)) return
    setDraft(null)
    if (trimmed !== value) onChange(trimmed)
  }

  return (
    <>
      <input
        value={draft ?? value}
        maxLength={maxLength}
        aria-invalid={problem !== null}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit(event.currentTarget.value)
            if (!validate?.(event.currentTarget.value.slice(0, maxLength))) {
              event.currentTarget.blur()
            }
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            cancelling.current = true
            setDraft(null)
            event.currentTarget.blur()
          }
        }}
        className={`w-full rounded border bg-input/40 px-1.5 py-0.5 ${
          problem ? 'border-destructive' : ''
        }`}
      />
      {problem ? <p className="mt-0.5 text-[10px] text-destructive">{problem}</p> : null}
    </>
  )
}

/** The multi-line sibling of TextField, for a text pane's content. */
function TextArea({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null)
  const cancelling = useRef(false)
  useDraftReset(value, draft, setDraft)

  const commit = (text: string): void => {
    setDraft(null)
    if (cancelling.current) {
      cancelling.current = false
      return
    }
    if (text !== value) onChange(text)
  }

  return (
    <textarea
      value={draft ?? value}
      rows={3}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
      onKeyDown={(event) => {
        // Enter inserts a newline here, so only Escape is special.
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelling.current = true
          setDraft(null)
          event.currentTarget.blur()
        }
      }}
      className="w-full resize-y rounded border bg-input/40 px-1.5 py-0.5 font-mono"
    />
  )
}

function NumberField({
  label,
  value,
  step = 1,
  mixed = false,
  onChange
}: {
  label: string
  value: number
  step?: number
  /**
   * The selected panes disagree on this value.
   *
   * The field still shows the active pane's number — blanking it would lose the one piece
   * of information there is — but says so, because a field silently showing one pane's
   * value while eleven others hold something else invites an overwrite nobody intended.
   */
  mixed?: boolean
  onChange: (value: number) => void
}): ReactNode {
  /**
   * The text being typed, or null when the field is showing the model's value.
   *
   * Committing on every keystroke made these fields fight the user: typing "100"
   * into Width applied 1, then 10, then 100 — three undo entries and two frames at
   * the wrong size — clearing the field sent `Number('') === 0` and collapsed the
   * pane, and a leading "-" parsed as NaN so negatives could not be typed at all.
   * The value is committed on blur and on Enter instead.
   */
  const [draft, setDraft] = useState<string | null>(null)
  useDraftReset(String(value), draft, setDraft)

  /**
   * Set while Escape is abandoning an edit, so the blur it triggers does not commit.
   *
   * `blur()` dispatches focusout synchronously, before React flushes the
   * `setDraft(null)` — so the blur handler still saw the draft text in the DOM and
   * committed exactly the value Escape was meant to discard.
   */
  const cancelling = useRef(false)

  const commit = (text: string): void => {
    setDraft(null)
    if (cancelling.current) {
      cancelling.current = false
      return
    }
    // An empty or unparseable field reverts rather than writing a zero.
    const parsed = Number(text)
    if (text.trim() !== '' && Number.isFinite(parsed) && parsed !== value) onChange(parsed)
  }

  return (
    <label className="min-w-0 flex-1">
      <span className="mb-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
        <span className="truncate">{label}</span>
        {/* A dot rather than a word, so it fits beside a three-character label. */}
        {mixed ? (
          <span
            title="The selected panes have different values here; editing sets them all"
            className="text-amber-500"
          >
            •
          </span>
        ) : null}
      </span>
      <input
        type="number"
        value={draft ?? (Number.isFinite(value) ? value : 0)}
        step={step}
        title={mixed ? 'The selected panes differ; editing sets them all' : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit(event.currentTarget.value)
            return
          }
          // Escape abandons the edit and puts the model's value back.
          if (event.key === 'Escape') {
            event.preventDefault()
            cancelling.current = true
            setDraft(null)
            event.currentTarget.blur()
          }
        }}
        className="w-full rounded border bg-input/40 px-1.5 py-0.5 tabular-nums"
      />
    </label>
  )
}

interface SelectOption {
  readonly value: number
  readonly label: string
}

/**
 * A numeric dropdown. Plain string arrays are accepted for the common case where
 * the value *is* the index into a list of names, which most layout enums are.
 */
function Select({
  label,
  options,
  value,
  onChange
}: {
  label?: string
  options: readonly string[] | readonly SelectOption[]
  value: number
  onChange: (value: number) => void
}): ReactNode {
  const resolved: readonly SelectOption[] = options.map((option, index) =>
    typeof option === 'string' ? { value: index, label: option } : option
  )

  // A value outside the option list must still be visible rather than silently
  // snapping to the first entry, which would hide malformed data.
  const known = resolved.some((option) => option.value === value)
  const shown = known ? resolved : [...resolved, { value, label: `${value} (unknown)` }]

  return (
    <label className="min-w-0 flex-1">
      {label ? (
        <span className="mb-0.5 block truncate text-[11px] text-muted-foreground">{label}</span>
      ) : null}
      <select
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded border bg-input/40 px-1 py-0.5"
      >
        {shown.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function Toggle({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}): ReactNode {
  return (
    <label className="flex flex-1 items-center gap-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="truncate text-[11px] text-muted-foreground">{label}</span>
    </label>
  )
}
