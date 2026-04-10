# P1 Runbook

This runbook is the command-level path for validating the current P1 scope.

The accepted primary flow is:

```text
CLI get -> desktop approve/reject -> CLI status/suggestion/audit
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

### 2. Create a pending request

From another terminal:

```bash
cargo run -p plankton -- get secret/api-key \
  --reason "Need local smoke test access" \
  --requested-by alice \
  --script-path scripts/smoke.sh \
  --call-chain scripts/smoke.sh \
  --metadata environment=dev
```

Expected result:

- the CLI prints JSON for the new request
- the JSON includes a request `id`
- `approval_status` is `pending`
- `final_decision` is `null`

### 3. Verify the request is pending

Use the CLI:

```bash
cargo run -p plankton -- queue
cargo run -p plankton -- status <request-id>
cargo run -p plankton -- suggestion <request-id>
```

Expected result:

- the queue contains the new request
- `status` returns the request plus audit records
- `suggestion` remains part of the read-only inspection surface
- the request is still pending until a desktop decision is recorded

### 4. Approve or reject in the desktop UI

In the Tauri app:

- select the request from the pending queue
- review the detail panel and rendered prompt
- choose `Approve` or `Reject`
- optionally provide an audit note

Expected result:

- the request disappears from the pending queue after resolution
- the recent audit trail shows the action

### 5. Verify the final state from the CLI

Back in the terminal:

```bash
cargo run -p plankton -- status <request-id>
cargo run -p plankton -- audit --limit 20
```

Expected result after approval:

- `approval_status` is `approved`
- `final_decision` is `allow`
- the audit trail contains a submission event and an approval event

Expected result after rejection:

- `approval_status` is `rejected`
- `final_decision` is `deny`
- the audit trail contains a submission event and a rejection event

## Evidence checker should capture

- successful exit for `make fmt-check`, `make check`, `make build`, `make test`, and when needed `make desktop-build`
- CLI JSON showing a newly created request ID
- the same request visible in the desktop queue
- desktop approval or rejection action recorded in the UI
- CLI `status` output after the decision
- CLI `suggestion` output when the checker needs the read-only explanation surface
- CLI `audit` output showing the decision trail

## Current P1 limits

- the live flow is Human Review only
- provider support is intentionally a thin interface plus mock placeholder
- policy modes exist in shared types, but automatic and assisted execution paths are not active
- the CLI surface for P1 is request submission plus read-only inspection, while user-facing approval remains a desktop UI path
