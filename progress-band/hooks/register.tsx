import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { ProgressSummary, SeenLink } from '../types'

const MODEL = 'haiku'
const PANE = 'progress'
const PANE_TITLE = 'Progress'
const TICK_MS = 60_000
const FRAME_MS = 500
const DOTS = ['.', '..', '...'] as const
const WANT_POLL_MS = 3_000
const MID_TURN_EVERY_CALLS = 12
const MID_TURN_MIN_GAP_MS = 120_000
const MAX_NEW_MESSAGES = 40
const MAX_DIGEST_CHARS = 10_000
const MAX_TEXT_CHARS = 500
const MAX_RESULT_CHARS = 160
const MAX_INPUT_CHARS = 120
const MAX_LINKS_SHOWN = 20
const URL_RE = /https?:\/\/[^\s<>()\[\]"'`]+/g

type LabelColor = 'planMode' | 'success' | 'claude' | 'suggestion' | 'warning'

const summary = atom({ plugin: 'progress-band', key: 'summary' } as const, null)
const cursor = atom({ plugin: 'progress-band', key: 'cursor' } as const, 0)
const startedAt = atom({ plugin: 'progress-band', key: 'startedAt' } as const, null)
const isHidden = atom({ plugin: 'progress-band', key: 'isHidden' } as const, false)
const isBusy = atom({ plugin: 'progress-band', key: 'isBusy' } as const, false)
const tick = atom({ plugin: 'progress-band', key: 'tick' } as const, 0)
const frame = atom({ plugin: 'progress-band', key: 'frame' } as const, 0)
const links = atom({ plugin: 'progress-band', key: 'links' } as const, [])

const SYSTEM = `あなたはコーディングセッションの進捗を追跡する係です。
前回のサマリ（JSON）と、その後に増えたやり取りの抜粋を渡します。
前回のサマリを土台に、新しいやり取りで変わった点だけ反映して更新してください。
変化がない項目は前回の文をそのまま使ってください。

出力は次のJSONのみ。説明文やコードフェンスは不要。各文は簡潔に（各40字以内、asks の各要素も40字以内）。文の言語は、ユーザーメッセージ末尾の「出力言語」指示に従うこと。
{
  "plan": "ユーザーの依頼と全体の計画を1文で",
  "done": "ここまでに完了したこと",
  "doing": "いま取り組んでいること",
  "next": "このあとやること",
  "progress": 0から100の整数（全体に対する完了率の見積もり）,
  "asks": ["ユーザーに判断・確認してほしいこと。なければ空配列"]
}`

/** Every http(s) url in the person's and Claude's own text, in order of first appearance. */
function linksIn(messages: readonly SessionMessage[]): SeenLink[] {
  const seen = new Map<string, SeenLink>()
  for (const message of messages) {
    for (const raw of message.text.match(URL_RE) ?? []) {
      const url = raw.replace(/[.,;:!?]+$/, '')
      if (seen.has(url)) continue
      let host = ''
      try {
        host = new URL(url).host
      } catch {
        continue
      }
      seen.set(url, { url, host })
    }
  }
  return [...seen.values()]
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function describeInput(tool: string, input: Record<string, unknown>): string {
  const pick = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (tool) {
    case 'Bash':
      return cut(pick('command'), MAX_INPUT_CHARS)
    case 'Edit':
    case 'Write':
    case 'Read':
      return cut(pick('file_path'), MAX_INPUT_CHARS)
    case 'Agent':
      return cut(pick('description'), MAX_INPUT_CHARS)
    default:
      return cut(JSON.stringify(input), MAX_INPUT_CHARS)
  }
}

function digestOne(message: SessionMessage): string {
  const lines: string[] = []
  if (message.role === 'user') {
    if (message.text.trim() !== '') lines.push(`[user] ${cut(message.text, MAX_TEXT_CHARS)}`)
    for (const result of message.toolResults ?? []) {
      if (result.isError === true) lines.push(`[tool error] ${cut(result.text ?? '', MAX_RESULT_CHARS)}`)
    }
    return lines.join('\n')
  }
  if (message.text.trim() !== '') lines.push(`[assistant] ${cut(message.text, MAX_TEXT_CHARS)}`)
  for (const use of message.toolUses) {
    const outcome = use.isError === true ? ' → error' : ''
    lines.push(`[tool ${use.tool}] ${describeInput(use.tool, use.input)}${outcome}`)
  }
  return lines.join('\n')
}

function digest(messages: readonly SessionMessage[], from: number): string {
  const fresh = messages.slice(from)
  const first = from === 0 ? fresh[0] : undefined
  const window = fresh.length > MAX_NEW_MESSAGES ? fresh.slice(-MAX_NEW_MESSAGES) : fresh
  const parts: string[] = []
  if (first !== undefined && !window.includes(first)) {
    parts.push(digestOne(first), `（…${fresh.length - window.length - 1} 件省略…）`)
  }
  for (const message of window) {
    const line = digestOne(message)
    if (line !== '') parts.push(line)
  }
  let text = parts.join('\n')
  if (text.length > MAX_DIGEST_CHARS) text = `…${text.slice(-MAX_DIGEST_CHARS)}`
  return text
}

function parseSummary(text: string, updatedAt: number): ProgressSummary | null {
  const body = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const str = (key: string) => (typeof o[key] === 'string' ? (o[key] as string) : '')
  const progressRaw = typeof o.progress === 'number' ? o.progress : Number(o.progress)
  const progress = Number.isFinite(progressRaw) ? Math.max(0, Math.min(100, Math.round(progressRaw))) : 0
  const asks = Array.isArray(o.asks) ? o.asks.filter((a): a is string => typeof a === 'string' && a.trim() !== '') : []
  return { plan: str('plan'), done: str('done'), doing: str('doing'), next: str('next'), progress, asks, updatedAt }
}

let isRefreshing = false
let languageOnce: 'en' | 'ja' | null = null
let isTurnRunning = false
let isWanted = false
let lastRefreshAt = 0
let callsSinceRefresh = 0

const kick = () => {
  isWanted = true
}

let isTimerArmed = false

/** Arms the timers once per load; a reload drops the old ones and may not raise session.start again. */
async function ensureArmed($: EngineInterface): Promise<void> {
  if (isTimerArmed) return
  isTimerArmed = true
  const now = await $.clock.now()
  await update($, startedAt, v => v ?? now)
  await update($, tick, () => now)
  $.clock.every(TICK_MS, () => void $.clock.now().then(t => update($, tick, () => t)))
  $.clock.every(FRAME_MS, () => {
    if (isTurnRunning) void update($, frame, n => (n + 1) % DOTS.length)
  })
  $.clock.every(WANT_POLL_MS, () => {
    if (!isWanted || isRefreshing) return
    isWanted = false
    void refresh($)
  })
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const messages = await $.session.messages()
    await update($, links, () => linksIn(messages))
    const from = await read($, cursor)
    if (messages.length <= from) return
    const previous = await read($, summary)
    await update($, isBusy, () => true)

    const language = languageOnce ?? 'ja'
    languageOnce = null
    const prompt = [
      `## 前回のサマリ\n${previous === null ? '（まだなし。最初のサマリを作ってください）' : JSON.stringify(previous)}`,
      `## その後のやり取り（${messages.length - from} 件）\n${digest(messages, from)}`,
      `## 出力言語\n${language === 'en' ? 'English (translate every field, including unchanged ones)' : '日本語（変更のない項目もすべて日本語で）'}`,
    ].join('\n\n')

    const reply = await $.model.complete({
      model: MODEL,
      system: [{ text: SYSTEM, cache: true }],
      prompt,
      effort: 'low',
      maxTokens: 600,
      timeoutMs: 30_000,
    })
    const now = await $.clock.now()
    lastRefreshAt = now
    callsSinceRefresh = 0
    if (!reply.isAnswered) {
      $.ui.status(`progress: ${reply.reason}`)
      return
    }
    const parsed = parseSummary(reply.text, now)
    if (parsed === null) {
      $.ui.status('progress: サマリを解釈できませんでした')
      return
    }
    $.ui.status(undefined)
    await update($, summary, () => parsed)
    await update($, cursor, () => messages.length)
  } finally {
    await update($, isBusy, () => false)
    isRefreshing = false
  }
}

function elapsed(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - fromMs) / 60_000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function ago(fromMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - fromMs) / 60_000))
  return minutes === 0 ? 'just now' : `${minutes}m ago`
}

function bar(progress: number, cells: number): string {
  const filled = Math.round((progress / 100) * cells)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, cells - filled))
}

export const register: Register = (on, options) => {
  const view: 'band' | 'pane' = options.view === 'pane' ? 'pane' : 'band'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'progress',
      description: 'Refresh the progress summary now; `en`/`ja` picks the language for this refresh; `links` lists every url',
      argumentHint: '[en | ja | links]',
    })
    await ensureArmed($)
    if (view === 'pane') void $.ui.open({ id: PANE, title: PANE_TITLE })
    return next(e)
  })

  on('command.run', { command: 'progress' }, async ($, e) => {
    await ensureArmed($)
    const arg = e.args.trim()
    if (arg === 'en' || arg === 'ja') {
      languageOnce = arg
      await update($, cursor, c => Math.max(0, c - 1)) // re-summarise even with nothing new
      await update($, isHidden, () => false)
      if (view === 'pane') await $.ui.open({ id: PANE, title: PANE_TITLE })
      await refresh($)
      return { text: `Progress summary refreshed in ${arg === 'en' ? 'English' : 'Japanese'} (this once).` }
    }
    if (arg === 'links') {
      const found = linksIn(await $.session.messages())
      await update($, links, () => found)
      return { text: found.length === 0 ? 'No links in this conversation yet.' : found.map(l => l.url).join('\n') }
    }
    await update($, isHidden, () => false)
    if (view === 'pane') await $.ui.open({ id: PANE, title: PANE_TITLE })
    await refresh($)
    return { text: 'Progress summary refreshed.' }
  })

  on('turn.start', async ($, e, next) => {
    await ensureArmed($)
    isTurnRunning = true
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false
      kick()
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      await ensureArmed($)
      callsSinceRefresh += 1
      if (callsSinceRefresh >= MID_TURN_EVERY_CALLS) {
        const now = await $.clock.now()
        if (now - lastRefreshAt >= MID_TURN_MIN_GAP_MS) kick()
      }
    }
    return next(e)
  })

  on('ui.render', async ($, e, next) => {
    // One drawing for both sites: the band above the prompt, or the plugin's pane.
    const isBand = e.component === 'AbovePrompt'
    const isPane = e.component === 'Pane' && e.requestId === PANE
    if (!isBand && !isPane) return next(e)
    if (isBand && (view === 'pane' || e.props.hasSurvey)) return next(e)

    const current = await read($, summary)
    const hidden = await read($, isHidden)
    if (current === null || (isBand && hidden)) return next(e)

    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const seenLinks = isPane ? await read($, links) : []
    const shownLinks = seenLinks.slice(-MAX_LINKS_SHOWN)
    const now = await read($, tick)
    const began = (await read($, startedAt)) ?? now
    const busy = await read($, isBusy)
    const width = e.props.bodyColumns
    const barCells = width >= 70 ? 10 : 6
    const rows = isBand ? e.props.maxRows : 99
    const isWorking = isBand ? e.props.isWorking : isTurnRunning
    const wrap = isPane ? 'wrap' : 'truncate-end'

    const dots = isWorking ? DOTS[(await read($, frame)) % DOTS.length] : ''
    const line = (label: string, color: LabelColor, text: string, isBold = false, suffix = '') => (
      <Text wrap={wrap}>
        <Text color={color} bold>
          {label}{' '}
        </Text>
        <Text bold={isBold}>{text}</Text>
        {suffix !== '' && <Text color={color}>{suffix}</Text>}
      </Text>
    )

    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="row">
          <Text wrap="truncate-end">
            <Text bold>⏱ {elapsed(began, now)}</Text>
            <Text dimColor>  Progress </Text>
            <Text>{current.progress}% {bar(current.progress, barCells)}</Text>
            <Text dimColor>  Updated {busy ? 'now…' : ago(current.updatedAt, now)} </Text>
          </Text>
          <Button key="refresh" plain hotkey="r" label="Refresh" onPress={kick} />
          {isBand && <Text> </Text>}
          {isBand && <Button key="hide" plain hotkey="h" label="Hide" onPress={() => update($, isHidden, () => true)} />}
        </Box>
        {rows >= 6 && line('Plan', 'planMode', current.plan)}
        {rows >= 5 && line('Done', 'success', current.done)}
        {line('Now ', 'claude', current.doing, true, dots)}
        {rows >= 4 && line('Next', 'suggestion', current.next)}
        {current.asks.length > 0 && line('Ask ', 'warning', current.asks.join(' / '))}
        {isPane && seenLinks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              Links ({seenLinks.length})
            </Text>
            {shownLinks.map(l => (
              <Box key={l.url} flexDirection="row">
                <Text dimColor wrap="truncate-end">
                  {l.host}{' '}
                </Text>
                <Link href={l.url} label={l.url.replace(/^https?:\/\//, '')} />
              </Box>
            ))}
            {seenLinks.length > shownLinks.length && (
              <Text dimColor>+{seenLinks.length - shownLinks.length} older · /progress links</Text>
            )}
          </Box>
        )}
      </Box>
    )
  })
}
