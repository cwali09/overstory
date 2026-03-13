# Overstory - Design Overview

## What It Does

Overstory is a multi-agent orchestration CLI that turns a single AI coding session into a coordinated team of agents. Each agent runs in an isolated git worktree via tmux, communicates through a custom SQLite mail system, and merges work back via a FIFO queue with tiered conflict resolution.

## Entry Points

| Entry Point | File | Description |
|-------------|------|-------------|
| **CLI** | `src/index.ts` | Commander.js program — routes `ov <command>` to handler files in `src/commands/` |
| **Hook targets** | `ov prime`, `ov mail check --inject`, `ov log` | Called by Claude Code hooks (SessionStart, UserPromptSubmit, tool events) |
| **npm package** | `package.json` `bin.ov` | Global install via `bun install -g @os-eco/overstory-cli` |

## Exit Points

| Exit Point | Mechanism | Description |
|------------|-----------|-------------|
| **Agent spawn** | `Bun.spawn` into tmux/subprocess | `ov sling` creates worktree + deploys overlay + launches agent runtime |
| **Mail delivery** | SQLite write to `mail.db` | Messages written for other agents to poll via `ov mail check` |
| **Git operations** | `git merge`, `git push` | `ov merge` integrates agent branches back to canonical |
| **Nudge** | tmux `send-keys` | `ov nudge` injects text directly into an agent's tmux pane |

## Data Flow

```
1. INITIALIZATION
   User runs `ov init` in project
   → Creates .overstory/ directory with config, manifest, hooks, SQLite DBs

2. AGENT SPAWNING (ov sling)
   Orchestrator decides to spawn agent
   → manifest.ts looks up agent capability
   → manager.ts creates isolated git worktree
   → overlay.ts generates per-task CLAUDE.md (Layer 2)
   → hooks-deployer.ts writes settings.local.json with guards
   → registry.ts selects runtime adapter (Claude/Pi/Gemini/etc.)
   → tmux.ts or process.ts launches agent in worktree

3. AGENT COMMUNICATION (ov mail)
   Agent completes subtask
   → client.ts writes message to mail.db (SQLite WAL)
   → broadcast.ts resolves group addresses (@all, @builders)
   → Other agents poll via `ov mail check --inject`
   → Messages injected into agent context

4. MERGE (ov merge)
   Agent reports work complete (worker_done mail)
   → queue.ts enqueues branch in FIFO merge queue
   → resolver.ts attempts merge with 4-tier conflict resolution:
     Tier 0: Fast-forward (no conflicts)
     Tier 1: Git auto-merge (non-overlapping changes)
     Tier 2: AI-assisted resolution (Claude API)
     Tier 3: Human escalation (conflict markers left for user)
   → Result committed to canonical branch

5. HEALTH MONITORING (ov watch)
   Watchdog daemon polls agent health
   → daemon.ts (Tier 0): tmux/pid liveness checks
   → triage.ts (Tier 1): AI classifies failures
   → health.ts: State machine tracks agent health transitions
   → Escalation via mail if agent is stuck/crashed
```

## Key Abstractions

| Abstraction | Location | Purpose |
|-------------|----------|---------|
| `AgentRuntime` | `src/runtimes/types.ts` | Interface for runtime adapters — spawn, config deploy, guard enforcement, transcript parsing |
| `MailStore` | `src/mail/store.ts` | SQLite-backed message store with WAL mode for concurrent multi-agent access |
| `MergeQueue` | `src/merge/queue.ts` | FIFO queue ensuring ordered branch integration |
| `SessionStore` | `src/sessions/store.ts` | Tracks agent lifecycle (spawned → running → completed/failed) and orchestration runs |
| `EventStore` | `src/events/store.ts` | Tool call events, timelines, and error aggregation |
| `TrackerClient` | `src/tracker/types.ts` | Pluggable issue tracker (beads or seeds backend) |
| `Guard Rules` | `src/agents/guard-rules.ts` | Shared constants defining tool/bash restrictions per agent capability |

## Dependencies

| Dependency | Type | Usage |
|------------|------|-------|
| `bun` | Runtime | TypeScript execution, SQLite via `bun:sqlite`, subprocess spawning |
| `commander` | npm | CLI framework with typed options and subcommands |
| `chalk` | npm | Terminal color output (ESM-only v5) |
| `@os-eco/mulch-cli` | npm | Programmatic expertise API |
| `git` | System CLI | Worktree management, branch operations, merging |
| `tmux` | System CLI | Agent session isolation and lifecycle |
| `bd` / `sd` | System CLI | Issue tracking (beads or seeds backend) |
| `mulch` | System CLI | Expertise recording and retrieval |

## Architecture Highlights

- **No daemon**: The orchestrator IS your Claude Code session. Hooks wire it up automatically.
- **Two-layer instructions**: Base agent definitions (HOW) + per-task overlays (WHAT) — separation of concerns.
- **SQLite everywhere**: Mail, sessions, events, metrics, merge queue — all WAL-mode SQLite for lock-free concurrent access from multiple agents.
- **Runtime-agnostic**: Pluggable `AgentRuntime` interface supports 8 runtimes (Claude Code, Pi, Copilot, Codex, Gemini, Sapling, OpenCode, Cursor).
- **Mechanical safety**: Guard rules mechanically prevent non-implementation agents from writing files and all agents from dangerous git operations.
