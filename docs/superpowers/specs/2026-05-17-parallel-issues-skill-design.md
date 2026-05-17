# Parallel Issues Skill — Design

**Date:** 2026-05-17  
**Status:** Approved — pending implementation  
**Target:** `~/.claude/skills/parallel-issues/SKILL.md` (global, works on any repo)

---

## Summary

A reusable global skill (`/parallel-issues`) for running multiple independent GitHub issues in parallel using git worktrees. Combines issue conflict analysis, sequential brainstorming, and parallel implementation into a single invocable workflow.

---

## Invocation

**Trigger:** `/parallel-issues` or `/parallel-issues <issue-list>`  
**Description trigger phrases:** "run issues in parallel", "parallel workstreams", "work on multiple issues at once"

**Two modes:**
- **Auto:** `/parallel-issues` — skill fetches open issues, reasons about safe groups, presents recommendation
- **Explicit:** `/parallel-issues 57 54` — skip scanning, trust the list, go straight to conflict check

---

## Architecture: Sequential Setup → Parallel Execution

Conflict analysis and brainstorming are inherently sequential (need the whole picture, need user steering). Implementation is the expensive part — that's where parallelism pays off.

```text
Phase 1 (sequential, orchestrator):
  detect repo → scan issues → conflict analysis →
  recommendation → user approval →
  sequential brainstorm per issue (user steers each) →
  create worktrees

Phase 2 (parallel, N agents):
  dispatch all agents simultaneously →
  each: writing-plans → subagent-driven-development → open PR →
  collect PRs → report table
```

---

## Phase 1 — Setup (Orchestrator, Sequential)

### Step 1: Detect Repo

```bash
REPO=$(git remote get-url origin | sed 's|.*github.com[:/]\(.*\)\.git|\1|')
```

Handles both HTTPS (`https://github.com/owner/repo.git`) and SSH (`git@github.com:owner/repo.git`) formats.

### Step 2: Fetch Open Issues

```bash
gh issue list --repo "$REPO" --state open --limit 30 --json number,title,labels,body
```

In explicit mode (`/parallel-issues 57 54`), fetch only the specified issues.

### Step 3: Conflict Analysis (Claude Reasoning)

Read each issue's title, labels, and body. Reason about which source files each issue would likely touch based on:
- Module labels (parser, api, mcp, db, generator, merge)
- Issue title keywords (e.g., "DOCX" → `parser/docx/`, "rate limit" → `mcp/server.ts`)
- Issue body scope/deliverables sections

Output a conflict map:
```text
Safe to parallelize:
  #57 (DOCX resilience) → parser/docx/, tests/fixtures/docx/
  #54 (rate limiting)   → mcp/server.ts
  → No overlap ✅

Conflict:
  #56 (surface inference conflicts) → mcp/tools.ts, parser/docx/inference.ts
  #54 (rate limiting)               → mcp/server.ts, mcp/tools.ts
  → Both touch mcp/tools.ts ⚠️ Run #56 after #54 merges
```

### Step 4: Present Recommendation

Show the safe groups and conflicts. Ask for approval or adjustment.

### Step 5: Sequential Brainstorm

For each approved issue (one at a time, in order):
1. Invoke `superpowers:brainstorming` with the issue as context
2. User steers — asks questions, catches assumptions, adjusts scope
3. Approved design saved to `docs/superpowers/specs/YYYY-MM-DD-issue-NNN-design.md` in the repo

Repeat for each issue before creating any worktrees.

### Step 6: Create Worktrees

For each issue:

```bash
# Verify .worktrees/ is gitignored
git check-ignore -q .worktrees || echo '.worktrees' >> .gitignore

# Create worktree on fresh branch from origin/main
git fetch origin
# Detect default branch (main or master)
BASE=$(git remote show origin | grep 'HEAD branch' | awk '{print $NF}')
git worktree add .worktrees/feat/issue-NNN -b feat/issue-NNN origin/$BASE

# Install deps
cd .worktrees/feat/issue-NNN && pnpm install
```

---

## Phase 2 — Parallel Execution (N Agents, Simultaneous)

Dispatch all agents in a **single message** (multiple Agent tool calls) so they run concurrently.

### Per-Agent Prompt Structure

Each agent receives:
- Issue number + full issue body
- Path to approved design doc
- Worktree path + branch name
- Repo `owner/repo`
- Branch rules (never commit to main)
- Instruction to run: `writing-plans` → `subagent-driven-development` → `finishing-a-development-branch` (option 2: PR)
- Path to `CLAUDE.md` for conventions

```text
You are implementing GitHub issue #NNN in an isolated worktree.

Work from: .worktrees/feat/issue-NNN
Branch: feat/issue-NNN (NEVER commit to main)
Repo: owner/repo
Design doc: docs/superpowers/specs/YYYY-MM-DD-issue-NNN-design.md

## Your Workflow
1. Read the design doc
2. Invoke superpowers:writing-plans to create implementation plan
3. Invoke superpowers:subagent-driven-development to execute
4. Invoke superpowers:finishing-a-development-branch, choose option 2 (PR)
   PR body must include: Closes #NNN

## Issue
[full issue body]

## CLAUDE.md conventions
[path or key excerpts]

Report back: PR URL or BLOCKED with reason.
```

### Collecting Results

After all agents return, orchestrator prints:

```text
Parallel execution complete:

  #57 DOCX resilience    → PR #67 https://github.com/owner/repo/pull/67
  #54 Rate limiting      → PR #68 https://github.com/owner/repo/pull/68
  #56 Inference conflicts → BLOCKED: conflicts with #54 changes (as predicted)

Worktrees preserved at .worktrees/ for PR iteration.
Run /parallel-issues 56 after #54 merges.
```

---

## Worktree Cleanup

Worktrees are NOT cleaned up after PRs are opened — the agent needs them for iteration if reviewers request changes. Cleanup happens after merge:

```bash
git worktree remove .worktrees/feat/issue-NNN
git worktree prune
git branch -d feat/issue-NNN
```

The skill prints a cleanup block at the end of the report:

```bash
# Run after each PR merges:
git worktree remove .worktrees/feat/issue-57 && git branch -d feat/issue-57
git worktree remove .worktrees/feat/issue-54 && git branch -d feat/issue-54
git worktree prune
```

---

## Error Handling

| Situation | Behavior |
|-----------|----------|
| Agent returns BLOCKED | Report in table, suggest when to retry |
| File conflict detected mid-execution | Agent reports BLOCKED, orchestrator flags it |
| Worktree creation fails (permission) | Fall back to in-place on new branch, warn user |
| No open issues | Print message, exit gracefully |
| Explicit issue list has conflicts | Warn, ask user to confirm or adjust |

---

## Out of Scope

- Non-GitHub repos (relies on `gh` CLI + GitHub issues)
- Repos without a `main` branch (skill checks and falls back to `master`)
- More than 5 parallel issues (max to keep token budget manageable)
- Automatic merge after PR is approved (user merges manually)
