import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { PaneState, PrCheck, PrCheckStatus, PrInfo, TrackedPr } from '../types'

const PANE = 'pr-status'
const TITLE = 'PR / CI'
const POLL_MS = 60_000
const IDLE_AFTER_MS = 5 * 60_000
const IDLE_AFTER_WHILE_CHECKS_RUN_MS = 30 * 60_000
const PUSH_FOLLOWUP_MS = 5_000
const MERGED_KEEP_MS = 24 * 60 * 60_000
const MAX_CHECK_ROWS = 8
const STORE_PREFIX = 'tracked:'
const STORE_KEEP_MS = 7 * 24 * 60 * 60_000
const DIAG_KEY = 'diag'
const DIAG_KEEP = 40
const GH_FIELDS = 'number,title,url,state,isDraft,reviewDecision,mergeable,headRefName,statusCheckRollup'
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g

const pane = atom({ plugin: 'pr-status-pane', key: 'pane' } as const, null)
const isPaused = atom({ plugin: 'pr-status-pane', key: 'isPaused' } as const, false)

type RollupItem = {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string | null
  state?: string
}

function checkOf(item: RollupItem): PrCheck {
  const name = item.name ?? item.context ?? 'unknown'
  if (item.__typename === 'StatusContext') {
    const state = item.state ?? 'PENDING'
    const status: PrCheckStatus =
      state === 'SUCCESS' ? 'success' : state === 'FAILURE' || state === 'ERROR' ? 'failure' : 'pending'
    return { name, status }
  }
  if (item.status !== 'COMPLETED') return { name, status: 'pending' }
  const conclusion = item.conclusion ?? ''
  const status: PrCheckStatus =
    conclusion === 'SUCCESS'
      ? 'success'
      : conclusion === 'SKIPPED' || conclusion === 'NEUTRAL'
        ? 'skipped'
        : conclusion === 'CANCELLED'
          ? 'cancelled'
          : 'failure'
  return { name, status }
}

function repoOf(url: string): string {
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\//.exec(url)
  return m?.[1] ?? ''
}

function parsePr(json: string): PrInfo | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const pr = raw as Record<string, unknown>
  const rollup = Array.isArray(pr.statusCheckRollup) ? (pr.statusCheckRollup as RollupItem[]) : []
  const url = typeof pr.url === 'string' ? pr.url : ''
  return {
    url,
    repo: repoOf(url),
    number: typeof pr.number === 'number' ? pr.number : 0,
    title: typeof pr.title === 'string' ? pr.title : '',
    branch: typeof pr.headRefName === 'string' ? pr.headRefName : '',
    state: typeof pr.state === 'string' ? pr.state : '',
    isDraft: pr.isDraft === true,
    reviewDecision: typeof pr.reviewDecision === 'string' ? pr.reviewDecision : '',
    mergeable: typeof pr.mergeable === 'string' ? pr.mergeable : '',
    checks: rollup.map(checkOf),
  }
}

function urlsIn(text: string): string[] {
  return [...new Set(text.match(PR_URL) ?? [])]
}

function pendingCount(info: PrInfo | null): number {
  return info === null ? 0 : info.checks.filter(c => c.status === 'pending').length
}

function failedNames(info: PrInfo | null): string[] {
  return info === null ? [] : info.checks.filter(c => c.status === 'failure').map(c => c.name)
}

function announce($: EngineInterface, before: TrackedPr | undefined, after: PrInfo): void {
  if (before === undefined || before.info === null) return
  if (pendingCount(before.info) === 0 || pendingCount(after) > 0 || after.checks.length === 0) return
  const failed = failedNames(after)
  const text =
    failed.length === 0
      ? `CI passed: ${after.repo}#${after.number} all checks green`
      : `CI failed: ${after.repo}#${after.number} ${failed.join(', ')}`
  $.ui.toast(text, { timeoutMs: 8000 })
  void $.ui.notify(text, { title: TITLE })
}

// ---- diagnostics: a short ring of what the poller did, readable in the plugin's store file

async function diag($: EngineInterface, note: string): Promise<void> {
  try {
    const now = await $.clock.now()
    const raw = await $.store.get(DIAG_KEY)
    const ring = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
    await $.store.set(DIAG_KEY, [...ring, `${new Date(now).toISOString()} ${note}`].slice(-DIAG_KEEP))
  } catch {
    // diagnostics never break the poller
  }
}

// ---- tracked list: this session's own, persisted under its id so a resume keeps it

type StoredEntry = { url: string; mergedAt: number | null }
type StoredList = { savedAt: number; entries: StoredEntry[] }

function isStoredEntry(x: unknown): x is StoredEntry {
  return typeof x === 'object' && x !== null && typeof (x as { url?: unknown }).url === 'string'
}

async function storeKey($: EngineInterface): Promise<string> {
  return `${STORE_PREFIX}${await $.session.id()}`
}

async function loadTracked($: EngineInterface): Promise<StoredEntry[]> {
  const raw = await $.store.get(await storeKey($))
  if (typeof raw !== 'object' || raw === null) return []
  const entries = (raw as { entries?: unknown }).entries
  return Array.isArray(entries) ? entries.filter(isStoredEntry) : []
}

async function saveTracked($: EngineInterface, entries: StoredEntry[]): Promise<void> {
  const now = await $.clock.now()
  const key = await storeKey($)
  const list: StoredList = { savedAt: now, entries }
  await $.store.set(key, list)
  // Lists of sessions not saved for a week are dropped.
  for (const other of await $.store.keys()) {
    if (other === key || !other.startsWith(STORE_PREFIX)) continue
    const raw = await $.store.get(other)
    const savedAt = typeof raw === 'object' && raw !== null ? (raw as { savedAt?: unknown }).savedAt : undefined
    if (typeof savedAt !== 'number' || now - savedAt > STORE_KEEP_MS) await $.store.delete(other)
  }
}

async function track($: EngineInterface, urls: string[]): Promise<boolean> {
  if (urls.length === 0) return false
  const entries = await loadTracked($)
  const known = new Set(entries.map(e => e.url))
  const fresh = urls.filter(u => !known.has(u))
  if (fresh.length === 0) return false
  await saveTracked($, [...entries, ...fresh.map(url => ({ url, mergedAt: null }))])
  return true
}

async function untrack($: EngineInterface, target: string): Promise<boolean> {
  const entries = await loadTracked($)
  const number = /^#?(\d+)$/.exec(target)?.[1]
  const kept = entries.filter(e => e.url !== target && (number === undefined || !e.url.endsWith(`/pull/${number}`)))
  if (kept.length === entries.length) return false
  await saveTracked($, kept)
  return true
}

// ---- history: PR urls the conversation so far has produced (a plugin installed mid-session, a resume)

const PR_COMMAND = /\bgh\s+pr\b|\bgit\s+push\b/

function urlsInHistory(messages: readonly SessionMessage[]): string[] {
  const found: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    found.push(...urlsIn(message.text))
    for (const use of message.toolUses) {
      const command = use.input.command
      if (use.tool !== 'Bash' || typeof command !== 'string' || !PR_COMMAND.test(command)) continue
      found.push(...urlsIn(use.text ?? ''))
    }
  }
  return [...new Set(found)]
}

async function scanHistory($: EngineInterface): Promise<number> {
  const urls = urlsInHistory(await $.session.messages())
  const added = await track($, urls)
  return added ? urls.length : 0
}

// ---- probing: the cwd's PR, asked for only after a `git push` or `gh pr` command

async function probeCwd($: EngineInterface): Promise<string | null> {
  const branch = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 })
  if (branch.exitCode !== 0) return null
  const view = await $.process.run(['gh', 'pr', 'view', '--json', 'url'], { timeoutMs: 20_000 })
  if (view.exitCode !== 0) return null
  return urlsIn(view.stdout)[0] ?? null
}

type Fetched = { info: PrInfo | null; error: string | null; isGone?: true }

/** gh's answer for a repository or PR that does not exist (a mistyped or made-up url). */
const GONE = /Could not resolve to a (Repository|PullRequest)|HTTP 404/i

async function fetchOne($: EngineInterface, url: string): Promise<Fetched> {
  try {
    const view = await $.process.run(['gh', 'pr', 'view', url, '--json', GH_FIELDS], { timeoutMs: 20_000 })
    if (view.exitCode !== 0) {
      const error = view.stderr.trim().split('\n')[0] ?? 'gh pr view failed'
      return GONE.test(error) ? { info: null, error, isGone: true } : { info: null, error }
    }
    const info = parsePr(view.stdout)
    return info === null ? { info: null, error: 'could not parse gh output' } : { info, error: null }
  } catch (error) {
    return { info: null, error: error instanceof Error ? error.message : String(error) }
  }
}

let isPolling = false
let lastActivityAt = 0
let isTimerArmed = false

/**
 * Arms the poll timer once per load of the module. A reload drops the old
 * environment's timers and may not raise `session.start` again, so every hook
 * that runs makes sure the timer exists.
 */
async function ensureArmed($: EngineInterface): Promise<void> {
  if (isTimerArmed) return
  isTimerArmed = true
  if (lastActivityAt === 0) lastActivityAt = await $.clock.now()
  $.clock.every(POLL_MS, () => void tickPoll($))
  await diag($, 'timer armed')
}
let wantsCwdProbe = false

async function poll($: EngineInterface): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const before = await read($, pane)

    if (wantsCwdProbe) {
      wantsCwdProbe = false
      const url = await probeCwd($)
      if (url !== null) await track($, [url])
    }

    const now = await $.clock.now()
    const entries = (await loadTracked($)).filter(e => e.mergedAt === null || now - e.mergedAt < MERGED_KEEP_MS)
    const previous = new Map((before?.prs ?? []).map(p => [p.url, p]))

    const gone: string[] = []
    const prs = await Promise.all(
      entries.map(async (entry): Promise<TrackedPr> => {
        const old = previous.get(entry.url)
        if (entry.mergedAt !== null && old !== undefined) return old
        const fetched = await fetchOne($, entry.url)
        if (fetched.isGone === true) gone.push(entry.url)
        if (fetched.info !== null) announce($, old, fetched.info)
        const isMerged = fetched.info?.state === 'MERGED'
        return {
          url: entry.url,
          info: fetched.info ?? old?.info ?? null,
          error: fetched.error,
          updatedAt: now,
          mergedAt: isMerged ? (entry.mergedAt ?? now) : null,
        }
      }),
    )
    const kept = prs.filter(p => !gone.includes(p.url))
    if (gone.length > 0) $.ui.toast(`Dropped ${gone.length} PR url(s) that do not exist: ${gone.join(', ')}`, { timeoutMs: 8000 })
    await saveTracked($, kept.map(p => ({ url: p.url, mergedAt: p.mergedAt })))
    await update($, pane, () => ({ prs: kept, updatedAt: now }))
    await diag($, `poll: done, ${prs.length} prs, errors=${prs.filter(p => p.error !== null).length}`)
  } catch (error) {
    await diag($, `poll: failed ${error instanceof Error ? error.message : String(error)}`)
    throw error
  } finally {
    isPolling = false
  }
}

async function touch($: EngineInterface): Promise<void> {
  await ensureArmed($)
  const now = await $.clock.now()
  const wasIdle = now - lastActivityAt > IDLE_AFTER_MS
  lastActivityAt = now
  if (wasIdle) {
    await update($, isPaused, () => false)
    void poll($)
  }
}

/** Whether any tracked, unmerged PR still has a check running: then the pane keeps polling longer. */
async function hasRunningChecks($: EngineInterface): Promise<boolean> {
  const state = await read($, pane)
  return (state?.prs ?? []).some(pr => pr.mergedAt === null && pendingCount(pr.info) > 0)
}

async function tickPoll($: EngineInterface): Promise<void> {
  try {
    const now = await $.clock.now()
    const idleAfter = (await hasRunningChecks($)) ? IDLE_AFTER_WHILE_CHECKS_RUN_MS : IDLE_AFTER_MS
    if (now - lastActivityAt > idleAfter) {
      await diag($, 'tick: paused (idle)')
      await update($, isPaused, () => true)
      return
    }
    await diag($, `tick: poll (isPolling=${isPolling})`)
    await poll($)
  } catch (error) {
    await diag($, `tick: failed ${error instanceof Error ? error.message : String(error)}`)
  }
}

function textOfResult(ran: { text?: string; result?: unknown }): string {
  const parts: string[] = [ran.text ?? '']
  if (typeof ran.result === 'object' && ran.result !== null) {
    const r = ran.result as Record<string, unknown>
    for (const key of ['stdout', 'stderr']) {
      const v = r[key]
      if (typeof v === 'string') parts.push(v)
    }
    const op = r.gitOperation
    if (typeof op === 'object' && op !== null) {
      const pr = (op as { pr?: { url?: unknown } }).pr
      if (typeof pr?.url === 'string') parts.push(pr.url)
    }
  }
  return parts.join('\n')
}

// ---- drawing

function icon(status: PrCheckStatus): string {
  switch (status) {
    case 'success':
      return '✔'
    case 'failure':
      return '✖'
    case 'pending':
      return '…'
    case 'skipped':
      return '–'
    case 'cancelled':
      return '⊘'
  }
}

type Tone = 'success' | 'error' | 'warning' | 'subtle'

function colorOf(status: PrCheckStatus): Tone {
  switch (status) {
    case 'success':
      return 'success'
    case 'failure':
      return 'error'
    case 'pending':
      return 'warning'
    default:
      return 'subtle'
  }
}

function reviewLabel(decision: string): string {
  switch (decision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes requested'
    case 'REVIEW_REQUIRED':
      return 'review required'
    default:
      return decision === '' ? 'no review' : decision.toLowerCase()
  }
}

function overallOf(info: PrInfo): { text: string; color: Tone } {
  const pending = pendingCount(info)
  const failed = failedNames(info).length
  if (info.checks.length === 0) return { text: 'no checks', color: 'subtle' }
  if (failed > 0) return { text: `${failed} failed`, color: 'error' }
  if (pending > 0) return { text: `running ${pending}/${info.checks.length}`, color: 'warning' }
  return { text: 'all checks passed', color: 'success' }
}

function clock(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pr-status',
      description: 'PR / CI pane for the PRs of this session: refresh, `scan` the conversation, `add <url>`, `rm <url|#n>`',
      argumentHint: '[scan | add <url> | rm <url|#n>]',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    lastActivityAt = await $.clock.now()
    await ensureArmed($)
    await diag($, 'session.start')
    await scanHistory($)
    void poll($)
    return next(e)
  })

  on('prompt.edit', async ($, e, next) => {
    await touch($)
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    await touch($)
    void poll($)
    return next(e)
  })
  on('turn.start', async ($, e, next) => {
    await touch($)
    return next(e)
  })
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    await touch($)
    return next(e)
  })
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    await touch($)
    return next(e)
  })

  on('command.run', { command: 'pr-status' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: TITLE })
    await ensureArmed($)
    lastActivityAt = await $.clock.now()
    await update($, isPaused, () => false)
    const [verb, ...rest] = e.args.trim().split(/\s+/)
    const target = rest.join(' ').trim()
    if (verb === 'add') {
      const urls = urlsIn(target)
      if (urls.length === 0) return { text: 'Usage: /pr-status add https://github.com/<owner>/<repo>/pull/<n>' }
      await track($, urls)
      await poll($)
      return { text: `Tracking ${urls.join(', ')}` }
    }
    if (verb === 'scan') {
      await scanHistory($)
      await poll($)
      return { text: 'Scanned the conversation for PRs.' }
    }
    if (verb === 'rm' || verb === 'remove') {
      const removed = await untrack($, target)
      await poll($)
      return { text: removed ? `Stopped tracking ${target}` : `Not tracked: ${target}` }
    }
    await poll($)
    return { text: 'PR / CI pane refreshed.' }
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      await ensureArmed($)
      lastActivityAt = await $.clock.now()
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (!/\bgit\s+push\b|\bgh\s+pr\b/.test(e.command)) return ran
    if (ran.deny === undefined) {
      const found = urlsIn(textOfResult(ran))
      if (found.length > 0) await track($, found)
    }
    wantsCwdProbe = true
    $.clock.after(PUSH_FOLLOWUP_MS, () => void poll($))
    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, pane)
    const removeButton = (url: string) => (
      <Button
        key={`rm:${url}`}
        plain
        label="✕"
        onPress={() => {
          void untrack($, url).then(() => poll($))
        }}
      />
    )
    const paused = await read($, isPaused)
    const width = e.props.bodyColumns

    if (state === null) {
      return (
        <Box flexDirection="column">
          <Text dimColor>Loading…</Text>
        </Box>
      )
    }

    const active = state.prs.filter(p => p.mergedAt === null)
    const merged = state.prs.filter(p => p.mergedAt !== null)
    const block = (pr: TrackedPr) => {
      const { info } = pr
      if (info === null) {
        return (
          <Box key={pr.url} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row">
              <Text dimColor wrap="truncate-end">
                {pr.url}
              </Text>
              <Text> </Text>
              {removeButton(pr.url)}
            </Box>
            <Text color="error" wrap="truncate-end">
              Failed: {pr.error ?? 'unknown error'}
            </Text>
          </Box>
        )
      }
      const overall = overallOf(info)
      const stateLabel = info.isDraft ? 'draft' : info.state.toLowerCase()
      return (
        <Box key={pr.url} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row">
            <Text bold wrap="truncate-end">
              {info.repo}#{info.number}
            </Text>
            <Text> </Text>
            {removeButton(pr.url)}
          </Box>
          <Text wrap="truncate-end">{info.title}</Text>
          <Text dimColor wrap="truncate-end">
            {info.branch} · {stateLabel} · {reviewLabel(info.reviewDecision)}
            {info.mergeable === 'CONFLICTING' ? ' · conflict' : ''}
          </Text>
          <Text color={overall.color} bold>
            {overall.text}
          </Text>
          <Text dimColor wrap="truncate-end">
            {info.url}
          </Text>
          {info.checks.slice(0, MAX_CHECK_ROWS).map(check => (
            <Text key={check.name} color={colorOf(check.status)} wrap="truncate-end">
              {icon(check.status)} {check.name}
            </Text>
          ))}
          {info.checks.length > MAX_CHECK_ROWS && <Text dimColor>+{info.checks.length - MAX_CHECK_ROWS} more</Text>}
          {pr.error !== null && (
            <Text color="error" wrap="truncate-end">
              stale: {pr.error}
            </Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={width}>
        {state.prs.length === 0 && (
          <Text dimColor wrap="wrap">
            No PRs yet. PRs this session pushes or creates appear here · /pr-status scan · /pr-status add {'<url>'}
          </Text>
        )}
        {active.map(block)}
        {merged.map(pr => (
          <Box key={`merged:${pr.url}`} flexDirection="row">
            <Text dimColor wrap="truncate-end">
              ✔ {pr.info === null ? pr.url : `${pr.info.repo}#${pr.info.number} · merged · ${pr.info.title}`}
            </Text>
            <Text> </Text>
            {removeButton(pr.url)}
          </Box>
        ))}
        {merged.length > 0 && <Text> </Text>}
        <Text dimColor wrap="truncate-end">
          {paused
            ? `Updated ${clock(state.updatedAt)} · paused (idle) · type or /pr-status to resume`
            : `Updated ${clock(state.updatedAt)} · every ${Math.round(POLL_MS / 1000)}s · /pr-status to refresh`}
        </Text>
      </Box>
    )
  })
}
