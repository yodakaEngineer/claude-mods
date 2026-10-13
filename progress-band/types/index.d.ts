export type SeenLink = { url: string; host: string }

export type ProgressSummary = {
  plan: string
  done: string
  doing: string
  next: string
  progress: number
  asks: string[]
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'progress-band': {
      summary: ProgressSummary | null
      cursor: number
      startedAt: number | null
      isHidden: boolean
      isBusy: boolean
      tick: number
      frame: number
      links: SeenLink[]
    }
  }
}
