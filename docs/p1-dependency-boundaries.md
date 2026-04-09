# P1 Dependency Boundaries

This file is the short index for the P1 documentation set.

Use these two documents as the current source of truth:

- [`docs/adr/0001-p1-dependency-boundaries.md`](adr/0001-p1-dependency-boundaries.md): dependency selection, explicit non-self-build boundaries, and the minimal custom surface that remains in P1
- [`docs/p1-runbook.md`](p1-runbook.md): command-level validation path for `make check / build / test / tauri-dev`, optional `make desktop-build`, and the end-to-end manual approval flow

Short summary:

- Reuse mature infrastructure for CLI parsing, config, logging, storage, templating, HTTP, and desktop shell concerns.
- Keep custom code limited to request models, approval transitions, audit semantics, redaction boundaries, and user-facing workflows.
- Treat provider integration and automated policy execution as deferred work beyond the current P1 repository scope.
