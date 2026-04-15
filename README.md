[English](./README.md) | [中文](./README.zh-CN.md)

# Plankton

Plankton is a local-first approval console for sensitive resource access. The desktop UI is the policy surface and the human approval surface. The CLI is the operator and LLM entrypoint for listing, searching, and requesting resource access.

Powered by OpenAquarium

## Codex Skill

This repository ships with a bundled Codex skill at `.codex/skills/secret-access`.

Install it into your local Codex skill directory from the repository root:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -sfn "$PWD/.codex/skills/secret-access" "${CODEX_HOME:-$HOME/.codex}/skills/secret-access"
```

After that, Codex can load the skill when a task needs a password, API key, token, credential, or other secret. The skill is designed to request secrets through Plankton and keep returned values out of persistent storage and out of model-visible output.

## How to Use

### 1. Install with Homebrew

The default install path is the project-owned tap and desktop cask:

```bash
brew install --cask zqqqqz2000/tap/plankton
plankton
```

This is a tap-owned cask, not a `homebrew-core` formula. The cask installs both `Plankton.app` and the `plankton` command. An internal helper formula may still exist inside the tap, but it is not the user-facing entrypoint.

### 2. Install from source for local development

```bash
make install
export PLANKTON_DATABASE_URL="sqlite://$PWD/.plankton/local.db"
mkdir -p .plankton
make check
```

### 3. Start the desktop UI

```bash
make tauri-dev
```

Keep the desktop window open. Daily use is centered on the UI.

### 4. Choose the strategy in the UI

- `Human Review` is the UI-only strategy mode for human approval. A human reviews and approves or rejects in the desktop UI. This is not a CLI approval flow.
- `assisted` asks a provider for a suggestion, then keeps the final human decision in the desktop UI.
- `auto` lets local guardrails and the provider produce an automatic allow, deny, or escalate outcome, while keeping the result visible in both UI and CLI.

### 5. Use the CLI to list, search, and request access

List the resource identifiers currently available to the local LLM surface:

```bash
plankton list
```

This command lists identifiers and minimal metadata only. It does not print secret values.

Search the same identifier view with a fuzzy resource match:

```bash
plankton search api-token
```

`search` narrows the same resource identifier surface returned by `list`. It still returns identifiers and minimal metadata only, never secret values.

Request one resource with the installed command:

```bash
plankton get secret/api-token \
  --reason "Need readonly dev config" \
  --requested-by alice
```

On success, the default text output prints only the resolved secret value. It does not print request IDs, approval summaries, provider metadata, or other wrappers around the value.

If you need machine-readable output instead of a bare value, use `--output json`. The JSON path is intentionally a small `get`-specific envelope rather than a full request or audit dump.

The value itself is resolved at runtime from the local secret catalog, not from SQLite, audit records, or provider payloads. If your environment uses an explicit catalog file, point Plankton at it before running `get` (for example with `PLANKTON_SECRET_FILE=/abs/path/...`).

If the request cannot be completed automatically, Plankton hands off to the desktop UI. Human approval, suggestion review, and audit inspection all happen there. Non-success paths keep `stdout` empty and report status or errors separately. When a request is denied and the recorded decision includes a reason or note, Plankton appends that reason to the deny error. When no reason was recorded, the deny output stays concise.

If you are working from a source checkout instead of the cask, run the same commands with `cargo run -p plankton -- ...`.

### 6. Configure a provider only when you need assisted or auto

`Human Review` does not require a provider.

OpenAI-compatible:

```bash
export PLANKTON_PROVIDER_KIND=openai_compatible
export PLANKTON_OPENAI_API_KEY=...
export PLANKTON_OPENAI_MODEL=...
```

ACP Codex:

```bash
export PLANKTON_PROVIDER_KIND=acp_codex
export PLANKTON_ACP_CODEX_PROGRAM=npx
export PLANKTON_ACP_CODEX_ARGS="-y @zed-industries/codex-acp@0.11.1"
```

Claude:

```bash
export PLANKTON_PROVIDER_KIND=claude
export PLANKTON_CLAUDE_API_KEY=...
export PLANKTON_CLAUDE_MODEL=...
```

## Operator Boundaries

- The UI owns strategy configuration and human approval.
- The CLI is for listing, searching, and requesting resource access, not for human approval or audit management.
- If you still see `approve` or `reject` in the repository, treat them as internal or legacy compatibility paths, not as the primary operator workflow.

## Further Reading

- [P1 Runbook](./docs/p1-runbook.md)
- [P1 Dependency Boundaries](./docs/p1-dependency-boundaries.md)
- [ADR 0001: P1 Dependency Boundaries](./docs/adr/0001-p1-dependency-boundaries.md)

## Principle

- Every access attempt becomes an explicit request before any approval or model action happens.
- Sensitive context is sanitized before a provider sees it.
- Local guardrails stay authoritative even when a provider is enabled.
- The desktop UI owns the detailed approval and audit trail for every request.
- The system is designed to fail closed when context is incomplete, a provider response is invalid, or a risk boundary is crossed.
