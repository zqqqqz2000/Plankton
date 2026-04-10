# Plankton Operator

Use this skill when you need to explain, demo, or operate Plankton from the local repository.

## Scope

- Start the local desktop UI.
- Explain the operator workflow.
- Use the CLI for access attempts and read-only inspection.
- Explain provider setup for `openai_compatible`, `acp_codex`, and `claude`.
- Keep the product contract aligned with the repository README.

## Contract

- Treat the desktop UI as the policy surface and the human approval surface.
- Treat `Human Review` as the product label for the UI-only human approval mode, not as a recommended CLI approval flow.
- Present the CLI as the operator and LLM entrypoint for `get`, `queue`, `status`, `suggestion`, and `audit`.
- Do not present `approve` or `reject` as the normal user workflow. If they must be mentioned, label them as internal or legacy compatibility paths.
- Keep examples practical and avoid implementation-detail tours unless the user explicitly asks for architecture or code.
- Never expose real secrets in examples. Use placeholders such as `...`.
- Do not claim a provider path is ready unless the required environment variables are present and the current branch has actually verified that path.

## Standard Workflow

1. Work from the repository root.

```bash
cd /Users/jpx/Documents/plankton
```

2. Prepare the local environment.

```bash
make install
export PLANKTON_DATABASE_URL="sqlite://$PWD/.plankton/local.db"
mkdir -p .plankton
make check
```

3. Start the desktop UI.

```bash
make tauri-dev
```

4. Explain the product model before showing commands.

- Strategy configuration happens in the desktop UI.
- Human approval happens in the desktop UI.
- The CLI is for access attempts and read-only inspection around the current UI-configured strategy.

5. Use the CLI for the request and inspection path.

```bash
cargo run -p plankton-cli -- get secret/api-token --reason "Need readonly dev config" --requested-by alice
cargo run -p plankton-cli -- queue
cargo run -p plankton-cli -- status <request-id>
cargo run -p plankton-cli -- suggestion <request-id>
cargo run -p plankton-cli -- audit --limit 20
```

6. If asked about approval, redirect to the UI.

- Say that the desktop UI is the normal human approval path.
- Mention `approve` or `reject` only when the user explicitly asks about legacy or internal repository behavior.

## Provider Setup

### `Human Review`

No provider setup is required. This is the UI-only human approval mode.

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

## Response Order

When a user asks how Plankton works, answer in this order:

1. How to launch the UI.
2. How strategy selection and human approval are handled in the UI.
3. How the CLI is used for `get`, `queue`, `status`, `suggestion`, and `audit`.
4. Which provider path is relevant, if any.
5. Only then explain the principle: sanitize first, guardrails stay authoritative, and every request stays auditable.
