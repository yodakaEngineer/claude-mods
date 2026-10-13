export type PrCheckStatus = 'pending' | 'success' | 'failure' | 'skipped' | 'cancelled'

export type PrCheck = { name: string; status: PrCheckStatus }

export type PrInfo = {
  url: string
  repo: string
  number: number
  title: string
  branch: string
  state: string
  isDraft: boolean
  reviewDecision: string
  mergeable: string
  checks: PrCheck[]
}

export type TrackedPr = {
  url: string
  info: PrInfo | null
  error: string | null
  updatedAt: number
  mergedAt: number | null
}

export type PaneState = {
  prs: TrackedPr[]
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'pr-status-pane': { pane: PaneState | null; isPaused: boolean }
  }
}
