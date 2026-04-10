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
  --script-path scripts/smoke.sh \
  --metadata environment=dev
```

Expected result:

- the CLI prints JSON for the request lifecycle
- the JSON includes a request `id`
- Plankton automatically captures the runtime call chain during request submission
- if the request needs review, Plankton hands off to the desktop UI and keeps the request pending until a final decision is recorded
- when the command returns, the response includes the final `approval_status` and `final_decision`

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

- `approval_status` is `approved`
- `final_decision` is `allow`
- the desktop request audit shows the submission event and the approval event

Expected result after rejection:

- `approval_status` is `rejected`
- `final_decision` is `deny`
- the desktop request audit shows the submission event and the rejection event

## Evidence checker should capture

- successful exit for `make fmt-check`, `make check`, `make build`, `make test`, and when needed `make desktop-build`
- CLI `list` output showing resource identifiers without secret values
- CLI `search` output showing filtered identifiers without secret values
- CLI JSON showing a newly created request ID and final decision fields
- the same request visible in the desktop queue
- desktop approval or rejection action recorded in the UI
- desktop detail and request audit views after the decision

## Current P1 limits

- the live flow is Human Review only
- provider support is intentionally a thin interface plus mock placeholder
- policy modes exist in shared types, but automatic and assisted execution paths are not active
- the CLI surface for P1 is resource listing, identifier search, and request submission, while user-facing approval and audit remain desktop UI paths
