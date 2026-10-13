import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { PaneState } from '../types'

const RUN = (command: string, args = '') => ({
  command,
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

function watch(on: On): { last: () => PaneState | undefined } {
  let last: PaneState | undefined
  on('state.set', { plugin: 'pr-status-pane', key: 'pane' }, ($, e, next) => {
    last = e.value ?? undefined
    return next(e)
  })
  return { last: () => last }
}

const URL_A = 'https://github.com/o/r/pull/42'
const URL_B = 'https://github.com/o/other/pull/7'

const prJson = (url: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    number: Number(url.split('/').pop()),
    title: `PR ${url.split('/').pop()}`,
    url,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: 'REVIEW_REQUIRED',
    mergeable: 'MERGEABLE',
    headRefName: 'feat/x',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'StatusContext', context: 'ci/deploy', state: 'FAILURE' },
    ],
    ...extra,
  })

const ok = (stdout: string, exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

/** gh answers: `gh pr view <url>` with that PR, `gh pr view` in the cwd with `cwdUrl` (or no PR). */
function ghAnswers(on: On, cwdUrl: string | null, extra: Record<string, unknown> = {}): { calls: () => number } {
  let calls = 0
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return ok('feat/x\n')
    calls += 1
    const url = e.argv.find(a => a.startsWith('https://'))
    if (url !== undefined) return ok(prJson(url, extra))
    return cwdUrl === null ? ok('', 1, 'no pull requests found for branch "feat/x"') : ok(JSON.stringify({ url: cwdUrl }))
  })
  return { calls: () => calls }
}

function baseline(on: On, store: Record<string, unknown> = {}, sessionId = 'session-1') {
  mock.store(on, store)
  on('session.id', () => ({ value: sessionId }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: true as const, channel: 'terminal_bell' } }))
}

const HISTORY = [
  { role: 'user' as const, text: 'PR作って', toolUses: [] },
  {
    role: 'assistant' as const,
    text: 'PRを作りました。',
    toolUses: [
      {
        tool_use_id: 't1',
        tool: 'Bash',
        input: { command: 'gh pr create --fill' },
        text: `https://github.com/o/r/pull/42\n`,
      },
      {
        tool_use_id: 't2',
        tool: 'Bash',
        input: { command: 'curl https://github.com/o/unrelated/pull/9' },
        text: 'https://github.com/o/unrelated/pull/9',
      },
    ],
  },
  { role: 'assistant' as const, text: `レビュー依頼: ${URL_B}`, toolUses: [] },
]

test('起動時は何も探さず、PRが空のまま始まる', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  baseline(on)
  on('session.messages', () => ({ value: [] }))
  const seen = watch(on)
  const gh = ghAnswers(on, URL_A)

  await $.session.start({ cwd: '/tmp/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(gh.calls()).toBe(0)
  expect(seen.last()?.prs).toEqual([])
})

test('git push のあとだけ cwd のPRを拾い、チェック一覧に変換する', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  baseline(on)
  const seen = watch(on)
  ghAnswers(on, URL_A)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: 'Everything up-to-date', stderr: '', interrupted: false },
  }))

  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: '/tmp/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push -u origin feat/x' })
  await clock.advance(5_000)
  await clock.settle()

  const state = seen.last()
  expect(state?.prs.map(p => p.url)).toEqual([URL_A])
  expect(state?.prs[0]?.info?.repo).toBe('o/r')
  expect(state?.prs[0]?.info?.checks).toEqual([
    { name: 'lint', status: 'success' },
    { name: 'test', status: 'pending' },
    { name: 'ci/deploy', status: 'failure' },
  ])
})

test('gh pr create の出力に出たURLを追跡する', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  baseline(on)
  const seen = watch(on)
  ghAnswers(on, null)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: `Creating pull request for feat/x into main in o/other\n\n${URL_B}\n`, stderr: '', interrupted: false },
  }))

  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: '/tmp/repo', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'cd ../other && gh pr create --fill' })
  await clock.advance(5_000)
  await clock.settle()
  expect(seen.last()?.prs.map(p => p.url)).toEqual([URL_B])
})

test('add/rm で手動追跡でき、他セッションのPRは出ない', async ($, on) => {
  mock.clock(on)
  baseline(on, {
    'tracked:other-session': { savedAt: 0, entries: [{ url: URL_A, mergedAt: null }] },
  })
  const seen = watch(on)
  ghAnswers(on, null)

  await $.command.run(RUN('pr-status'))
  expect(seen.last()?.prs).toEqual([])

  await $.command.run(RUN('pr-status', `add ${URL_B}`))
  expect(seen.last()?.prs.map(p => p.url)).toEqual([URL_B])

  await $.command.run(RUN('pr-status', 'rm #7'))
  expect(seen.last()?.prs).toEqual([])
})

test('離席中はポーリングを止め、入力で即時再開する', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  baseline(on, { 'tracked:session-1': { savedAt: 1_000_000, entries: [{ url: URL_A, mergedAt: null }] } })
  // all checks done: the short idle window applies
  const gh = ghAnswers(on, null, {
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  })
  on('session.messages', () => ({ value: [] }))

  await $.session.start({ cwd: '/tmp/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(gh.calls()).toBe(1)

  await clock.advance(60_000)
  await clock.settle()
  expect(gh.calls()).toBe(2)

  await clock.advance(6 * 60_000)
  await clock.settle()
  const idle = gh.calls()
  await clock.advance(2 * 60_000)
  await clock.settle()
  expect(gh.calls()).toBe(idle)

  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  expect(gh.calls()).toBe(idle + 1)
})

test('マージ済みのPRは薄く残り、以降 gh を叩かない', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  baseline(on, { 'tracked:session-1': { savedAt: 1_000_000, entries: [{ url: URL_A, mergedAt: null }] } })
  const seen = watch(on)
  const gh = ghAnswers(on, null, { state: 'MERGED', statusCheckRollup: [] })
  on('session.messages', () => ({ value: [] }))

  await $.session.start({ cwd: '/tmp/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(gh.calls()).toBe(1)
  expect(seen.last()?.prs[0]?.mergedAt).toBe(1_000_000)

  await clock.advance(3 * 60_000)
  await clock.settle()
  expect(gh.calls()).toBe(1)
  expect(seen.last()?.prs.length).toBe(1)
})

test('途中で入れても、会話履歴の gh pr コマンド結果と返答本文からPRを拾う', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  baseline(on)
  const seen = watch(on)
  ghAnswers(on, null)
  on('session.messages', () => ({ value: HISTORY }))

  await $.session.start({ cwd: '/tmp/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(seen.last()?.prs.map(p => p.url)).toEqual([URL_A, URL_B])
})

test('チェック実行中は30分まで離席判定を延ばす', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  baseline(on, { 'tracked:session-1': { savedAt: 1_000_000, entries: [{ url: URL_A, mergedAt: null }] } })
  const gh = ghAnswers(on, null) // prJson has a check IN_PROGRESS
  on('session.messages', () => ({ value: [] }))

  await $.session.start({ cwd: '/tmp/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const start = gh.calls()

  await clock.advance(10 * 60_000)
  await clock.settle()
  expect(gh.calls()).toBe(start + 10)

  await clock.advance(25 * 60_000)
  await clock.settle()
  const afterLimit = gh.calls()
  await clock.advance(5 * 60_000)
  await clock.settle()
  expect(gh.calls()).toBe(afterLimit)
})

test('session.start なしでも、最初のフックでタイマーが準備される（再読み込み後）', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  baseline(on, { 'tracked:session-1': { savedAt: 1_000_000, entries: [{ url: URL_A, mergedAt: null }] } })
  const gh = ghAnswers(on, null)

  // a keystroke after the reload: no session.start was raised
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  const first = gh.calls()
  expect(first).toBeGreaterThan(0)

  await clock.advance(60_000)
  await clock.settle()
  expect(gh.calls()).toBe(first + 1)
  await clock.advance(60_000)
  await clock.settle()
  expect(gh.calls()).toBe(first + 2)
})

test('存在しないリポジトリのURLは自動で追跡から外す', async ($, on) => {
  mock.clock(on)
  baseline(on, {
    'tracked:session-1': { savedAt: 0, entries: [{ url: URL_A, mergedAt: null }, { url: URL_B, mergedAt: null }] },
  })
  const seen = watch(on)
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return ok('feat/x\n')
    const url = e.argv.find(a => a.startsWith('https://')) ?? ''
    if (url === URL_A) return ok('', 1, "GraphQL: Could not resolve to a Repository with the name 'o/r'. (repository)")
    return ok(prJson(url))
  })

  await $.command.run(RUN('pr-status'))
  expect(seen.last()?.prs.map(p => p.url)).toEqual([URL_B])
})
