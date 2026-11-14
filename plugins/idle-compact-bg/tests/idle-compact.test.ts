import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import { decide, isBackgroundKind, minTokens, timing } from '../hooks/register'

const MINUTE = 60_000

type EngineOptions = {
  kind?: string
  tokens?: number
  rateLimitPercents?: readonly number[]
  idleCompaction?: boolean
}

function engine(on: On, options: EngineOptions = {}) {
  const clock = mock.clock(on, { now: 1_000 * MINUTE })
  mock.env(on, options.kind === undefined ? {} : { CLAUDE_CODE_SESSION_KIND: options.kind })

  const compactedAt: number[] = []
  const logs: string[] = []

  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('settings.read', () => ({
    value: options.idleCompaction === undefined ? {} : { idleCompaction: options.idleCompaction },
  }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: options.tokens ?? 350_000, window: 1_000_000 },
      rateLimits: (options.rateLimitPercents ?? [20]).map((percentUsed) => ({ kind: 'five_hour', percentUsed })),
    },
  }))
  on('session.compact', () => {
    compactedAt.push(clock.now())
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: options.tokens ?? 350_000, tokensAfter: 20_000 }
  })
  on('ui.log', (_, e) => {
    logs.push(e.text)
    return { value: undefined }
  })

  return { clock, compactedAt, logs }
}

const turnEnd = { answer: '', durationMs: 1_000, isAborted: false, reason: 'answer' as const }

describe('rules', () => {
  test('only background session kinds count', async () => {
    expect(isBackgroundKind('bg')).toBe(true)
    expect(isBackgroundKind('daemon')).toBe(true)
    expect(isBackgroundKind('daemon-worker')).toBe(true)
    expect(isBackgroundKind(undefined)).toBe(false)
    expect(isBackgroundKind('interactive')).toBe(false)
  })

  test('the token minimum follows the engine', async () => {
    expect(minTokens(undefined)).toBe(200_000)
    expect(minTokens('')).toBe(200_000)
    expect(minTokens('150000')).toBe(150_000)
    expect(minTokens('5000')).toBe(100_000)
    expect(minTokens('lots')).toBe(200_000)
  })

  test('it fires between 45 and 50 minutes of idle time', async () => {
    expect(timing(44.9 * MINUTE)).toBe('wait')
    expect(timing(45 * MINUTE)).toBe('due')
    expect(timing(50 * MINUTE)).toBe('due')
    expect(timing(50.1 * MINUTE)).toBe('lapsed')
  })

  test('the setting, the size and the rate limits each veto', async () => {
    const base = { idleCompaction: undefined, contextTokens: 350_000, minTokens: 100_000, rateLimitPercents: [20] }
    expect(decide(base)).toBe('compact')
    expect(decide({ ...base, idleCompaction: true })).toBe('compact')
    expect(decide({ ...base, idleCompaction: false })).toBe('off')
    expect(decide({ ...base, contextTokens: 99_999 })).toBe('small')
    expect(decide({ ...base, contextTokens: undefined })).toBe('small')
    expect(decide({ ...base, rateLimitPercents: [20, 95] })).toBe('near_limit')
  })
})

describe('a background session', () => {
  test('compacts once, about 45 minutes after the turn ends', async ($, on) => {
    const { clock, compactedAt, logs } = engine(on, { kind: 'bg' })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    await $.turn.start({ text: 'build it', turnId: 't1' })
    await $.turn.complete({ ...turnEnd, turnId: 't1' })
    const endedAt = clock.now()

    await clock.advance(44 * MINUTE)
    expect(compactedAt).toHaveLength(0)

    await clock.advance(2 * MINUTE)
    expect(compactedAt).toHaveLength(1)
    expect((compactedAt[0] ?? 0) - endedAt).toBeGreaterThanOrEqual(45 * MINUTE)
    expect(logs).toContain('Compacted while idle, before the prompt cache expired (350000 → 20000 tokens) · idle-compact-bg')

    await clock.advance(120 * MINUTE)
    expect(compactedAt).toHaveLength(1)
  })

  test('a new turn restarts the wait, and nothing fires while a turn runs', async ($, on) => {
    const { clock, compactedAt } = engine(on, { kind: 'daemon-worker' })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    await $.turn.start({ text: 'one', turnId: 't1' })
    await $.turn.complete({ ...turnEnd, turnId: 't1' })

    await clock.advance(40 * MINUTE)
    await $.turn.start({ text: 'two', turnId: 't2' })
    await clock.advance(70 * MINUTE)
    expect(compactedAt).toHaveLength(0)

    await $.turn.complete({ ...turnEnd, turnId: 't2' })
    await clock.advance(44 * MINUTE)
    expect(compactedAt).toHaveLength(0)
    await clock.advance(2 * MINUTE)
    expect(compactedAt).toHaveLength(1)
  })

  test('a subagent turn neither arms nor resets the wait', async ($, on) => {
    const { clock, compactedAt } = engine(on, { kind: 'bg' })
    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    await $.turn.start({ text: 'main', turnId: 't1' })
    await $.turn.complete({ ...turnEnd, turnId: 't1' })

    await clock.advance(25 * MINUTE)
    await $.turn.start({ text: 'sub', turnId: 's1', agentId: 'a1' })
    await $.turn.complete({ ...turnEnd, turnId: 's1', agentId: 'a1' })
    await clock.advance(21 * MINUTE)
    expect(compactedAt).toHaveLength(1)
  })

  const vetoes: readonly [string, EngineOptions][] = [
    ['a small context', { tokens: 80_000 }],
    ['idleCompaction off', { idleCompaction: false }],
    ['a near rate limit', { rateLimitPercents: [97] }],
  ]
  for (const [name, options] of vetoes) {
    test(`skips ${name}`, async ($, on) => {
      const { clock, compactedAt } = engine(on, { kind: 'bg', ...options })
      await $.session.start({ cwd: '/', surface: null, isInteractive: false })
      await $.turn.start({ text: 'go', turnId: 't1' })
      await $.turn.complete({ ...turnEnd, turnId: 't1' })
      await clock.advance(60 * MINUTE)
      expect(compactedAt).toHaveLength(0)
    })
  }
})

test('an attended session is left to the built-in idle compaction', async ($, on) => {
  const { clock, compactedAt } = engine(on, {})
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ ...turnEnd, turnId: 't1' })
  await clock.advance(60 * MINUTE)
  expect(compactedAt).toHaveLength(0)
})
