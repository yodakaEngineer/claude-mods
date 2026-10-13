import { expect, mock, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import type { ProgressSummary } from '../types'

const RUN = (command: string) => ({
  command,
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: true, columns: 120 },
})

const ANSWER = {
  plan: '2つのmodを作る',
  done: 'pr-ci-pane を実装',
  doing: 'progress-band を実装中',
  next: 'テストを書く',
  progress: 60,
  asks: [],
}

function messages(n: number): SessionMessage[] {
  const rows: SessionMessage[] = []
  for (let i = 0; i < n; i += 1) {
    rows.push({ role: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i}`, toolUses: [] })
  }
  return rows
}

test('差分がある時だけHaikuを呼び、サマリとカーソルを更新する', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const writes: Record<string, unknown> = {}
  on('state.set', { plugin: 'progress-band' }, ($, e, next) => {
    writes[e.key] = e.value
    return next(e)
  })
  on('ui.status', () => ({ value: undefined }))
  let rows = messages(4)
  let modelCalls = 0
  let lastPrompt = ''
  on('session.messages', () => ({ value: rows }))
  on('model.complete', ($, e) => {
    modelCalls += 1
    lastPrompt = e.prompt
    return {
      value: {
        isAnswered: true as const,
        text: '```json\n' + JSON.stringify(ANSWER) + '\n```',
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })

  await $.command.run(RUN('progress'))
  expect(modelCalls).toBe(1)
  expect(lastPrompt).toContain('まだなし')
  expect(lastPrompt).toContain('message 3')
  const first = writes.summary as ProgressSummary
  expect(first.progress).toBe(60)
  expect(first.doing).toBe('progress-band を実装中')
  expect(writes.cursor).toBe(4)

  // 新しいメッセージがなければ呼ばない
  await $.command.run(RUN('progress'))
  expect(modelCalls).toBe(1)

  // 増えた分だけ渡し、前回サマリを同梱する
  rows = [...rows, ...messages(2).map(m => ({ ...m, text: `fresh ${m.text}` }))]
  await $.command.run(RUN('progress'))
  expect(modelCalls).toBe(2)
  expect(lastPrompt).toContain('progress-band を実装中')
  expect(lastPrompt).toContain('fresh message 0')
  expect(lastPrompt).not.toContain('[user] message 0')
  expect(writes.cursor).toBe(6)
})

test('view=pane ならペインを開き、バンドは描かない', { options: { view: 'pane' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let opened: string | undefined
  on('ui.open', ($, e) => {
    opened = e.id
    return { value: { isPlaced: true as const } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/tmp/repo', surface: 'terminal', isInteractive: true })
  expect(opened).toBe('progress')
})

test('会話に出たURLを出現順に集め、/progress links で一覧できる', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const rows: SessionMessage[] = [
    { role: 'user', text: 'これ見て https://www.notion.so/team/Spec-abc123. あと https://github.com/o/r/pull/42)', toolUses: [] },
    { role: 'assistant', text: 'PR: https://github.com/o/r/pull/42 と https://example.com/docs?x=1', toolUses: [] },
  ]
  on('session.messages', () => ({ value: rows }))
  const writes: Record<string, unknown> = {}
  on('state.set', { plugin: 'progress-band' }, ($, e, next) => {
    writes[e.key] = e.value
    return next(e)
  })

  const { text } = await $.command.run({
    command: 'progress',
    args: 'links',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect((text ?? '').split('\n')).toEqual([
    'https://www.notion.so/team/Spec-abc123',
    'https://github.com/o/r/pull/42',
    'https://example.com/docs?x=1',
  ])
  expect((writes.links as { host: string }[]).map(l => l.host)).toEqual(['www.notion.so', 'github.com', 'example.com'])
})
