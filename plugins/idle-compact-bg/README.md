# idle-compact-bg

Idle compaction for Claude Code background sessions.

Claude Code can compact an idle conversation shortly before its prompt cache expires (the `idleCompaction` setting). That way the next turn reads a short summary instead of writing the whole context to the cache again. In Claude Code 2.1.325 this only runs in sessions a person is attending. Background jobs (`claude agents`, session kind `bg`, `daemon` or `daemon-worker`) never compact while idle, so a large background job that you come back to after an hour starts on a cold cache.

This mod gives background sessions the same behavior. Attended sessions are left to the built-in feature.

## Install

At the prompt of a terminal session:

```
/plugin install idle-compact-bg --marketplace koode/claude-mods
```

From a shell:

```
claude plugin install idle-compact-bg --marketplace koode/claude-mods
```

Choose the user scope so every new background session loads it.

## What it does

- Arms only when `CLAUDE_CODE_SESSION_KIND` is `bg`, `daemon` or `daemon-worker`.
- Waits 45 minutes after the last main-loop turn ends, well inside the 1-hour prompt cache. The cache window runs from the last model request, which a mod can't see, so the 15-minute margin covers the final response, Stop hooks and the compaction request itself. A new turn restarts the wait; subagent turns do not count.
- Then runs the same compaction as `/compact`, unless:
  - `idleCompaction` is `false` in your settings,
  - the context is smaller than `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (default 200,000, never below 100,000),
  - a rate-limit window is 95% or more used,
  - more than 50 minutes have passed (for example after the computer slept), because the cache may expire before the request reaches it.
- Tries once per idle period.

When it compacts, the transcript shows `Compacted while idle, before the prompt cache expired (… → … tokens) · idle-compact-bg`. Skips go to the debug log (`claude --debug`), prefixed `idle-compact-bg:`.

Background sessions use the 1-hour prompt cache. If yours use the 5-minute cache, this mod does not help.

## Tests

```
claude plugin test plugins/idle-compact-bg
```

## Remove

When Claude Code runs idle compaction in background sessions by itself:

```
claude plugin uninstall idle-compact-bg
```
