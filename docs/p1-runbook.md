# P1 Runbook

This runbook is the command-level path for validating the current P1 scope.

The accepted primary flow is:

```text
CLI list/search -> CLI get -> desktop approve/reject when needed
```

## Prerequisites

- Rust toolchain available locally
- Node.js and npm available locally
- Tauri system prerequisites installed for the current OS

## Unified commands

Use the fixed P1 entrypoints:

```bash
make check
make build
make test
make tauri-dev
```

Optional desktop packaging command:

```bash
make desktop-build
```

## Recommended local setup

Install frontend dependencies once before the first local run:

```bash
make install
```

Use a fixed SQLite path for repeatable manual testing:

```bash
export PLANKTON_DATABASE_URL="sqlite:///abs/path/.plankton/e2e.db"
mkdir -p .plankton
```

This avoids mixing acceptance runs with the default OS-specific application data directory.

## Baseline validation

Before exercising the workflow, run:

```bash
make fmt-check
make check
make build
make test
```

Expected result:

- all commands exit successfully
- `cargo check --workspace` is covered by `make check`
- `cargo build --workspace` and the frontend build are covered by `make build`
- `cargo test --workspace` and frontend tests are covered by `make test`

## Human Review flow

### 1. Start the desktop app

From the repository root:

```bash
make tauri-dev
```

Keep the desktop app running.

### 2. List or search available resource identifiers

From another terminal:

```bash
cargo run -p plankton -- list
```

Expected result:

- the CLI prints resource identifiers and minimal metadata only
- no secret value is printed

If you want to narrow that same view before requesting one resource:

```bash
cargo run -p plankton -- search api-key
```

Expected result:

- the CLI returns a filtered subset of the same identifier view used by `list`
- matching is fuzzy on the resource identifier
- no secret value is printed

### 3. Request one resource

From another terminal:

```bash
cargo run -p plankton -- get secret/api-key \
  --reason "Need local smoke test access" \
  --requested-by alice \
  --metadata environment=dev
```

Expected result:

- Plankton automatically captures the runtime call chain during request submission
- if the request needs review, Plankton hands off to the desktop UI and keeps the request pending until a final decision is recorded
- on `allow + resolve value success`, default text `stdout` prints only the raw secret value
- if you run the same command with `--output json`, the result is a minimal `get` envelope rather than a full request or audit dump
- the resolved value comes from the local secret catalog runtime resolver, not from SQLite, audit records, or provider payloads
- `deny`, `pending`, or resolver errors keep `stdout` empty and report status or errors separately

### 4. Approve or reject in the desktop UI when review is required

In the Tauri app:

- select the request from the pending queue
- review the detail panel and rendered prompt
- choose `Approve` or `Reject`
- optionally provide an audit note

Expected result:

- the request disappears from the pending queue after resolution
- the recent audit trail shows the action

### 5. Verify the final state

Back in the terminal output and desktop UI:

Expected result after approval:

- the terminal prints only the resolved secret value on `stdout`
- the desktop request audit shows the submission event and the approval event

Expected result after rejection:

- the terminal keeps `stdout` empty and reports the failure on `stderr`
- the desktop request audit shows the submission event and the rejection event

## Evidence checker should capture

- successful exit for `make fmt-check`, `make check`, `make build`, `make test`, and when needed `make desktop-build`
- CLI `list` output showing resource identifiers without secret values
- CLI `search` output showing filtered identifiers without secret values
- successful `get` text output showing only one raw value on `stdout`
- `get --output json` showing a minimal value envelope instead of a request/status dump
- the same request visible in the desktop queue
- desktop approval or rejection action recorded in the UI
- desktop detail and request audit views after the decision

## Current P1 limits

- the live flow is Human Review only
- provider support is intentionally a thin interface plus mock placeholder
- policy modes exist in shared types, but automatic and assisted execution paths are not active
- the CLI surface for P1 is resource listing, identifier search, and request submission, while user-facing approval and audit remain desktop UI paths
