import { create } from 'zustand'

import { describeError } from './errors'

export interface Toast {
  readonly id: number
  readonly kind: 'error' | 'info' | 'success'
  readonly title: string
  readonly detail?: string
  /** Invoked by the toast's retry button. */
  readonly retry?: () => void
}

interface ToastStore {
  readonly toasts: readonly Toast[]
  push: (toast: Omit<Toast, 'id'>) => number
  dismiss: (id: number) => void
  clear: () => void
}

let nextId = 1

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    if (toast.kind !== 'error') {
      // Errors stay until dismissed; nothing important should vanish on its own.
      setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000)
    }
    return id
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] })
}))

/** Surfaces any failure as a toast. The single funnel for unexpected errors. */
export function reportError(error: unknown, options?: { retry?: () => void }): void {
  const described = describeError(error)
  console.error('[bflayout]', error)
  useToasts.getState().push({
    kind: 'error',
    title: described.title,
    detail: described.detail,
    ...(described.retryable && options?.retry ? { retry: options.retry } : {})
  })
}

export function reportSuccess(title: string, detail?: string): void {
  useToasts.getState().push({ kind: 'success', title, ...(detail ? { detail } : {}) })
}

export function reportInfo(title: string, detail?: string): void {
  useToasts.getState().push({ kind: 'info', title, ...(detail ? { detail } : {}) })
}
