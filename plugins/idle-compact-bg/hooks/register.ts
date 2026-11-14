import type { Register, Timer } from 'claude-code'

// Claude Code's own idle compaction only arms in attended sessions. This mod
// gives background sessions the same behaviour, with the same rules: compact
// a large context shortly before the 1-hour prompt cache expires, so the next
// turn reads a short summary instead of rewriting the whole context.

const CACHE_TTL_MS = 60 * 60_000
// The cache window runs from the last model request, which this mod can't
// see; it sees the turn end, which comes after the final response and the Stop
// hooks. So fire well inside the window, at 45 minutes, which leaves 15
// minutes for that gap and for the compaction request to reach the cache.
const FIRE_AFTER_MS = CACHE_TTL_MS - 15 * 60_000
// Past this point (the computer slept, the worker stalled) the cache may be
// gone: skip, because a cold compaction costs as much as the turn it saves.
const LATEST_FIRE_MS = CACHE_TTL_MS - 10 * 60_000
const CHECK_EVERY_MS = 30_000
const FLOOR_TOKENS = 100_000
const DEFAULT_MIN_TOKENS = 200_000
const NEAR_LIMIT_PERCENT = 95
const BACKGROUND_KINDS = new Set(['bg', 'daemon', 'daemon-worker'])

export type Timing = 'wait' | 'due' | 'lapsed'

export type Verdict = 'compact' | 'off' | 'small' | 'near_limit'

export type DecideInput = {
  idleCompaction: unknown
  contextTokens: number | undefined
  minTokens: number
  rateLimitPercents: readonly number[]
}

export function isBackgroundKind(kind: string | undefined): boolean {
  return kind !== undefined && BACKGROUND_KINDS.has(kind)
}

// Same as the engine: CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, else 200k, never below 100k.
export function minTokens(envValue: string | undefined): number {
  const parsed = envValue === undefined || envValue.trim() === '' ? Number.NaN : Number(envValue)

  return Math.max(FLOOR_TOKENS, Number.isFinite(parsed) ? parsed : DEFAULT_MIN_TOKENS)
}

export function timing(idleMs: number): Timing {
  if (idleMs < FIRE_AFTER_MS) return 'wait'
  if (idleMs > LATEST_FIRE_MS) return 'lapsed'

  return 'due'
}

export function decide(input: DecideInput): Verdict {
  if (input.idleCompaction === false) return 'off'
  if ((input.contextTokens ?? 0) < input.minTokens) return 'small'
  if (input.rateLimitPercents.some((percent) => percent >= NEAR_LIMIT_PERCENT)) return 'near_limit'

  return 'compact'
}

export const register: Register = (on) => {
  let lastTurnEndAt: number | undefined
  let isTurnRunning = false
  let ticker: Timer | undefined

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = true
      lastTurnEndAt = undefined
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      isTurnRunning = false
      lastTurnEndAt = await $.clock.now()
    }

    return result
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)

    ticker?.cancel()
    ticker = undefined
    if (!isBackgroundKind(await $.env.get('CLAUDE_CODE_SESSION_KIND'))) return result

    let isChecking = false

    const check = async () => {
      const turnEndAt = lastTurnEndAt
      if (turnEndAt === undefined || isTurnRunning) return

      const when = timing((await $.clock.now()) - turnEndAt)
      if (when === 'wait') return

      // One try per idle stretch; the next turn's end arms the next one.
      lastTurnEndAt = undefined
      if (when === 'lapsed') {
        $.ui.log('idle-compact-bg: skipped (lapsed: the prompt cache is about to expire)', { to: 'debug' })
        return
      }

      const [idleCompaction, minTokensValue, usage] = await Promise.all([
        $.settings.read({ key: 'idleCompaction' }),
        $.env.get('CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS'),
        $.session.usage(),
      ])
      const verdict = decide({
        idleCompaction,
        contextTokens: usage.context.tokens,
        minTokens: minTokens(minTokensValue),
        rateLimitPercents: usage.rateLimits.map((rateLimit) => rateLimit.percentUsed),
      })

      if (verdict !== 'compact') {
        $.ui.log(`idle-compact-bg: skipped (${verdict}, ${usage.context.tokens ?? 0} tokens)`, { to: 'debug' })
        return
      }
      if (isTurnRunning || lastTurnEndAt !== undefined) return

      const compacted = await $.session.compact()
      if (compacted.skip !== undefined) {
        $.ui.log(`idle-compact-bg: compaction skipped (${compacted.skip})`, { to: 'debug' })
        return
      }

      const sizes =
        compacted.tokensBefore !== undefined && compacted.tokensAfter !== undefined
          ? ` (${compacted.tokensBefore} → ${compacted.tokensAfter} tokens)`
          : ''
      $.ui.log(`Compacted while idle, before the prompt cache expired${sizes} · idle-compact-bg`)
    }

    $.ui.log('idle-compact-bg: armed for this background session', { to: 'debug' })
    ticker = $.clock.every(CHECK_EVERY_MS, () => {
      if (isChecking) return

      isChecking = true
      check()
        .catch((error: unknown) => {
          $.ui.log(`idle-compact-bg: ${error instanceof Error ? error.message : String(error)}`, { to: 'debug' })
        })
        .finally(() => {
          isChecking = false
        })
    })

    return result
  })
}
