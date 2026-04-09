import { invoke } from "@tauri-apps/api/core";

import {
  escapeHtml,
  getDashboardSummary,
  getRequestAuditRecords,
  getResolvedAutoDecisionEntries,
  getSelectedRequest,
  getSuggestionTrace,
  toKeyValueEntries,
  type ResolvedAutoDecisionView,
  type SuggestionTraceView,
} from "./dashboardModel";
import {
  formatDecision,
  formatElapsed,
  formatShortId,
  formatStatus,
  formatTimestamp,
} from "./formatters";
import "./styles.css";
import type {
  AccessRequest,
  AutomaticDecisionTrace,
  AuditRecord,
  DashboardData,
  DecisionCommand,
  LlmSuggestion,
  ProviderTrace,
} from "./types";

const AUTO_REFRESH_MS = 5_000;

type BadgeTone = "pending" | "approved" | "rejected" | "neutral";
type DetailSelection =
  | {
      kind: "pending_request";
      id: string;
    }
  | {
      kind: "resolved_auto";
      id: string;
    }
  | null;

const state: {
  dashboard: DashboardData | null;
  selectedDetail: DetailSelection;
  noteDraft: string;
  errorMessage: string | null;
  lastUpdatedAt: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  isSubmitting: boolean;
  pendingDecision: DecisionCommand | null;
} = {
  dashboard: null,
  selectedDetail: null,
  noteDraft: "",
  errorMessage: null,
  lastUpdatedAt: null,
  isLoading: true,
  isRefreshing: false,
  isSubmitting: false,
  pendingDecision: null,
};

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("Missing #app root");
}

const app: HTMLDivElement = appRoot;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function getDecisionTone(value: string | null): BadgeTone {
  if (value === "allow" || value === "approved") {
    return "approved";
  }

  if (value === "deny" || value === "rejected") {
    return "rejected";
  }

  return "pending";
}

function getUiStateValue(): "loading" | "refreshing" | "submitting" | "ready" {
  if (state.isSubmitting) {
    return "submitting";
  }

  if (state.isRefreshing) {
    return state.dashboard ? "refreshing" : "loading";
  }

  if (state.isLoading) {
    return "loading";
  }

  return "ready";
}

function getSelectedResolvedAutoDecision(
  entries: ResolvedAutoDecisionView[],
  selection: DetailSelection,
): ResolvedAutoDecisionView | null {
  if (selection?.kind !== "resolved_auto") {
    return null;
  }

  return entries.find((entry) => entry.request_id === selection.id) ?? null;
}

function syncSelection(dashboard: DashboardData): void {
  const resolvedAutoEntries = getResolvedAutoDecisionEntries(
    dashboard.recent_audit_records,
  );
  const selectedPendingRequest =
    state.selectedDetail?.kind === "pending_request"
      ? getSelectedRequest(dashboard, state.selectedDetail.id)
      : null;
  const selectedResolvedAuto = getSelectedResolvedAutoDecision(
    resolvedAutoEntries,
    state.selectedDetail,
  );

  if (selectedPendingRequest) {
    state.selectedDetail = {
      kind: "pending_request",
      id: selectedPendingRequest.id,
    };
    return;
  }

  if (selectedResolvedAuto) {
    state.selectedDetail = {
      kind: "resolved_auto",
      id: selectedResolvedAuto.request_id,
    };
    return;
  }

  const firstPendingRequest = dashboard.pending_requests[0];
  if (firstPendingRequest) {
    state.selectedDetail = {
      kind: "pending_request",
      id: firstPendingRequest.id,
    };
    return;
  }

  const firstResolvedAuto = resolvedAutoEntries[0];
  state.selectedDetail = firstResolvedAuto
    ? {
        kind: "resolved_auto",
        id: firstResolvedAuto.request_id,
      }
    : null;
}

function renderBadge(
  label: string,
  tone: BadgeTone,
  options?: {
    testId?: string;
    value?: string | null;
    kind?: string;
  },
): string {
  return `
    <span
      class="badge badge-${tone}"
      ${options?.testId ? `data-testid="${escapeHtml(options.testId)}"` : ""}
      ${options?.value ? `data-value="${escapeHtml(options.value)}"` : ""}
      ${options?.kind ? `data-badge-kind="${escapeHtml(options.kind)}"` : ""}
    >
      ${escapeHtml(label)}
    </span>
  `;
}

function renderKeyValueList(
  values: Record<string, string>,
  testId: string,
): string {
  const entries = toKeyValueEntries(values);
  if (entries.length === 0) {
    return "";
  }

  return `
    <dl class="kv-list" data-testid="${escapeHtml(testId)}">
      ${entries
        .map(
          ([key, value]) => `
            <div
              class="kv-row"
              data-testid="${escapeHtml(testId)}-entry"
              data-key="${escapeHtml(key)}"
            >
              <dt>${escapeHtml(key)}</dt>
              <dd>${escapeHtml(value)}</dd>
            </div>
          `,
        )
        .join("")}
    </dl>
  `;
}

function renderCallChain(callChain: string[]): string {
  if (callChain.length === 0) {
    return "";
  }

  return `
    <ul class="compact-list" data-testid="call-chain-list">
      ${callChain
        .map(
          (step, index) => `
            <li data-testid="call-chain-step" data-step-index="${index}">
              ${escapeHtml(step)}
            </li>
          `,
        )
        .join("")}
    </ul>
  `;
}

function renderAuditList(
  records: AuditRecord[],
  emptyMessage: string,
  testId: string,
): string {
  if (records.length === 0) {
    return `<p class="empty" data-testid="${escapeHtml(testId)}-empty">${escapeHtml(emptyMessage)}</p>`;
  }

  return `
    <div class="audit-list" data-testid="${escapeHtml(testId)}">
      ${records
        .map((record) => {
          const decision =
            typeof record.payload.decision === "string"
              ? record.payload.decision
              : null;
          const tone = decision ? getDecisionTone(decision) : "neutral";

          return `
            <article
              class="audit-row"
              data-testid="${escapeHtml(testId)}-entry"
              data-request-id="${escapeHtml(record.request_id)}"
              data-audit-action="${escapeHtml(record.action)}"
              ${decision ? `data-decision="${escapeHtml(decision)}"` : ""}
            >
              <div
                class="audit-row-main"
                data-testid="${escapeHtml(testId)}-entry-header"
              >
                <div class="audit-row-left">
                  ${renderBadge(formatStatus(record.action), tone, {
                    testId: `${testId}-action-badge`,
                    value: record.action,
                    kind: "audit_action",
                  })}
                  <strong>${escapeHtml(record.actor)}</strong>
                  ${
                    decision
                      ? renderBadge(formatStatus(decision), tone, {
                          testId: `${testId}-decision-badge`,
                          value: decision,
                          kind: "decision",
                        })
                      : ""
                  }
                </div>
                <div
                  class="audit-row-meta"
                  data-testid="${escapeHtml(testId)}-entry-meta"
                >
                  <span>${escapeHtml(formatShortId(record.request_id))}</span>
                  <span>${escapeHtml(
                    formatTimestamp(record.created_at, "Unknown"),
                  )}</span>
                </div>
              </div>
              ${
                record.note
                  ? `<p class="audit-note" data-testid="${escapeHtml(testId)}-entry-note">${escapeHtml(record.note)}</p>`
                  : ""
              }
            </article>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderContextBlock(request: AccessRequest): string {
  const groups: string[] = [];

  if (request.context.script_path) {
    groups.push(`
      <div class="context-group" data-testid="request-script-path-group">
        <span class="context-label">Script</span>
        <div class="context-value" data-testid="request-fact-script-path">
          ${escapeHtml(request.context.script_path)}
        </div>
      </div>
    `);
  }

  const callChain = renderCallChain(request.context.call_chain);
  if (callChain) {
    groups.push(`
      <div class="context-group" data-testid="call-chain-card">
        <span class="context-label">Call Chain</span>
        ${callChain}
      </div>
    `);
  }

  const environment = renderKeyValueList(
    request.context.env_vars,
    "environment-list",
  );
  if (environment) {
    groups.push(`
      <div class="context-group" data-testid="environment-card">
        <span class="context-label" data-testid="environment-count">
          ${Object.keys(request.context.env_vars).length} env
        </span>
        ${environment}
      </div>
    `);
  }

  const metadata = renderKeyValueList(
    request.context.metadata,
    "metadata-list",
  );
  if (metadata) {
    groups.push(`
      <div class="context-group" data-testid="metadata-card">
        <span class="context-label" data-testid="metadata-count">
          ${Object.keys(request.context.metadata).length} metadata
        </span>
        ${metadata}
      </div>
    `);
  }

  if (groups.length === 0) {
    return "";
  }

  return `
    <section
      class="detail-section detail-section-wide"
      data-testid="request-context-card"
    >
      <div class="detail-section-header">
        <h3>Context</h3>
      </div>
      <div class="context-stack">${groups.join("")}</div>
    </section>
  `;
}

function renderPromptBlock(request: AccessRequest): string {
  if (!request.rendered_prompt.trim()) {
    return "";
  }

  return `
    <section
      class="detail-section detail-section-wide detail-section-low"
      data-testid="rendered-prompt-card"
    >
      <div
        class="detail-section-header"
        data-testid="rendered-prompt-card-header"
      >
        <h3>Prompt</h3>
        <span data-testid="rendered-prompt-request-id">
          ${escapeHtml(formatShortId(request.id))}
        </span>
      </div>
      <pre class="payload-block" data-testid="rendered-prompt-content">${escapeHtml(
        request.rendered_prompt,
      )}</pre>
    </section>
  `;
}

function renderSuggestionBlock(suggestion: LlmSuggestion | null): string {
  if (!suggestion) {
    return "";
  }

  const providerLabel = suggestion.provider_model
    ? `${suggestion.provider_kind} / ${suggestion.provider_model}`
    : suggestion.provider_kind;

  const detailParts = [
    providerLabel,
    `template v${suggestion.template_version}`,
    formatTimestamp(suggestion.generated_at, "Unknown"),
  ];

  return `
    <section
      class="detail-section detail-section-accent"
      data-testid="llm-suggestion-card"
    >
      <div
        class="detail-section-header"
        data-testid="llm-suggestion-card-header"
      >
        <h3>Suggestion</h3>
        <span data-testid="llm-suggestion-provider">
          ${escapeHtml(providerLabel)}
        </span>
      </div>
      <div class="badge-row" data-testid="llm-suggestion-badges">
        ${renderBadge(
          formatStatus(suggestion.suggested_decision),
          getDecisionTone(suggestion.suggested_decision),
          {
            testId: "llm-suggestion-decision",
            value: suggestion.suggested_decision,
            kind: "suggested_decision",
          },
        )}
        ${renderBadge(`Risk ${suggestion.risk_score}`, "neutral", {
          testId: "llm-suggestion-risk",
          value: String(suggestion.risk_score),
          kind: "risk_score",
        })}
      </div>
      <p class="suggestion-summary" data-testid="llm-suggestion-rationale">
        ${escapeHtml(suggestion.rationale_summary)}
      </p>
      <div class="suggestion-meta" data-testid="llm-suggestion-meta">
        ${detailParts
          .map(
            (part, index) => `
              <span
                data-testid="llm-suggestion-meta-item"
                data-meta-index="${index}"
              >
                ${escapeHtml(part)}
              </span>
            `,
          )
          .join("")}
      </div>
      ${
        suggestion.error
          ? `
            <p class="suggestion-error" data-testid="llm-suggestion-error">
              ${escapeHtml(suggestion.error)}
            </p>
          `
          : ""
      }
    </section>
  `;
}

function isAcpTrace(
  providerKind: string | null,
  providerTrace: ProviderTrace | null,
): boolean {
  return (
    providerKind === "acp_codex" ||
    providerTrace?.package_name === "@zed-industries/codex-acp" ||
    providerTrace?.transport === "stdio"
  );
}

function renderAcpTraceBlock(traceView: SuggestionTraceView | null): string {
  if (
    !traceView ||
    !isAcpTrace(traceView.provider_kind, traceView.provider_trace)
  ) {
    return "";
  }

  const providerTrace = traceView.provider_trace;
  const packageLabel =
    providerTrace?.package_name && providerTrace?.package_version
      ? `${providerTrace.package_name} ${providerTrace.package_version}`
      : (providerTrace?.package_name ??
        providerTrace?.package_version ??
        "Unknown");

  return `
    <section
      class="detail-section"
      data-testid="acp-provider-trace-card"
      data-provider-kind="${escapeHtml(traceView.provider_kind ?? "")}"
    >
      <div
        class="detail-section-header"
        data-testid="acp-provider-trace-card-header"
      >
        <h3>ACP Trace</h3>
        <span data-testid="acp-provider-model">
          ${escapeHtml(traceView.provider_model ?? "n/a")}
        </span>
      </div>
      <div class="badge-row" data-testid="acp-provider-trace-badges">
        ${renderBadge(traceView.provider_kind ?? "acp_codex", "neutral", {
          testId: "acp-provider-kind",
          value: traceView.provider_kind ?? "acp_codex",
          kind: "provider_kind",
        })}
        ${renderBadge(providerTrace?.transport ?? "unknown", "neutral", {
          testId: "acp-transport",
          value: providerTrace?.transport ?? "unknown",
          kind: "acp_transport",
        })}
        ${
          providerTrace?.package_version
            ? renderBadge(providerTrace.package_version, "neutral", {
                testId: "acp-package-version",
                value: providerTrace.package_version,
                kind: "acp_package_version",
              })
            : ""
        }
      </div>
      <dl class="facts" data-testid="acp-provider-trace-facts">
        <div data-testid="acp-trace-session-id">
          <dt>Session</dt>
          <dd>${escapeHtml(providerTrace?.session_id ?? "n/a")}</dd>
        </div>
        <div data-testid="acp-trace-agent-name">
          <dt>Agent Name</dt>
          <dd>${escapeHtml(providerTrace?.agent_name ?? "n/a")}</dd>
        </div>
        <div data-testid="acp-trace-agent-version">
          <dt>Agent Version</dt>
          <dd>${escapeHtml(providerTrace?.agent_version ?? "n/a")}</dd>
        </div>
        <div data-testid="acp-trace-package">
          <dt>Package</dt>
          <dd>${escapeHtml(packageLabel)}</dd>
        </div>
        <div data-testid="acp-trace-client-request-id">
          <dt>Client Request</dt>
          <dd>${escapeHtml(providerTrace?.client_request_id ?? "n/a")}</dd>
        </div>
      </dl>
    </section>
  `;
}

function isClaudeTrace(
  providerKind: string | null,
  providerTrace: ProviderTrace | null,
): boolean {
  return (
    providerKind === "claude" ||
    providerTrace?.protocol === "anthropic_messages"
  );
}

function renderClaudeTraceBlock(traceView: SuggestionTraceView | null): string {
  if (
    !traceView ||
    !isClaudeTrace(traceView.provider_kind, traceView.provider_trace)
  ) {
    return "";
  }

  const providerTrace = traceView.provider_trace;

  return `
    <section
      class="detail-section"
      data-testid="claude-provider-trace-card"
      data-provider-kind="${escapeHtml(traceView.provider_kind ?? "")}"
    >
      <div
        class="detail-section-header"
        data-testid="claude-provider-trace-card-header"
      >
        <h3>Claude Trace</h3>
        <span data-testid="claude-provider-model">
          ${escapeHtml(traceView.provider_model ?? "n/a")}
        </span>
      </div>
      <div class="badge-row" data-testid="claude-provider-trace-badges">
        ${renderBadge(traceView.provider_kind ?? "claude", "neutral", {
          testId: "claude-provider-kind",
          value: traceView.provider_kind ?? "claude",
          kind: "provider_kind",
        })}
        ${
          providerTrace?.protocol
            ? renderBadge(providerTrace.protocol, "neutral", {
                testId: "claude-protocol",
                value: providerTrace.protocol,
                kind: "protocol",
              })
            : ""
        }
        ${
          providerTrace?.stop_reason
            ? renderBadge(formatStatus(providerTrace.stop_reason), "neutral", {
                testId: "claude-stop-reason",
                value: providerTrace.stop_reason,
                kind: "stop_reason",
              })
            : ""
        }
      </div>
      <dl class="facts" data-testid="claude-provider-trace-facts">
        <div data-testid="claude-trace-response-id">
          <dt>Response</dt>
          <dd>${escapeHtml(traceView.provider_response_id ?? "n/a")}</dd>
        </div>
        <div data-testid="claude-trace-request-id">
          <dt>Request</dt>
          <dd>${escapeHtml(traceView.x_request_id ?? "n/a")}</dd>
        </div>
        <div data-testid="claude-trace-total-tokens">
          <dt>Total Tokens</dt>
          <dd>${escapeHtml(
            traceView.usage_total_tokens === null
              ? "n/a"
              : String(traceView.usage_total_tokens),
          )}</dd>
        </div>
        <div data-testid="claude-trace-api-version">
          <dt>API Version</dt>
          <dd>${escapeHtml(providerTrace?.api_version ?? "n/a")}</dd>
        </div>
        <div data-testid="claude-trace-output-format">
          <dt>Output</dt>
          <dd>${escapeHtml(providerTrace?.output_format ?? "n/a")}</dd>
        </div>
      </dl>
    </section>
  `;
}

function renderAutomaticDecisionBlock(
  automaticDecision: AutomaticDecisionTrace | null,
): string {
  if (!automaticDecision) {
    return "";
  }

  const guardrailHints: string[] = [];
  if (automaticDecision.secret_exposure_risk) {
    guardrailHints.push("secret exposure risk");
  }
  if (automaticDecision.fail_closed) {
    guardrailHints.push("fail closed");
  }

  return `
    <section
      class="detail-section detail-section-wide detail-section-accent"
      data-testid="automatic-decision-card"
      data-auto-disposition="${escapeHtml(automaticDecision.auto_disposition)}"
      data-decision-source="${escapeHtml(automaticDecision.decision_source)}"
    >
      <div
        class="detail-section-header"
        data-testid="automatic-decision-card-header"
      >
        <h3>Automatic Result</h3>
        <span data-testid="automatic-decision-evaluated-at">
          ${escapeHtml(formatTimestamp(automaticDecision.evaluated_at, "Unknown"))}
        </span>
      </div>
      <div class="badge-row" data-testid="automatic-decision-badges">
        ${renderBadge(
          formatStatus(automaticDecision.auto_disposition),
          getDecisionTone(automaticDecision.auto_disposition),
          {
            testId: "automatic-decision-disposition",
            value: automaticDecision.auto_disposition,
            kind: "auto_disposition",
          },
        )}
        ${renderBadge(
          formatStatus(automaticDecision.decision_source),
          "neutral",
          {
            testId: "automatic-decision-source",
            value: automaticDecision.decision_source,
            kind: "decision_source",
          },
        )}
        ${renderBadge(
          automaticDecision.provider_called
            ? "Provider Called"
            : "Provider Skipped",
          automaticDecision.provider_called ? "neutral" : "pending",
          {
            testId: "automatic-decision-provider-called",
            value: String(automaticDecision.provider_called),
            kind: "provider_called",
          },
        )}
        ${
          automaticDecision.secret_exposure_risk
            ? renderBadge("Secret Exposure Risk", "rejected", {
                testId: "automatic-decision-secret-exposure-risk",
                value: "true",
                kind: "guardrail",
              })
            : ""
        }
      </div>
      <p
        class="automatic-summary"
        data-testid="automatic-decision-rationale"
      >
        ${escapeHtml(automaticDecision.auto_rationale_summary)}
      </p>
      ${
        automaticDecision.matched_rule_ids.length > 0
          ? `
            <p
              class="automatic-rules"
              data-testid="automatic-decision-matched-rules"
            >
              ${escapeHtml(automaticDecision.matched_rule_ids.join(", "))}
            </p>
          `
          : ""
      }
      ${
        guardrailHints.length > 0
          ? `
            <p
              class="automatic-hints"
              data-testid="automatic-decision-guardrails"
            >
              ${escapeHtml(guardrailHints.join(" | "))}
            </p>
          `
          : ""
      }
    </section>
  `;
}

function getResolvedAutoTitle(entry: ResolvedAutoDecisionView): string {
  return entry.resource ?? `Request ${formatShortId(entry.request_id)}`;
}

function renderQueue(selectedRequestId: string | null): string {
  if (state.isLoading && !state.dashboard) {
    return '<p class="empty" data-testid="pending-queue-loading">Loading queue</p>';
  }

  if (!state.dashboard || state.dashboard.pending_requests.length === 0) {
    return '<p class="empty" data-testid="pending-queue-empty">No pending requests</p>';
  }

  return state.dashboard.pending_requests
    .map((request) => {
      const isActive = request.id === selectedRequestId;

      return `
        <button
          class="queue-item ${isActive ? "active" : ""}"
          data-select-request="${escapeHtml(request.id)}"
          data-testid="queue-item"
          data-request-id="${escapeHtml(request.id)}"
          data-selected="${isActive ? "true" : "false"}"
          aria-pressed="${isActive ? "true" : "false"}"
          aria-label="Select request ${escapeHtml(request.id)}"
          type="button"
        >
          <div class="queue-item-header" data-testid="queue-item-header">
            <strong>${escapeHtml(request.context.resource)}</strong>
            ${renderBadge(formatStatus(request.approval_status), "pending", {
              testId: "queue-item-status",
              value: request.approval_status,
              kind: "approval_status",
            })}
          </div>
          <p class="queue-item-reason">${escapeHtml(request.context.reason)}</p>
          <div class="queue-item-meta" data-testid="queue-item-meta">
            <span>${escapeHtml(request.context.requested_by)}</span>
            <span>${escapeHtml(formatElapsed(request.created_at))}</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderResolvedAutoList(
  entries: ResolvedAutoDecisionView[],
  selectedRequestId: string | null,
): string {
  if (entries.length === 0) {
    return '<p class="empty" data-testid="resolved-auto-results-empty">No recent auto results</p>';
  }

  return entries
    .map((entry) => {
      const isActive = entry.request_id === selectedRequestId;
      const secondaryText =
        entry.reason ?? entry.automatic_decision.auto_rationale_summary;

      return `
        <button
          class="queue-item ${isActive ? "active" : ""}"
          data-select-auto-result="${escapeHtml(entry.request_id)}"
          data-testid="resolved-auto-item"
          data-request-id="${escapeHtml(entry.request_id)}"
          data-selected="${isActive ? "true" : "false"}"
          aria-pressed="${isActive ? "true" : "false"}"
          aria-label="Select automatic result ${escapeHtml(entry.request_id)}"
          type="button"
        >
          <div class="queue-item-header" data-testid="resolved-auto-item-header">
            <strong>${escapeHtml(getResolvedAutoTitle(entry))}</strong>
            ${renderBadge(
              formatStatus(entry.automatic_decision.auto_disposition),
              getDecisionTone(entry.automatic_decision.auto_disposition),
              {
                testId: "resolved-auto-item-status",
                value: entry.automatic_decision.auto_disposition,
                kind: "auto_disposition",
              },
            )}
          </div>
          ${
            secondaryText
              ? `<p class="queue-item-reason" data-testid="resolved-auto-item-summary">${escapeHtml(
                  secondaryText,
                )}</p>`
              : ""
          }
          <div class="queue-item-meta" data-testid="resolved-auto-item-meta">
            <span>${escapeHtml(entry.requested_by ?? "system")}</span>
            <span>${escapeHtml(formatElapsed(entry.recorded_at))}</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderRequestDetail(selectedRequest: AccessRequest | null): string {
  if (!selectedRequest) {
    return `
      <div class="detail-empty-state" data-testid="request-detail-empty-state">
        <h2>No pending request</h2>
      </div>
    `;
  }

  const selectedAuditRecords = getRequestAuditRecords(
    state.dashboard?.recent_audit_records ?? [],
    selectedRequest.id,
  );
  const approveLabel =
    state.pendingDecision === "approve_request" ? "Approving..." : "Approve";
  const rejectLabel =
    state.pendingDecision === "reject_request" ? "Rejecting..." : "Reject";
  const suggestionTrace = selectedRequest.llm_suggestion
    ? {
        provider_kind: selectedRequest.llm_suggestion.provider_kind,
        provider_model: selectedRequest.llm_suggestion.provider_model,
        provider_response_id:
          selectedRequest.llm_suggestion.provider_response_id,
        x_request_id: selectedRequest.llm_suggestion.x_request_id,
        usage_total_tokens:
          selectedRequest.llm_suggestion.usage?.total_tokens ?? null,
        provider_trace: selectedRequest.llm_suggestion.provider_trace,
      }
    : null;

  return `
    <div class="detail-header" data-testid="request-detail-header">
      <div class="detail-title-group">
        <h2>${escapeHtml(selectedRequest.context.resource)}</h2>
        <p class="detail-reason" data-testid="request-reason">
          ${escapeHtml(selectedRequest.context.reason)}
        </p>
        <div class="detail-meta" data-testid="request-detail-overview">
          <span data-testid="request-requester">
            ${escapeHtml(selectedRequest.context.requested_by)}
          </span>
          <span data-testid="request-opened-at">
            ${escapeHtml(formatElapsed(selectedRequest.created_at))}
          </span>
          <span class="id-pill" data-testid="request-id-pill">
            ${escapeHtml(formatShortId(selectedRequest.id))}
          </span>
        </div>
      </div>
      <div class="badge-row" data-testid="request-detail-badges">
        ${renderBadge(
          formatStatus(selectedRequest.approval_status),
          "pending",
          {
            testId: "request-approval-status",
            value: selectedRequest.approval_status,
            kind: "approval_status",
          },
        )}
        ${renderBadge(
          formatDecision(selectedRequest.final_decision),
          getDecisionTone(selectedRequest.final_decision),
          {
            testId: "request-final-decision",
            value: selectedRequest.final_decision,
            kind: "final_decision",
          },
        )}
      </div>
    </div>

    <div class="detail-grid">
      ${renderAutomaticDecisionBlock(selectedRequest.automatic_decision)}

      <section
        class="detail-section"
        data-testid="review-decision-card"
      >
        <div
          class="detail-section-header"
          data-testid="review-decision-card-header"
        >
          <h3>Decision</h3>
          <span data-testid="review-sync-timestamp">
            ${escapeHtml(formatTimestamp(state.lastUpdatedAt, "Pending sync"))}
          </span>
        </div>
        <label class="field-label" for="decisionNote">Note</label>
        <textarea
          id="decisionNote"
          class="note-field"
          data-testid="decision-note-input"
          placeholder="Optional note"
          aria-label="Audit note"
          ${state.isSubmitting ? "disabled" : ""}
        >${escapeHtml(state.noteDraft)}</textarea>
        <div class="actions" data-testid="decision-actions">
          <button
            id="approveButton"
            class="primary"
            data-decision="approve_request"
            data-request-id="${escapeHtml(selectedRequest.id)}"
            data-testid="approve-request-button"
            aria-label="Approve selected request"
            type="button"
            ${state.isSubmitting ? "disabled" : ""}
          >
            ${approveLabel}
          </button>
          <button
            id="rejectButton"
            class="danger"
            data-decision="reject_request"
            data-request-id="${escapeHtml(selectedRequest.id)}"
            data-testid="reject-request-button"
            aria-label="Reject selected request"
            type="button"
            ${state.isSubmitting ? "disabled" : ""}
          >
            ${rejectLabel}
          </button>
        </div>
      </section>

      <section
        class="detail-section"
        data-testid="request-facts-card"
      >
        <div
          class="detail-section-header"
          data-testid="request-facts-card-header"
        >
          <h3>Summary</h3>
          <span
            data-testid="request-policy-mode"
            data-value="${escapeHtml(selectedRequest.policy_mode)}"
          >
            ${escapeHtml(formatStatus(selectedRequest.policy_mode))}
          </span>
        </div>
        <dl class="facts" data-testid="request-facts-list">
          <div data-testid="request-fact-created">
            <dt>Created</dt>
            <dd>${escapeHtml(formatTimestamp(selectedRequest.created_at, "Unknown"))}</dd>
          </div>
          <div data-testid="request-fact-resolved">
            <dt>Resolved</dt>
            <dd>${escapeHtml(formatTimestamp(selectedRequest.resolved_at))}</dd>
          </div>
          <div data-testid="request-provider-kind">
            <dt>Provider</dt>
            <dd>${escapeHtml(selectedRequest.provider_kind ?? "n/a")}</dd>
          </div>
          <div data-testid="request-fact-updated">
            <dt>Updated</dt>
            <dd>${escapeHtml(formatTimestamp(selectedRequest.updated_at, "Unknown"))}</dd>
          </div>
        </dl>
      </section>

      ${renderSuggestionBlock(selectedRequest.llm_suggestion)}
      ${renderAcpTraceBlock(suggestionTrace)}
      ${renderClaudeTraceBlock(suggestionTrace)}
      ${renderContextBlock(selectedRequest)}

      <section
        class="detail-section detail-section-wide"
        data-testid="request-audit-card"
      >
        <div
          class="detail-section-header"
          data-testid="request-audit-card-header"
        >
          <h3>Request Audit</h3>
          <span data-testid="request-audit-count">
            ${selectedAuditRecords.length} event(s)
          </span>
        </div>
        ${renderAuditList(
          selectedAuditRecords,
          "No request audit",
          "request-audit-list",
        )}
      </section>

      ${renderPromptBlock(selectedRequest)}
    </div>
  `;
}

function renderResolvedAutoDetail(
  selectedResult: ResolvedAutoDecisionView | null,
): string {
  if (!selectedResult) {
    return `
      <div class="detail-empty-state" data-testid="request-detail-empty-state">
        <h2>No pending request</h2>
      </div>
    `;
  }

  const selectedAuditRecords = getRequestAuditRecords(
    state.dashboard?.recent_audit_records ?? [],
    selectedResult.request_id,
  );
  const providerLabel = selectedResult.automatic_decision.provider_called
    ? selectedResult.automatic_decision.provider_model
      ? `${selectedResult.automatic_decision.provider_kind ?? "provider"} / ${selectedResult.automatic_decision.provider_model}`
      : (selectedResult.automatic_decision.provider_kind ?? "provider")
    : "Skipped";
  const decisionValue =
    selectedResult.final_decision ??
    selectedResult.automatic_decision.auto_disposition;
  const statusValue =
    selectedResult.approval_status ??
    selectedResult.automatic_decision.auto_disposition;
  const summaryText =
    selectedResult.reason ??
    selectedResult.automatic_decision.auto_rationale_summary;
  const suggestionTrace = getSuggestionTrace(selectedAuditRecords);

  return `
    <div class="detail-header" data-testid="resolved-auto-detail-header">
      <div class="detail-title-group">
        <h2>${escapeHtml(getResolvedAutoTitle(selectedResult))}</h2>
        ${
          summaryText
            ? `<p class="detail-reason" data-testid="resolved-auto-reason">${escapeHtml(
                summaryText,
              )}</p>`
            : ""
        }
        <div class="detail-meta" data-testid="resolved-auto-detail-overview">
          <span data-testid="resolved-auto-requester">
            ${escapeHtml(selectedResult.requested_by ?? "system")}
          </span>
          <span data-testid="resolved-auto-recorded-at">
            ${escapeHtml(formatElapsed(selectedResult.recorded_at))}
          </span>
          <span class="id-pill" data-testid="resolved-auto-request-id-pill">
            ${escapeHtml(formatShortId(selectedResult.request_id))}
          </span>
        </div>
      </div>
      <div class="badge-row" data-testid="resolved-auto-detail-badges">
        ${renderBadge(formatStatus(statusValue), getDecisionTone(statusValue), {
          testId: "resolved-auto-approval-status",
          value: statusValue,
          kind: "approval_status",
        })}
        ${renderBadge(
          formatDecision(decisionValue),
          getDecisionTone(decisionValue),
          {
            testId: "resolved-auto-final-decision",
            value: decisionValue,
            kind: "final_decision",
          },
        )}
      </div>
    </div>

    <div class="detail-grid">
      ${renderAutomaticDecisionBlock(selectedResult.automatic_decision)}

      <section
        class="detail-section"
        data-testid="resolved-auto-summary-card"
      >
        <div
          class="detail-section-header"
          data-testid="resolved-auto-summary-card-header"
        >
          <h3>Summary</h3>
          <span data-testid="resolved-auto-decision-source">
            ${escapeHtml(formatStatus(selectedResult.automatic_decision.decision_source))}
          </span>
        </div>
        <dl class="facts" data-testid="resolved-auto-facts-list">
          <div data-testid="resolved-auto-fact-submitted">
            <dt>Submitted</dt>
            <dd>${escapeHtml(formatTimestamp(selectedResult.submitted_at, "Unknown"))}</dd>
          </div>
          <div data-testid="resolved-auto-fact-recorded">
            <dt>Recorded</dt>
            <dd>${escapeHtml(formatTimestamp(selectedResult.recorded_at, "Unknown"))}</dd>
          </div>
          <div data-testid="resolved-auto-fact-provider">
            <dt>Provider</dt>
            <dd>${escapeHtml(providerLabel)}</dd>
          </div>
          <div data-testid="resolved-auto-fact-guardrail">
            <dt>Guardrail</dt>
            <dd>${escapeHtml(
              selectedResult.automatic_decision.secret_exposure_risk
                ? "Secret exposure risk"
                : "n/a",
            )}</dd>
          </div>
        </dl>
      </section>

      ${renderAcpTraceBlock(suggestionTrace)}
      ${renderClaudeTraceBlock(suggestionTrace)}

      <section
        class="detail-section detail-section-wide"
        data-testid="resolved-auto-audit-card"
      >
        <div
          class="detail-section-header"
          data-testid="resolved-auto-audit-card-header"
        >
          <h3>Request Audit</h3>
          <span data-testid="resolved-auto-audit-count">
            ${selectedAuditRecords.length} event(s)
          </span>
        </div>
        ${renderAuditList(
          selectedAuditRecords,
          "No request audit",
          "resolved-auto-audit-list",
        )}
      </section>
    </div>
  `;
}

function render(): void {
  const resolvedAutoEntries = getResolvedAutoDecisionEntries(
    state.dashboard?.recent_audit_records ?? [],
  );
  const selectedRequest = getSelectedRequest(
    state.dashboard,
    state.selectedDetail?.kind === "pending_request"
      ? state.selectedDetail.id
      : null,
  );
  const selectedResolvedAuto = getSelectedResolvedAutoDecision(
    resolvedAutoEntries,
    state.selectedDetail,
  );
  const summary = getDashboardSummary(state.dashboard);
  const detailHtml = selectedResolvedAuto
    ? renderResolvedAutoDetail(selectedResolvedAuto)
    : renderRequestDetail(selectedRequest);

  app.innerHTML = `
    <main
      class="shell"
      data-testid="approval-console"
      data-ui-state="${getUiStateValue()}"
      aria-busy="${
        state.isLoading || state.isRefreshing || state.isSubmitting
          ? "true"
          : "false"
      }"
    >
      <header class="toolbar" data-testid="console-hero">
        <div class="toolbar-title">
          <h1>Approvals</h1>
          <span
            class="toolbar-count"
            data-testid="pending-queue-count"
            data-queue-count="${summary.pendingCount}"
          >
            ${summary.pendingCount} open
          </span>
        </div>
        <div class="toolbar-actions">
          <div
            class="hero-status"
            data-testid="sync-status"
            data-sync-state="${getUiStateValue()}"
            role="status"
            aria-live="polite"
          >
            ${renderBadge(
              state.isSubmitting
                ? "Submitting"
                : state.isRefreshing
                  ? "Refreshing"
                  : "Ready",
              state.isSubmitting || state.isRefreshing ? "pending" : "neutral",
              {
                testId: "sync-status-badge",
                value: getUiStateValue(),
                kind: "sync_state",
              },
            )}
            <span data-testid="sync-timestamp">
              ${escapeHtml(formatTimestamp(state.lastUpdatedAt, "Waiting"))}
            </span>
          </div>
          <button
            id="refreshButton"
            class="ghost"
            data-testid="refresh-queue-button"
            aria-label="Refresh approval queue"
            type="button"
            ${state.isSubmitting ? "disabled" : ""}
          >
            Refresh
          </button>
        </div>
      </header>

      ${
        state.errorMessage
          ? `
            <section
              class="alert"
              aria-live="polite"
              role="alert"
              data-testid="sync-error-banner"
            >
              <p data-testid="sync-error-message">${escapeHtml(
                state.errorMessage,
              )}</p>
              <button
                id="dismissError"
                class="ghost"
                data-testid="dismiss-error-button"
                aria-label="Dismiss sync error"
                type="button"
              >
                Dismiss
              </button>
            </section>
          `
          : ""
      }

      <section class="workspace-grid" data-testid="workspace-grid">
        <aside class="panel queue-panel" data-testid="pending-queue-panel">
          <div class="panel-stack" data-testid="sidebar-stack">
            <section class="panel-section" data-testid="pending-queue-section">
              <div class="panel-header" data-testid="pending-queue-header">
                <h2>Queue</h2>
                <span data-testid="pending-queue-requester-count">
                  ${summary.pendingCount}
                </span>
              </div>
              <div class="queue-list" data-testid="pending-queue-list">
                ${renderQueue(
                  state.selectedDetail?.kind === "pending_request"
                    ? state.selectedDetail.id
                    : null,
                )}
              </div>
            </section>

            <section
              class="panel-section"
              data-testid="resolved-auto-results-section"
            >
              <div
                class="panel-header"
                data-testid="resolved-auto-results-header"
              >
                <h2>Auto Results</h2>
                <span data-testid="resolved-auto-results-count">
                  ${resolvedAutoEntries.length}
                </span>
              </div>
              <div class="queue-list" data-testid="resolved-auto-results-list">
                ${renderResolvedAutoList(
                  resolvedAutoEntries,
                  state.selectedDetail?.kind === "resolved_auto"
                    ? state.selectedDetail.id
                    : null,
                )}
              </div>
            </section>
          </div>
        </aside>

        <section
          class="panel detail-panel"
          data-testid="request-detail-panel"
          data-selected-request-id="${escapeHtml(
            selectedRequest?.id ?? selectedResolvedAuto?.request_id ?? "",
          )}"
          data-detail-kind="${state.selectedDetail?.kind ?? "empty"}"
          data-policy-mode="${escapeHtml(selectedRequest?.policy_mode ?? "")}"
        >
          ${detailHtml}
        </section>
      </section>

      <section class="panel audit-panel" data-testid="global-audit-panel">
        <div class="panel-header" data-testid="global-audit-header">
          <h2>Audit</h2>
          <span data-testid="global-audit-count">${summary.auditCount}</span>
        </div>
        ${renderAuditList(
          state.dashboard?.recent_audit_records ?? [],
          "No audit events",
          "global-audit-list",
        )}
      </section>
    </main>
  `;

  bindEvents();
}

function bindEvents(): void {
  document.querySelector("#refreshButton")?.addEventListener("click", () => {
    void loadDashboard();
  });

  document.querySelector("#dismissError")?.addEventListener("click", () => {
    state.errorMessage = null;
    render();
  });

  document
    .querySelectorAll<HTMLButtonElement>("[data-select-request]")
    .forEach((element) => {
      element.addEventListener("click", () => {
        state.selectedDetail = element.dataset.selectRequest
          ? {
              kind: "pending_request",
              id: element.dataset.selectRequest,
            }
          : null;
        state.noteDraft = "";
        render();
      });
    });

  document
    .querySelectorAll<HTMLButtonElement>("[data-select-auto-result]")
    .forEach((element) => {
      element.addEventListener("click", () => {
        state.selectedDetail = element.dataset.selectAutoResult
          ? {
              kind: "resolved_auto",
              id: element.dataset.selectAutoResult,
            }
          : null;
        state.noteDraft = "";
        render();
      });
    });

  document
    .querySelector<HTMLTextAreaElement>("#decisionNote")
    ?.addEventListener("input", (event) => {
      state.noteDraft = (event.currentTarget as HTMLTextAreaElement).value;
    });

  document
    .querySelectorAll<HTMLButtonElement>("[data-decision]")
    .forEach((element) => {
      element.addEventListener("click", () => {
        const requestId = element.dataset.requestId;
        const decision = element.dataset.decision as
          | DecisionCommand
          | undefined;

        if (
          requestId &&
          (decision === "approve_request" || decision === "reject_request")
        ) {
          void decide(requestId, decision);
        }
      });
    });
}

async function loadDashboard(): Promise<void> {
  state.isLoading = state.dashboard === null;
  state.isRefreshing = true;
  state.errorMessage = null;
  render();

  try {
    const dashboard = await invoke<DashboardData>("dashboard");
    state.dashboard = dashboard;
    syncSelection(dashboard);
    state.lastUpdatedAt = new Date().toISOString();
  } catch (error) {
    state.errorMessage = getErrorMessage(error);
  } finally {
    state.isLoading = false;
    state.isRefreshing = false;
    render();
  }
}

async function decide(
  requestId: string,
  decision: DecisionCommand,
): Promise<void> {
  const selectedRequest = getSelectedRequest(state.dashboard, requestId);
  const action = decision === "approve_request" ? "Approve" : "Reject";

  if (
    !window.confirm(
      `${action} ${selectedRequest?.context.resource ?? requestId}?`,
    )
  ) {
    return;
  }

  state.isSubmitting = true;
  state.pendingDecision = decision;
  state.errorMessage = null;
  render();

  try {
    await invoke(decision, {
      requestId,
      note: state.noteDraft.trim() || null,
    });
    state.noteDraft = "";
    await loadDashboard();
  } catch (error) {
    state.errorMessage = getErrorMessage(error);
  } finally {
    state.isSubmitting = false;
    state.pendingDecision = null;
    render();
  }
}

render();
void loadDashboard();
window.setInterval(() => {
  void loadDashboard();
}, AUTO_REFRESH_MS);
