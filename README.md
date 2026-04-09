# Plankton 🐟

Plankton is a local-first approval console for sensitive resource access. It combines a desktop review queue with a CLI so you can submit requests, inspect model suggestions, and approve or reject decisions from one place.

Powered by OpenAquarium ✨

> English-first README with light Chinese support.  
> 英文为主，关键使用路径附中文提示。

## ✨ What Plankton does / 你可以用它做什么

- Run pure manual review flows.
- Ask an LLM for a suggestion before a human decision.
- Let low-risk requests auto-resolve under local guardrails.
- Inspect the same request from both desktop and CLI.
- Validate everything locally with SQLite and repeatable commands.

## 🚀 Quick Start / 快速开始

```bash
make install
export PLANKTON_DATABASE_URL="sqlite://$PWD/.plankton/local.db"
mkdir -p .plankton
make check
make tauri-dev
```

Keep the desktop window open, then use a second terminal for CLI actions.  
保持 desktop 窗口开着，另开一个终端跑 CLI。

## 🧪 Create a request / 发起请求

The main CLI entry is `get`. `request` is an alias.  
主命令是 `get`，`request` 只是别名。

### Manual review / 纯人工审批

```bash
cargo run -p plankton-cli -- get secret/api-token \
  --reason "Manual smoke test" \
  --requested-by alice \
  --policy-mode manual-only
```

### Assisted review / 模型给建议，人来拍板

```bash
cargo run -p plankton-cli -- get secret/api-token \
  --reason "Assisted review demo" \
  --requested-by alice \
  --policy-mode assisted
```

### Automatic mode / 自动决策模式

```bash
cargo run -p plankton-cli -- get secret/api-token \
  --reason "Auto review demo" \
  --requested-by alice \
  --policy-mode auto
```

You can optionally add `--script-path`, repeated `--call-chain`, repeated `--env`, and repeated `--metadata` when you want richer request context.  
如果你需要更完整的上下文，可以额外带上 `--script-path`、重复的 `--call-chain`、`--env`、`--metadata`。

## 👀 Inspect and decide / 查看与审批

```bash
cargo run -p plankton-cli -- queue
cargo run -p plankton-cli -- status <request-id>
cargo run -p plankton-cli -- suggestion <request-id>
cargo run -p plankton-cli -- audit --limit 20
cargo run -p plankton-cli -- approve <request-id> --note "approved after review"
cargo run -p plankton-cli -- reject <request-id> --note "rejected after review"
```

Use the desktop app as the main approval surface; use CLI for fast inspection, demos, and scripting.  
以 desktop 为主审批入口，CLI 更适合查询、演示和脚本化验证。

## 🔌 Provider setup / Provider 准备

- `manual-only`: no provider setup required.
- `assisted` and `auto`: pick one provider path first.

### OpenAI-compatible

```bash
export PLANKTON_PROVIDER_KIND=openai_compatible
export PLANKTON_OPENAI_API_KEY=...
export PLANKTON_OPENAI_MODEL=...
```

### ACP Codex

```bash
export PLANKTON_PROVIDER_KIND=acp_codex
export PLANKTON_ACP_CODEX_PROGRAM=npx
export PLANKTON_ACP_CODEX_ARGS="-y @zed-industries/codex-acp@0.11.1"
```

### Claude

```bash
export PLANKTON_PROVIDER_KIND=claude
export PLANKTON_CLAUDE_API_KEY=...
export PLANKTON_CLAUDE_MODEL=...
```

If you only want a quick local demo, start with `manual-only`, `openai_compatible`, or `acp_codex`. Claude is available in the repo and currently best treated as an advanced path that needs your own API key.  
如果你只是想先快速体验，建议优先从 `manual-only`、`openai_compatible` 或 `acp_codex` 开始。Claude 路径需要你自己准备 API key。

## 🖥️ Desktop flow / 桌面端怎么用

- Start the app with `make tauri-dev`.
- Submit requests from CLI.
- Review pending items in `Queue`.
- In assisted and automatic flows, inspect `LLM Suggestion`, `Automatic Result`, and provider trace cards in the detail panel.
- Use `Auto Results` to inspect recent resolved automatic outcomes.

## 🤖 Skill for LLMs / 给大模型的 skill

This repo ships with a repo-local skill at [`./.codex/skills/plankton-operator/SKILL.md`](./.codex/skills/plankton-operator/SKILL.md).

Use it when a model should operate Plankton, run local demos, explain commands, or validate manual / assisted / auto flows.  
当你想让大模型直接上手操作、演示或讲解 Plankton 时，就让它读这个 skill。

## 📚 Useful docs / 额外文档

- [`docs/p1-runbook.md`](./docs/p1-runbook.md)
- [`docs/adr/0001-p1-dependency-boundaries.md`](./docs/adr/0001-p1-dependency-boundaries.md)

## 🧭 Principle / 原理

- Every access attempt becomes a structured request first, not an invisible side effect.
- Sensitive context is sanitized before any model sees it.
- The model does not get unlimited control: it produces a suggestion, and local guardrails decide whether the request stays manual, assisted, or can auto-resolve.
- Manual review, assisted suggestions, and automatic outcomes all land in the same audit trail, so the same request can be explained from both CLI and desktop.
- The goal is not “let the model do anything”; the goal is “make access decisions observable, reviewable, and fail-closed.” 🛡️
