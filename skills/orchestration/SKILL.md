---
name: orchestration
description: >-
  Coordinate supervised Orca workers, or work as a dispatched worker
  (heartbeats, ask, worker_done): threaded messages, blocking ask/reply, task
  dispatch, worker_done/escalation waits, task DAGs, decision gates,
  coordinator loops, and decomposing work across agents. Use `orca-cli` for full
  ownership handoffs — "hand off", "handoff", "handover", "give this to another
  agent", "another worktree" — unless asked to supervise, monitor, or coordinate
  a DAG, and for terminal control, lightweight terminal prompts, shell commands,
  Orca worktree management, and reading or waiting on terminals.
---

# Orca Orchestration

This file is a discovery stub, not the usage guide. The full, version-matched Orca
orchestration reference is served by the `orca` binary itself — kept out of this file on
purpose so it can never drift from the binary that will actually run your commands.

Engage Orca orchestration whenever you need structured multi-agent coordination: threaded
messages, blocking ask/reply flows, task dispatch, worker_done/escalation waits, task DAGs,
decision gates, coordinator loops, or decomposing work across agents. Engage it as well
when you are a dispatched worker sending heartbeats, `ask` questions, or `worker_done`. Use
the orca-cli skill instead for full ownership handoffs ("hand off", "handoff", "handover",
"give this to another agent", "another worktree") when the user did not ask to supervise,
monitor, wait for results, or coordinate a DAG — and for ordinary terminal control, shell
commands, worktree management, and the built-in browser. Coordination requires real Orca
runtime state; never substitute a non-Orca subagent tool.

## Resolve the CLI for this session

This skill drives **Orca NP**, whose own CLI installs as `orca-np`. Choose the executable once and
reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca NP exports this for the
  sessions it manages, normally as an absolute path to its own launcher. Substitute it directly,
  quoted — these paths contain spaces (`/Applications/Orca NP.app/…`, `…/Application Support/…`) —
  with double quotes in POSIX shells, `& "…"` in PowerShell, and `"…"` in cmd.exe.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-np-dev`, the
  dev launcher the running build installed. Inside the repo, `pnpm exec orca-dev` reaches the
  same CLI.
- Otherwise, use `orca-np`.

One case needs a different executable, and it has to be established rather than guessed from what
happens to be on `PATH`: an Orca host that deployed its own CLI shim to this machine — an
Orca-managed remote or SSH session — names that shim plain `orca`, so use `orca` there. Nothing you
merely find on `PATH` establishes it: outside this app's managed sessions a bare `orca` is the
official Orca install, which targets a different app and data directory, and on Linux it is normally
the GNOME Orca screen reader (`/usr/bin/orca`), which starts speech on the user's machine. `orca-ide`
is the official Linux install too.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything — quoted as above when it is a path — and do not create a shell variable or run
`ORCA` literally. The quoting rule above is the only thing that differs between POSIX shells,
PowerShell, and cmd.exe (and a path is safer run directly than through `cmd /c`, which strips the
outer pair of quotes).

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build.

## Load the version-matched guide before running Orca commands

```text
ORCA skills get orchestration
```

That prints the compact, version-matched guide for the exact binary that will handle your
next commands. It covers the normal local coordinator loop and dispatched-worker
obligations. For a conditional action gate such as remote placement, uncertain release
recovery, or expanded DAG work, load only the reference that gate names with
`ORCA skills get orchestration --reference references/<file>.md`
(`--references` lists the names). If that binary rejects `--reference`, run
`ORCA skills get orchestration --full` and read the named bundled reference before acting.

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Orca is not running, start it with `ORCA open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `ORCA open` or restart Orca. If
`skills get` is unknown, explain that updating Orca restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
