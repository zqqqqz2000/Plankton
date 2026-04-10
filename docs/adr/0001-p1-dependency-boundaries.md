# ADR 0001: P1 Dependency Boundaries And Non-Self-Build Rules

- Status: accepted for P1
- Date: 2026-04-09

## Context

Plankton's product direction is broader than the current repository scope: future phases may add provider-backed evaluation, assisted review, and richer policy automation. P1 is intentionally narrower. It must first prove one local, auditable, human-in-the-loop workflow:

```text
CLI get -> SQLite-backed pending approval -> Tauri desktop approve/reject -> CLI status/suggestion/audit
```

The main engineering constraint for P1 is to avoid inventing generic infrastructure while the product boundary is still moving. Generic concerns should be borrowed from mature Rust and Tauri ecosystem components. Custom code should stay concentrated in the Plankton domain.

## Decision

For P1, Plankton will reuse mature open source components for common infrastructure and limit custom implementation to product-specific behavior.

## Selected Dependencies

| Capability                         | Selected dependency                   | Why this is the default                                                                | Explicit non-self-build boundary                                                      | Plankton-specific custom surface                                                                                                 |
| ---------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Async runtime                      | `tokio`                               | Standard Rust async runtime with broad ecosystem compatibility                         | Do not build a custom executor or async runtime wrapper                               | Approval workflows and background polling behavior                                                                               |
| CLI parsing                        | `clap`                                | Mature derive-based parser with help and subcommand support                            | Do not hand-roll argument parsing or shell completion                                 | Command semantics such as `get`, `status`, `queue`, `suggestion`, and `audit`, plus internal compatibility commands where needed |
| Config loading                     | `config-rs` + `serde` + `directories` | Covers defaults, config file loading, env overrides, and OS-specific config/data paths | Do not build a custom config merger or path locator                                   | Plankton config schema and default keys                                                                                          |
| Logging                            | `tracing` + `tracing-subscriber`      | Standard structured logging path in Rust                                               | Do not build a custom logger or formatting stack                                      | Which request fields are logged, audited, or redacted                                                                            |
| Persistence                        | `sqlx` + SQLite                       | Good fit for local-first P1 persistence, typed queries, built-in migrations            | Do not build a custom ORM, custom migration tool, or custom embedded store            | Request and audit schema, business queries, repository shape                                                                     |
| Serialization                      | `serde` + `serde_json`                | Standard schema and JSON serialization layer                                           | Do not hand-write JSON mapping layers                                                 | Domain object schemas and compatibility between CLI, store, and desktop                                                          |
| Template rendering                 | `MiniJinja`                           | Mature Rust templating and close fit for future prompt rendering                       | Do not create a custom template language or string substitution engine                | Which fields are exposed to templates and how inputs are redacted                                                                |
| Desktop shell                      | `Tauri v2` + `tauri-plugin-log`       | Best fit for a Rust-first local approval console                                       | Do not create desktop shell, windowing, or logging bridge infrastructure from scratch | Approval queue UI, detail view, command contracts                                                                                |
| HTTP baseline for future providers | `reqwest`                             | Standard client for later provider integrations                                        | Do not build a custom HTTP stack or provider transport layer                          | `ProviderAdapter` trait and provider-specific request shaping                                                                    |
| Error handling                     | `thiserror` + `anyhow`                | Clear typed library errors with lightweight shell aggregation                          | Do not build a custom cross-cutting error framework                                   | Product-specific error taxonomy and user-facing error translation                                                                |

## Explicit P1 Non-Self-Build Boundaries

P1 must not introduce custom generic infrastructure for the following:

- CLI parsing
- config loading and layered overrides
- logging and trace plumbing
- JSON serialization
- database engine, ORM, or migration framework
- template language or template execution engine
- desktop application shell infrastructure
- HTTP client stack for future provider calls

If a proposed change adds new custom infrastructure in one of these areas, it should be treated as a design exception and justified before merge.

## Minimal Custom Code That Is Still Required

P1 still needs a small amount of Plankton-specific implementation. That custom surface should remain narrow:

- request, decision, approval, and audit domain models
- approval state transitions and fail-closed behavior
- request context shaping, redaction rules, and prompt input boundaries
- repository methods that encode Plankton's request and audit semantics
- Tauri command glue between the desktop UI and the store
- CLI output that exposes stable, checker-friendly observable fields for read-only inspection while the desktop UI remains the human approval surface

## Deferred Decisions

The following are intentionally deferred beyond P1:

- real OpenAI, Anthropic, and ACP adapters
- automatic LLM decisioning
- policy DSL or automated rules engine wiring
- remote service mode, multi-user approvals, or central control plane

When policy automation becomes active, the starting point should be a mature external policy engine rather than a custom DSL. The current direction is to evaluate `cedar-policy` first, but it is not a P1 runtime dependency yet.

## Consequences

This decision keeps P1 focused on proving the approval and audit backbone while preserving room to grow into later provider and policy phases. It also keeps the product boundary clear: Human Review happens in the desktop UI, while the CLI serves as the request and read-only inspection surface for operators and LLMs.
