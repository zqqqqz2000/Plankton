# Plankton Operator

Use this skill when you need to run, demo, validate, or explain how to use Plankton from the local repository.

英文为主，必要时补少量中文说明。优先告诉用户怎么用，再在最后解释原理。

## What this skill is for

- Start Plankton locally.
- Submit and inspect requests with the CLI.
- Use the desktop app for approval flows.
- Demonstrate `manual-only`, `assisted`, and `auto` modes.
- Explain provider setup for `openai_compatible`, `acp_codex`, and `claude`.

## Rules

- Prefer user-facing commands over internal code walkthroughs.
- Do not expose real secrets in examples. Use placeholders such as `...`.
- Do not promise a provider path unless its required environment variables are present and you have verified it in the current repo state.
- Keep explanations practical first, conceptual second.

## Standard workflow

1. Work from the repo root:

```bash
cd /Users/jpx/Documents/plankton
```

2. First-time setup:

```bash
make install
export PLANKTON_DATABASE_URL="sqlite://$PWD/.plankton/local.db"
mkdir -p .plankton
make check
```

3. Start the desktop approval console:

```bash
make tauri-dev
```

4. In another terminal, submit requests:

```bash
# Manual review
cargo run -p plankton-cli -- get secret/api-token --reason "Manual smoke test" --requested-by alice --policy-mode manual-only

# Assisted review
cargo run -p plankton-cli -- get secret/api-token --reason "Assisted demo" --requested-by alice --policy-mode assisted

# Automatic mode
cargo run -p plankton-cli -- get secret/api-token --reason "Auto demo" --requested-by alice --policy-mode auto
```

5. Inspect or decide:

```bash
cargo run -p plankton-cli -- queue
cargo run -p plankton-cli -- status <request-id>
cargo run -p plankton-cli -- suggestion <request-id>
cargo run -p plankton-cli -- audit --limit 20
cargo run -p plankton-cli -- approve <request-id> --note "approved after review"
cargo run -p plankton-cli -- reject <request-id> --note "rejected after review"
```

## Provider setup

### `manual-only`

No provider setup required.

### `openai_compatible`

```bash
export PLANKTON_PROVIDER_KIND=openai_compatible
export PLANKTON_OPENAI_API_KEY=...
export PLANKTON_OPENAI_MODEL=...
```

### `acp_codex`

```bash
export PLANKTON_PROVIDER_KIND=acp_codex
export PLANKTON_ACP_CODEX_PROGRAM=npx
export PLANKTON_ACP_CODEX_ARGS="-y @zed-industries/codex-acp@0.11.1"
```

### `claude`

```bash
export PLANKTON_PROVIDER_KIND=claude
export PLANKTON_CLAUDE_API_KEY=...
export PLANKTON_CLAUDE_MODEL=...
```

If a provider path is still being validated on the current branch, say that clearly instead of pretending it is fully settled.  
如果某条 provider 路径还在当前分支上验证中，要明确说明，不要假装它已经完全收稳。

## How to explain Plankton

When a user asks how Plankton works, keep the order:

1. What the user runs.
2. What the desktop and CLI each do.
3. Which provider mode is being used.
4. Only then explain the principle:
   - sanitize first
   - suggestion before decision
   - fail-closed guardrails
   - shared audit trail
