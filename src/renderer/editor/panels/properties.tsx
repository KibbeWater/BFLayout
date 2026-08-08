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
  setMaterialSnapshot,
  setPaneSnapshot,
  snapshotPane
} from '@renderer/editor/commands'

const ORIGIN_X = ['Left', 'Center', 'Right']
const ORIGIN_Y = ['Top', 'Center', 'Bottom']

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

  /**
   * Applies a property edit and records it so Cmd+Z reverses it.
   *
   * These edits used to go straight through `mutate`, which left every field in
   * this panel outside undo — and worse, made the history lie: after typing in a
   * width field, Cmd+Z would revert the previous canvas drag while the toolbar
   * still described the drag as the thing about to be undone.
   *
   * The whole pane is snapshotted rather than the specific fields touched, because
   * `apply` is an opaque closure and every pane kind has different fields. Panes
   * are small once children are excluded.
   */
  const edit = (apply: () => void): void => {
    const before = snapshotPane(pane)
    apply()
    const after = snapshotPane(pane)
    runCommand(setPaneSnapshot(pane.id, `Edit ${pane.name || pane.kind}`, before, after))
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Group title={`${pane.kind} · ${pane.name || '(unnamed)'}`}>
        <Field label="Name">
          <input
            value={pane.name}
            onChange={(event) => edit(() => (pane.name = event.target.value.slice(0, 24)))}
            className="w-full rounded border bg-input/40 px-1.5 py-0.5"
          />
        </Field>
        <Row>
          <Toggle
            label="Visible"
            checked={pane.visible}
            onChange={(value) => edit(() => (pane.visible = value))}
          />
          <Toggle
            label="Influence alpha"
            checked={pane.influenceAlpha}
            onChange={(value) => edit(() => (pane.influenceAlpha = value))}
          />
        </Row>
        <Field label="Alpha">
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={255}
              value={pane.alpha}
              onChange={(event) => edit(() => (pane.alpha = Number(event.target.value)))}
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
            onChange={(value) => edit(() => (pane.translate[0] = value))}
          />
          <NumberField
            label="Y"
            value={pane.translate[1]}
            onChange={(value) => edit(() => (pane.translate[1] = value))}
          />
          <NumberField
            label="Z"
            value={pane.translate[2]}
            onChange={(value) => edit(() => (pane.translate[2] = value))}
          />
        </Row>
        <Row>
          <NumberField
            label="Width"
            value={pane.width}
            onChange={(value) => edit(() => (pane.width = value))}
          />
          <NumberField
            label="Height"
            value={pane.height}
            onChange={(value) => edit(() => (pane.height = value))}
          />
        </Row>
        <Row>
          <NumberField
            label="Rot Z"
            value={pane.rotate[2]}
            onChange={(value) => edit(() => (pane.rotate[2] = value))}
          />
          <NumberField
            label="Scale X"
            value={pane.scale[0]}
            step={0.01}
            onChange={(value) => edit(() => (pane.scale[0] = value))}
          />
          <NumberField
            label="Scale Y"
            value={pane.scale[1]}
            step={0.01}
            onChange={(value) => edit(() => (pane.scale[1] = value))}
          />
        </Row>
        <Row>
          <Select
            label="Origin X"
            options={ORIGIN_X}
            value={pane.origin.x}
            onChange={(value) => edit(() => (pane.origin.x = value))}
          />
          <Select
            label="Origin Y"
            options={ORIGIN_Y}
            value={pane.origin.y}
            onChange={(value) => edit(() => (pane.origin.y = value))}
          />
        </Row>
        <Row>
          <Select
            label="Parent origin X"
            options={ORIGIN_X}
            value={pane.origin.parentX}
            onChange={(value) => edit(() => (pane.origin.parentX = value))}
          />
          <Select
            label="Parent origin Y"
            options={ORIGIN_Y}
            value={pane.origin.parentY}
            onChange={(value) => edit(() => (pane.origin.parentY = value))}
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
        <input
          value={material.name}
          onChange={(event) => edit(() => (material.name = event.target.value.slice(0, 28)))}
          className="w-full rounded border bg-input/40 px-1.5 py-0.5"
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

function KindSpecific({
  pane,
  edit
}: {
  pane: Pane
  edit: (apply: () => void) => void
}): ReactNode {
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
              onChange={(value) => edit(() => (picture.materialIndex = Math.max(0, value | 0)))}
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
            <textarea
              value={text.text}
              rows={3}
              onChange={(event) => edit(() => (text.text = event.target.value))}
              className="w-full resize-y rounded border bg-input/40 px-1.5 py-0.5 font-mono"
            />
          </Field>
          <Row>
            <NumberField
              label="Material"
              value={text.materialIndex}
              step={1}
              onChange={(value) => edit(() => (text.materialIndex = Math.max(0, value | 0)))}
            />
            <NumberField
              label="Font"
              value={text.fontIndex}
              step={1}
              onChange={(value) => edit(() => (text.fontIndex = Math.max(0, value | 0)))}
            />
          </Row>
          <Row>
            <NumberField
              label="Size X"
              value={text.fontSize[0]}
              onChange={(value) => edit(() => (text.fontSize[0] = value))}
            />
            <NumberField
              label="Size Y"
              value={text.fontSize[1]}
              onChange={(value) => edit(() => (text.fontSize[1] = value))}
            />
          </Row>
          <Row>
            <NumberField
              label="Char space"
              value={text.charSpace}
              onChange={(value) => edit(() => (text.charSpace = value))}
            />
            <NumberField
              label="Line space"
              value={text.lineSpace}
              onChange={(value) => edit(() => (text.lineSpace = value))}
            />
          </Row>
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
              onChange={(value) => edit(() => (window.stretchLeft = value | 0))}
            />
            <NumberField
              label="Stretch R"
              value={window.stretchRight}
              step={1}
              onChange={(value) => edit(() => (window.stretchRight = value | 0))}
            />
          </Row>
          <Row>
            <NumberField
              label="Stretch T"
              value={window.stretchTop}
              step={1}
              onChange={(value) => edit(() => (window.stretchTop = value | 0))}
            />
            <NumberField
              label="Stretch B"
              value={window.stretchBottom}
              step={1}
              onChange={(value) => edit(() => (window.stretchBottom = value | 0))}
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

function NumberField({
  label,
  value,
  step = 1,
  onChange
}: {
  label: string
  value: number
  step?: number
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
      <span className="mb-0.5 block truncate text-[11px] text-muted-foreground">{label}</span>
      <input
        type="number"
        value={draft ?? (Number.isFinite(value) ? value : 0)}
        step={step}
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
