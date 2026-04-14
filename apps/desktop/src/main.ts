import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  escapeHtml,
  getDashboardSummary,
  getRequestAuditRecords,
  getResolvedAutoDecisionEntries,
  getResolvedReviewRequestEntries,
  getSelectedRequest,
  getSuggestionSummary,
  getSuggestionTrace,
  toKeyValueEntries,
  type ResolvedAutoDecisionView,
  type ResolvedReviewRequestView,
  type SuggestionSummaryView,
  type SuggestionTraceView,
} from "./dashboardModel";
import { buildAcpProgramSummary } from "./acpSettings";
import { getPreviewHighlightResult } from "./codePreview";
import { formatElapsed, formatShortId, formatTimestamp } from "./formatters";
import {
  normalizeHandoffRequestId,
  resolvePendingHandoffRequestId,
} from "./handoff";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isLocale,
  t,
  translateCode,
  type Locale,
  type TranslationKey,
} from "./i18n";
import { buildProviderRuntimeSummary } from "./providerRuntime";
import "./styles.css";
import type {
  AccessRequest,
  AutomaticDecisionTrace,
  AuditRecord,
  CallChainEntry,
  DashboardData,
  DesktopSettings,
  DecisionCommand,
  LlmSuggestion,
  ProviderTrace,
} from "./types";

const AUTO_REFRESH_MS = 5_000;
const HANDOFF_EVENT = "plankton://handoff-request";

type BadgeTone = "pending" | "approved" | "rejected" | "neutral";
type HandoffPayload = {
  request_id: string;
};
type PolicyModeValue = "manual_only" | "assisted" | "llm_automatic";
type ProviderKindValue = "openai_compatible" | "claude" | "acp_codex";
type SettingsFieldKey = keyof DesktopSettings;
type DetailSelection =
  | {
      kind: "pending_request";
      id: string;
    }
  | {
      kind: "resolved_request";
      id: string;
    }
  | {
      kind: "resolved_auto";
      id: string;
    }
  | null;

const state: {
  dashboard: DashboardData | null;
  settings: DesktopSettings | null;
  settingsDraft: DesktopSettings | null;
  locale: Locale;
  pendingHandoffRequestId: string | null;
  selectedDetail: DetailSelection;
  noteDraft: string;
  errorMessage: string | null;
  settingsErrorMessage: string | null;
  settingsNoticeMessage: string | null;
  lastUpdatedAt: string | null;
  isLoading: boolean;
  isRefreshing: boolean;
  isSubmitting: boolean;
  isSettingsOpen: boolean;
  isSettingsLoading: boolean;
  isSettingsSaving: boolean;
  pendingDecision: DecisionCommand | null;
} = {
  dashboard: null,
  settings: null,
  settingsDraft: null,
  locale: getInitialLocale(),
  pendingHandoffRequestId: null,
  selectedDetail: null,
  noteDraft: "",
  errorMessage: null,
  settingsErrorMessage: null,
  settingsNoticeMessage: null,
  lastUpdatedAt: null,
  isLoading: true,
  isRefreshing: false,
  isSubmitting: false,
  isSettingsOpen: false,
  isSettingsLoading: false,
  isSettingsSaving: false,
  pendingDecision: null,
};

const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("Missing #app root");
}

const app: HTMLDivElement = appRoot;

function getInitialLocale(): Locale {
  const savedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return isLocale(savedLocale) ? savedLocale : DEFAULT_LOCALE;
}

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

function text(
  key: TranslationKey,
  values?: Record<string, number | string>,
): string {
  return t(state.locale, key, values);
}

function label(value: string): string {
  return translateCode(state.locale, value);
}

function decisionLabel(value: string | null): string {
  return value ? label(value) : label("pending");
}

function timestampLabel(
  value: string | null,
  fallbackKey: TranslationKey = "notResolved",
): string {
  return formatTimestamp(value, text(fallbackKey), state.locale);
}

function elapsedLabel(value: string | null): string {
  return formatElapsed(value, Date.now(), state.locale);
}

function cloneSettings(
  settings: DesktopSettings | null,
): DesktopSettings | null {
  return settings ? { ...settings } : null;
}

function getPolicyModeOptions(): Array<{
  value: PolicyModeValue;
  title: string;
  description: string;
}> {
  return [
    {
      value: "manual_only",
      title: label("manual_only"),
      description: text("policyHumanReviewDesc"),
    },
    {
      value: "assisted",
      title: label("assisted"),
      description: text("policyAssistDesc"),
    },
    {
      value: "llm_automatic",
      title: label("auto"),
      description: text("policyAutomaticDesc"),
    },
  ];
}

function getProviderKindOptions(): Array<{
  value: ProviderKindValue;
  title: string;
  description: string;
}> {
  return [
    {
      value: "openai_compatible",
      title: label("openai_compatible"),
      description: text("providerOpenAiDesc"),
    },
    {
      value: "claude",
      title: label("claude"),
      description: text("providerClaudeDesc"),
    },
    {
      value: "acp_codex",
      title: label("acp_codex"),
      description: text("providerAcpDesc"),
    },
  ];
}

function providerLabelOrFallback(value: string | null): string {
  return value ? label(value) : text("notAvailable");
}

function areSettingsEqual(
  left: DesktopSettings | null,
  right: DesktopSettings | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.locale === right.locale &&
    left.default_policy_mode === right.default_policy_mode &&
    left.provider_kind === right.provider_kind &&
    left.request_template === right.request_template &&
    left.llm_advice_template === right.llm_advice_template &&
    left.openai_api_base === right.openai_api_base &&
    left.openai_api_key === right.openai_api_key &&
    left.openai_model === right.openai_model &&
    left.openai_temperature === right.openai_temperature &&
    left.claude_api_base === right.claude_api_base &&
    left.claude_api_key === right.claude_api_key &&
    left.claude_model === right.claude_model &&
    left.claude_anthropic_version === right.claude_anthropic_version &&
    left.claude_max_tokens === right.claude_max_tokens &&
    left.claude_temperature === right.claude_temperature &&
    left.claude_timeout_secs === right.claude_timeout_secs &&
    left.acp_codex_program === right.acp_codex_program &&
    left.acp_codex_args === right.acp_codex_args &&
    left.acp_timeout_secs === right.acp_timeout_secs
  );
}

function getSettingsFieldLabel(field: SettingsFieldKey): string {
  const labelMap: Record<SettingsFieldKey, TranslationKey> = {
    locale: "settingsInterfaceLocale",
    default_policy_mode: "settingsCurrentPolicy",
    provider_kind: "provider",
    request_template: "settingsRequestTemplate",
    llm_advice_template: "settingsLlmAdviceTemplate",
    openai_api_base: "openAiBase",
    openai_api_key: "openAiApiKey",
    openai_model: "openAiModel",
    openai_temperature: "openAiTemperature",
    claude_api_base: "claudeBase",
    claude_api_key: "claudeApiKey",
    claude_model: "claudeModel",
    claude_anthropic_version: "claudeApiVersion",
    claude_max_tokens: "claudeMaxTokens",
    claude_temperature: "claudeTemperature",
    claude_timeout_secs: "claudeTimeout",
    acp_codex_program: "acpProgram",
    acp_codex_args: "acpArgs",
    acp_timeout_secs: "acpTimeout",
  };

  return text(labelMap[field]);
}

function getOverriddenSettingsFields(
  submitted: DesktopSettings,
  effective: DesktopSettings,
): SettingsFieldKey[] {
  const fields: SettingsFieldKey[] = [
    "locale",
    "default_policy_mode",
    "provider_kind",
    "request_template",
    "llm_advice_template",
    "openai_api_base",
    "openai_api_key",
    "openai_model",
    "openai_temperature",
    "claude_api_base",
    "claude_api_key",
    "claude_model",
    "claude_anthropic_version",
    "claude_max_tokens",
    "claude_temperature",
    "claude_timeout_secs",
    "acp_codex_program",
    "acp_codex_args",
    "acp_timeout_secs",
  ];

  return fields.filter((field) => submitted[field] !== effective[field]);
}

function applyLocale(locale: Locale): void {
  state.locale = locale;
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.documentElement.lang = locale;
  document.title = text("appTitle");
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

function getSelectedResolvedReviewRequest(
  entries: ResolvedReviewRequestView[],
  selection: DetailSelection,
): ResolvedReviewRequestView | null {
  if (selection?.kind !== "resolved_request") {
    return null;
  }

  return entries.find((entry) => entry.request_id === selection.id) ?? null;
}

function syncSelection(dashboard: DashboardData): void {
  const resolvedReviewEntries = getResolvedReviewRequestEntries(
    dashboard.recent_audit_records,
  );
  const resolvedAutoEntries = getResolvedAutoDecisionEntries(
    dashboard.recent_audit_records,
  );
  const handoffRequestId = resolvePendingHandoffRequestId(
    dashboard,
    state.pendingHandoffRequestId,
  );
  if (handoffRequestId) {
    state.selectedDetail = {
      kind: "pending_request",
      id: handoffRequestId,
    };
    state.pendingHandoffRequestId = null;
    return;
  }

  const selectedPendingRequest =
    state.selectedDetail?.kind === "pending_request"
      ? getSelectedRequest(dashboard, state.selectedDetail.id)
      : null;
  const selectedResolvedAuto = getSelectedResolvedAutoDecision(
    resolvedAutoEntries,
    state.selectedDetail,
  );
  const selectedResolvedReview = getSelectedResolvedReviewRequest(
    resolvedReviewEntries,
    state.selectedDetail,
  );

  if (selectedPendingRequest) {
    state.selectedDetail = {
      kind: "pending_request",
      id: selectedPendingRequest.id,
    };
    return;
  }

  if (selectedResolvedReview) {
    state.selectedDetail = {
      kind: "resolved_request",
      id: selectedResolvedReview.request_id,
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

  const firstResolvedReview = resolvedReviewEntries[0];
  if (firstResolvedReview) {
    state.selectedDetail = {
      kind: "resolved_request",
      id: firstResolvedReview.request_id,
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

function queueHandoffRequest(requestId: string | null | undefined): void {
  const normalizedRequestId = normalizeHandoffRequestId(requestId);
  if (!normalizedRequestId) {
    return;
  }

  state.pendingHandoffRequestId = normalizedRequestId;
  state.noteDraft = "";
  state.errorMessage = null;
  render();
  void loadDashboard();
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

function normalizeCallChainEntry(entry: CallChainEntry): {
  path: string;
  processName: string | null;
  executablePath: string | null;
  pid: number | null;
  ppid: number | null;
  argv: string[];
  source: string | null;
  previewable: boolean;
  previewStatus: string | null;
  previewText: string | null;
  previewError: string | null;
} {
  if (typeof entry === "string") {
    return {
      path: entry,
      processName: null,
      executablePath: null,
      pid: null,
      ppid: null,
      argv: [],
      source: "best_effort",
      previewable: false,
      previewStatus: "path_only",
      previewText: null,
      previewError: null,
    };
  }

  return {
    path:
      entry.resolved_file_path ??
      entry.path ??
      entry.executable_path ??
      entry.process_name ??
      text("unknown"),
    processName: entry.process_name ?? null,
    executablePath: entry.executable_path ?? null,
    pid: typeof entry.pid === "number" ? entry.pid : null,
    ppid: typeof entry.ppid === "number" ? entry.ppid : null,
    argv: Array.isArray(entry.argv)
      ? entry.argv.filter((value): value is string => typeof value === "string")
      : [],
    source: entry.source ?? null,
    previewable: entry.previewable === true || Boolean(entry.preview_text),
    previewStatus:
      entry.preview_status ??
      (entry.preview_text ? "preview_ready" : null) ??
      (entry.previewable === false ? "not_previewable" : null),
    previewText: entry.preview_text ?? null,
    previewError: entry.preview_error ?? null,
  };
}

function renderCallChain(callChain: CallChainEntry[]): string {
  if (callChain.length === 0) {
    return `<p class="empty" data-testid="call-chain-empty">${escapeHtml(
      text("noCallChain"),
    )}</p>`;
  }

  return `
    <div class="call-chain-list" data-testid="call-chain-list">
      ${callChain
        .map((step, index) => {
          const entry = normalizeCallChainEntry(step);
          const previewResult = entry.previewText
            ? getPreviewHighlightResult(entry.path, entry.previewText)
            : null;
          const processMeta = entry.processName
            ? `${text("process")}: ${entry.processName}${entry.pid === null ? "" : ` (${entry.pid})`}${entry.ppid === null ? "" : ` → ${entry.ppid}`}`
            : null;
          const metaItems = [
            processMeta,
            entry.executablePath
              ? `${text("executable")}: ${entry.executablePath}`
              : null,
            entry.argv.length > 0
              ? `${text("arguments")}: ${entry.argv.join(" ")}`
              : null,
            entry.source ? `${text("source")}: ${label(entry.source)}` : null,
            entry.previewStatus
              ? `${text("previewStatus")}: ${label(entry.previewStatus)}`
              : null,
          ].filter((value): value is string => Boolean(value));
          return `
            <article class="call-chain-entry" data-testid="call-chain-step" data-step-index="${index}">
              <div class="call-chain-path" data-testid="call-chain-path">${escapeHtml(entry.path)}</div>
              ${
                metaItems.length > 0
                  ? `<div class="call-chain-meta" data-testid="call-chain-step-meta">${metaItems
                      .map(
                        (item, metaIndex) => `
                          <span data-testid="call-chain-meta-item" data-meta-index="${metaIndex}">
                            ${escapeHtml(item)}
                          </span>
                        `,
                      )
                      .join("")}</div>`
                  : ""
              }
              ${
                previewResult
                  ? `
                    <div class="call-chain-preview-header" data-testid="call-chain-preview-header">
                      <span class="context-label">${escapeHtml(text("callChainPreview"))}</span>
                      <span class="call-chain-preview-mode" data-testid="call-chain-preview-mode">
                        ${escapeHtml(
                          previewResult.highlighted
                            ? previewResult.label
                            : text("plainText"),
                        )}
                      </span>
                    </div>
                    <pre class="payload-block payload-code-block call-chain-preview-block" data-testid="call-chain-preview"><code class="payload-code${previewResult.highlighted ? " hljs" : ""}" data-highlighted="${previewResult.highlighted ? "true" : "false"}">${previewResult.html}</code></pre>
                  `
                  : `<p class="empty compact-empty" data-testid="call-chain-preview-empty">${escapeHtml(
                      entry.previewError ??
                        (entry.previewable
                          ? text("previewUnavailable")
                          : label(entry.previewStatus ?? "not_previewable")),
                    )}</p>`
              }
            </article>
          `;
        })
        .join("")}
    </div>
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
                  ${renderBadge(label(record.action), tone, {
                    testId: `${testId}-action-badge`,
                    value: record.action,
                    kind: "audit_action",
                  })}
                  <strong>${escapeHtml(record.actor)}</strong>
                  ${
                    decision
                      ? renderBadge(label(decision), tone, {
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
                  <span>${escapeHtml(timestampLabel(record.created_at, "unknown"))}</span>
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
        <span class="context-label">${escapeHtml(text("script"))}</span>
        <div class="context-value" data-testid="request-fact-script-path">
          ${escapeHtml(request.context.script_path)}
        </div>
      </div>
    `);
  }

  groups.push(`
    <div class="context-group" data-testid="call-chain-card">
      <span class="context-label">${escapeHtml(text("callChain"))}</span>
      ${renderCallChain(request.context.call_chain)}
    </div>
  `);

  const environment = renderKeyValueList(
    request.context.env_vars,
    "environment-list",
  );
  if (environment) {
    groups.push(`
      <div class="context-group" data-testid="environment-card">
        <span class="context-label" data-testid="environment-count">
          ${escapeHtml(
            text("environmentCount", {
              count: Object.keys(request.context.env_vars).length,
            }),
          )}
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
          ${escapeHtml(
            text("metadataCount", {
              count: Object.keys(request.context.metadata).length,
            }),
          )}
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
        <h3>${escapeHtml(text("context"))}</h3>
      </div>
      <div class="context-stack">${groups.join("")}</div>
    </section>
  `;
}

function renderSuggestionBlock(suggestion: LlmSuggestion | null): string {
  if (!suggestion) {
    return "";
  }

  const providerLabel = suggestion.provider_model
    ? `${label(suggestion.provider_kind)} / ${suggestion.provider_model}`
    : label(suggestion.provider_kind);

  const detailParts = [
    providerLabel,
    text("templateVersion", { version: suggestion.template_version }),
    timestampLabel(suggestion.generated_at, "unknown"),
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
        <h3>${escapeHtml(text("suggestion"))}</h3>
        <span data-testid="llm-suggestion-provider">
          ${escapeHtml(providerLabel)}
        </span>
      </div>
      <div class="badge-row" data-testid="llm-suggestion-badges">
        ${renderBadge(
          label(suggestion.suggested_decision),
          getDecisionTone(suggestion.suggested_decision),
          {
            testId: "llm-suggestion-decision",
            value: suggestion.suggested_decision,
            kind: "suggested_decision",
          },
        )}
        ${renderBadge(
          text("riskLabel", { score: suggestion.risk_score }),
          "neutral",
          {
            testId: "llm-suggestion-risk",
            value: String(suggestion.risk_score),
            kind: "risk_score",
          },
        )}
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

function renderResolvedSuggestionBlock(
  suggestion: SuggestionSummaryView | null,
): string {
  if (!suggestion) {
    return "";
  }

  const providerLabel = suggestion.provider_model
    ? `${suggestion.provider_kind ? label(suggestion.provider_kind) : text("provider")} / ${suggestion.provider_model}`
    : suggestion.provider_kind
      ? label(suggestion.provider_kind)
      : text("notAvailable");
  const metaParts = [
    providerLabel,
    suggestion.template_version
      ? text("templateVersion", { version: suggestion.template_version })
      : text("notAvailable"),
    timestampLabel(suggestion.generated_at, "unknown"),
  ];

  return `
    <section
      class="detail-section detail-section-accent"
      data-testid="resolved-review-suggestion-card"
    >
      <div
        class="detail-section-header"
        data-testid="resolved-review-suggestion-card-header"
      >
        <h3>${escapeHtml(text("suggestion"))}</h3>
        <span data-testid="resolved-review-suggestion-provider">
          ${escapeHtml(providerLabel)}
        </span>
      </div>
      <div class="badge-row" data-testid="resolved-review-suggestion-badges">
        ${
          suggestion.suggested_decision
            ? renderBadge(
                label(suggestion.suggested_decision),
                getDecisionTone(suggestion.suggested_decision),
                {
                  testId: "resolved-review-suggestion-decision",
                  value: suggestion.suggested_decision,
                  kind: "suggested_decision",
                },
              )
            : ""
        }
        ${
          suggestion.risk_score === null
            ? ""
            : renderBadge(
                text("riskLabel", { score: suggestion.risk_score }),
                "neutral",
                {
                  testId: "resolved-review-suggestion-risk",
                  value: String(suggestion.risk_score),
                  kind: "risk_score",
                },
              )
        }
      </div>
      ${
        suggestion.rationale_summary
          ? `<p class="suggestion-summary" data-testid="resolved-review-suggestion-rationale">${escapeHtml(
              suggestion.rationale_summary,
            )}</p>`
          : ""
      }
      ${
        suggestion.error
          ? `<p class="suggestion-error" data-testid="resolved-review-suggestion-error">${escapeHtml(
              suggestion.error,
            )}</p>`
          : ""
      }
      <div class="suggestion-meta" data-testid="resolved-review-suggestion-meta">
        ${metaParts
          .map(
            (part, index) => `
              <span
                data-testid="resolved-review-suggestion-meta-item"
                data-meta-index="${index}"
              >
                ${escapeHtml(part)}
              </span>
            `,
          )
          .join("")}
      </div>
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
        text("unknown"));

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
        <h3>${escapeHtml(text("acpTrace"))}</h3>
        <span data-testid="acp-provider-model">
          ${escapeHtml(traceView.provider_model ?? text("notAvailable"))}
        </span>
      </div>
      <div class="badge-row" data-testid="acp-provider-trace-badges">
        ${renderBadge(
          label(traceView.provider_kind ?? "acp_codex"),
          "neutral",
          {
            testId: "acp-provider-kind",
            value: traceView.provider_kind ?? "acp_codex",
            kind: "provider_kind",
          },
        )}
        ${renderBadge(providerTrace?.transport ?? text("unknown"), "neutral", {
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
          <dt>${escapeHtml(text("session"))}</dt>
          <dd>${escapeHtml(providerTrace?.session_id ?? text("notAvailable"))}</dd>
        </div>
        <div data-testid="acp-trace-agent-name">
          <dt>${escapeHtml(text("agentName"))}</dt>
          <dd>${escapeHtml(providerTrace?.agent_name ?? text("notAvailable"))}</dd>
        </div>
        <div data-testid="acp-trace-agent-version">
          <dt>${escapeHtml(text("agentVersion"))}</dt>
          <dd>${escapeHtml(providerTrace?.agent_version ?? text("notAvailable"))}</dd>
        </div>
        <div data-testid="acp-trace-package">
          <dt>${escapeHtml(text("package"))}</dt>
          <dd>${escapeHtml(packageLabel)}</dd>
        </div>
        <div data-testid="acp-trace-client-request-id">
          <dt>${escapeHtml(text("clientRequest"))}</dt>
          <dd>${escapeHtml(
            providerTrace?.client_request_id ?? text("notAvailable"),
          )}</dd>
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
        <h3>${escapeHtml(text("claudeTrace"))}</h3>
        <span data-testid="claude-provider-model">
          ${escapeHtml(traceView.provider_model ?? text("notAvailable"))}
        </span>
      </div>
      <div class="badge-row" data-testid="claude-provider-trace-badges">
        ${renderBadge(label(traceView.provider_kind ?? "claude"), "neutral", {
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
            ? renderBadge(label(providerTrace.stop_reason), "neutral", {
                testId: "claude-stop-reason",
                value: providerTrace.stop_reason,
                kind: "stop_reason",
              })
            : ""
        }
      </div>
      <dl class="facts" data-testid="claude-provider-trace-facts">
        <div data-testid="claude-trace-response-id">
          <dt>${escapeHtml(text("response"))}</dt>
          <dd>${escapeHtml(traceView.provider_response_id ?? text("notAvailable"))}</dd>
        </div>
        <div data-testid="claude-trace-request-id">
          <dt>${escapeHtml(text("request"))}</dt>
          <dd>${escapeHtml(traceView.x_request_id ?? text("notAvailable"))}</dd>
        </div>
        <div data-testid="claude-trace-total-tokens">
          <dt>${escapeHtml(text("totalTokens"))}</dt>
          <dd>${escapeHtml(
            traceView.usage_total_tokens === null
              ? text("notAvailable")
              : String(traceView.usage_total_tokens),
          )}</dd>
        </div>
        <div data-testid="claude-trace-api-version">
          <dt>${escapeHtml(text("apiVersion"))}</dt>
          <dd>${escapeHtml(providerTrace?.api_version ?? text("notAvailable"))}</dd>
        </div>
        <div data-testid="claude-trace-output-format">
          <dt>${escapeHtml(text("output"))}</dt>
          <dd>${escapeHtml(
            providerTrace?.output_format ?? text("notAvailable"),
          )}</dd>
        </div>
      </dl>
    </section>
  `;
}

function renderProviderRuntimeBlock(options: {
  configuredProviderKind: string | null;
  actualProviderKind: string | null;
  providerCalled: boolean | null;
  providerTrace: ProviderTrace | null;
  testIdPrefix: string;
}): string {
  const runtime = buildProviderRuntimeSummary({
    configuredProviderKind: options.configuredProviderKind,
    actualProviderKind: options.actualProviderKind,
    providerCalled: options.providerCalled,
    providerTrace: options.providerTrace,
  });

  const statusMessage = (() => {
    switch (runtime.state) {
      case "active":
        return text("providerStatusActive", {
          provider: providerLabelOrFallback(runtime.actualProviderKind),
        });
      case "configured_not_called":
        return text("providerStatusConfiguredNotCalled", {
          provider: providerLabelOrFallback(runtime.configuredProviderKind),
        });
      case "configured_pending":
        return text("providerStatusConfiguredPending", {
          provider: providerLabelOrFallback(runtime.configuredProviderKind),
        });
      case "configured_overridden":
        return text("providerStatusConfiguredOverridden", {
          configured: providerLabelOrFallback(runtime.configuredProviderKind),
          actual: providerLabelOrFallback(runtime.actualProviderKind),
        });
      case "not_called":
        return text("providerStatusNotCalled");
      case "unavailable":
        return text("providerStatusUnavailable");
    }
  })();
  const traceState = runtime.traceAvailable
    ? text("providerTraceVisible")
    : text("providerTraceMissing");

  return `
    <section
      class="detail-section"
      data-testid="${escapeHtml(options.testIdPrefix)}-provider-runtime-card"
    >
      <div
        class="detail-section-header"
        data-testid="${escapeHtml(options.testIdPrefix)}-provider-runtime-header"
      >
        <h3>${escapeHtml(text("providerRuntime"))}</h3>
        <span data-testid="${escapeHtml(options.testIdPrefix)}-provider-runtime-state">
          ${escapeHtml(providerLabelOrFallback(runtime.actualProviderKind))}
        </span>
      </div>
      <dl class="facts" data-testid="${escapeHtml(options.testIdPrefix)}-provider-runtime-facts">
        <div data-testid="${escapeHtml(options.testIdPrefix)}-configured-provider">
          <dt>${escapeHtml(text("configuredProvider"))}</dt>
          <dd>${escapeHtml(providerLabelOrFallback(runtime.configuredProviderKind))}</dd>
        </div>
        <div data-testid="${escapeHtml(options.testIdPrefix)}-effective-provider">
          <dt>${escapeHtml(text("effectiveProvider"))}</dt>
          <dd>${escapeHtml(providerLabelOrFallback(runtime.actualProviderKind))}</dd>
        </div>
        <div data-testid="${escapeHtml(options.testIdPrefix)}-provider-runtime-status">
          <dt>${escapeHtml(text("providerRuntimeStatus"))}</dt>
          <dd>${escapeHtml(statusMessage)}</dd>
        </div>
        <div data-testid="${escapeHtml(options.testIdPrefix)}-provider-runtime-trace">
          <dt>${escapeHtml(text("providerTraceState"))}</dt>
          <dd>${escapeHtml(traceState)}</dd>
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
    guardrailHints.push(text("secretExposureRisk"));
  }
  if (automaticDecision.fail_closed) {
    guardrailHints.push(text("failClosed"));
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
        <h3>${escapeHtml(text("automaticResult"))}</h3>
        <span data-testid="automatic-decision-evaluated-at">
          ${escapeHtml(timestampLabel(automaticDecision.evaluated_at, "unknown"))}
        </span>
      </div>
      <div class="badge-row" data-testid="automatic-decision-badges">
        ${renderBadge(
          label(automaticDecision.auto_disposition),
          getDecisionTone(automaticDecision.auto_disposition),
          {
            testId: "automatic-decision-disposition",
            value: automaticDecision.auto_disposition,
            kind: "auto_disposition",
          },
        )}
        ${renderBadge(label(automaticDecision.decision_source), "neutral", {
          testId: "automatic-decision-source",
          value: automaticDecision.decision_source,
          kind: "decision_source",
        })}
        ${renderBadge(
          automaticDecision.provider_called
            ? text("providerCalled")
            : text("providerSkipped"),
          automaticDecision.provider_called ? "neutral" : "pending",
          {
            testId: "automatic-decision-provider-called",
            value: String(automaticDecision.provider_called),
            kind: "provider_called",
          },
        )}
        ${
          automaticDecision.secret_exposure_risk
            ? renderBadge(text("secretExposureRisk"), "rejected", {
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
  return (
    entry.resource ?? `${text("request")} ${formatShortId(entry.request_id)}`
  );
}

function getResolvedReviewTitle(entry: ResolvedReviewRequestView): string {
  return (
    entry.resource ?? `${text("request")} ${formatShortId(entry.request_id)}`
  );
}

function renderQueue(selectedRequestId: string | null): string {
  if (state.isLoading && !state.dashboard) {
    return `<p class="empty" data-testid="pending-queue-loading">${escapeHtml(
      text("loadingQueue"),
    )}</p>`;
  }

  if (!state.dashboard || state.dashboard.pending_requests.length === 0) {
    return `<p class="empty" data-testid="pending-queue-empty">${escapeHtml(
      text("noPendingRequests"),
    )}</p>`;
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
          aria-label="${escapeHtml(
            text("selectRequestAria", { id: request.id }),
          )}"
          type="button"
        >
          <div class="queue-item-header" data-testid="queue-item-header">
            <strong>${escapeHtml(request.context.resource)}</strong>
            ${renderBadge(label(request.approval_status), "pending", {
              testId: "queue-item-status",
              value: request.approval_status,
              kind: "approval_status",
            })}
          </div>
          <p class="queue-item-reason">${escapeHtml(request.context.reason)}</p>
          <div class="queue-item-meta" data-testid="queue-item-meta">
            <span>${escapeHtml(request.context.requested_by)}</span>
            <span>${escapeHtml(elapsedLabel(request.created_at))}</span>
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
    return `<p class="empty" data-testid="resolved-auto-results-empty">${escapeHtml(
      text("noRecentAutoResults"),
    )}</p>`;
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
          aria-label="${escapeHtml(
            text("selectAutoResultAria", { id: entry.request_id }),
          )}"
          type="button"
        >
          <div class="queue-item-header" data-testid="resolved-auto-item-header">
            <strong>${escapeHtml(getResolvedAutoTitle(entry))}</strong>
            ${renderBadge(
              label(entry.automatic_decision.auto_disposition),
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
            <span>${escapeHtml(entry.requested_by ?? text("system"))}</span>
            <span>${escapeHtml(elapsedLabel(entry.recorded_at))}</span>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderResolvedReviewList(
  entries: ResolvedReviewRequestView[],
  selectedRequestId: string | null,
): string {
  if (entries.length === 0) {
    return `<p class="empty" data-testid="resolved-review-results-empty">${escapeHtml(
      text("noRecentDecisions"),
    )}</p>`;
  }

  return entries
    .map((entry) => {
      const isActive = entry.request_id === selectedRequestId;

      return `
        <button
          class="queue-item ${isActive ? "active" : ""}"
          data-select-resolved-request="${escapeHtml(entry.request_id)}"
          data-testid="resolved-review-item"
          data-request-id="${escapeHtml(entry.request_id)}"
          data-selected="${isActive ? "true" : "false"}"
          aria-pressed="${isActive ? "true" : "false"}"
          aria-label="${escapeHtml(
            text("selectResolvedRequestAria", { id: entry.request_id }),
          )}"
          type="button"
        >
          <div class="queue-item-header" data-testid="resolved-review-item-header">
            <strong>${escapeHtml(getResolvedReviewTitle(entry))}</strong>
            ${renderBadge(
              decisionLabel(entry.final_decision ?? entry.approval_status),
              getDecisionTone(entry.final_decision ?? entry.approval_status),
              {
                testId: "resolved-review-item-status",
                value: entry.final_decision ?? entry.approval_status,
                kind: "final_decision",
              },
            )}
          </div>
          ${
            entry.reason
              ? `<p class="queue-item-reason" data-testid="resolved-review-item-reason">${escapeHtml(
                  entry.reason,
                )}</p>`
              : ""
          }
          <div class="queue-item-meta" data-testid="resolved-review-item-meta">
            <span>${escapeHtml(entry.requested_by ?? text("system"))}</span>
            <span>${escapeHtml(
              entry.policy_mode
                ? label(entry.policy_mode)
                : text("notAvailable"),
            )}</span>
            <span>${escapeHtml(elapsedLabel(entry.recorded_at))}</span>
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
        <h2>${escapeHtml(text("noPendingRequest"))}</h2>
      </div>
    `;
  }

  const selectedAuditRecords = getRequestAuditRecords(
    state.dashboard?.recent_audit_records ?? [],
    selectedRequest.id,
  );
  const approveLabel =
    state.pendingDecision === "approve_request"
      ? text("approving")
      : text("approve");
  const rejectLabel =
    state.pendingDecision === "reject_request"
      ? text("rejecting")
      : text("reject");
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
  const providerCalled =
    selectedRequest.automatic_decision?.provider_called ??
    (selectedRequest.llm_suggestion ? true : null) ??
    (selectedRequest.policy_mode === "manual_only" ? false : null);
  const actualProviderKind =
    suggestionTrace?.provider_kind ??
    selectedRequest.automatic_decision?.provider_kind ??
    selectedRequest.provider_kind;

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
            ${escapeHtml(elapsedLabel(selectedRequest.created_at))}
          </span>
          <span class="id-pill" data-testid="request-id-pill">
            ${escapeHtml(formatShortId(selectedRequest.id))}
          </span>
        </div>
      </div>
      <div class="badge-row" data-testid="request-detail-badges">
        ${renderBadge(label(selectedRequest.approval_status), "pending", {
          testId: "request-approval-status",
          value: selectedRequest.approval_status,
          kind: "approval_status",
        })}
        ${
          selectedRequest.final_decision
            ? renderBadge(
                decisionLabel(selectedRequest.final_decision),
                getDecisionTone(selectedRequest.final_decision),
                {
                  testId: "request-final-decision",
                  value: selectedRequest.final_decision,
                  kind: "final_decision",
                },
              )
            : ""
        }
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
          <h3>${escapeHtml(text("decision"))}</h3>
          <span data-testid="review-sync-timestamp">
            ${escapeHtml(timestampLabel(state.lastUpdatedAt, "pendingSync"))}
          </span>
        </div>
        <label class="field-label" for="decisionNote">${escapeHtml(
          text("note"),
        )}</label>
        <textarea
          id="decisionNote"
          class="note-field"
          data-testid="decision-note-input"
          placeholder="${escapeHtml(text("notePlaceholder"))}"
          aria-label="${escapeHtml(text("auditNoteAria"))}"
          ${state.isSubmitting ? "disabled" : ""}
        >${escapeHtml(state.noteDraft)}</textarea>
        <div class="actions" data-testid="decision-actions">
          <button
            id="approveButton"
            class="primary"
            data-decision="approve_request"
            data-request-id="${escapeHtml(selectedRequest.id)}"
            data-testid="approve-request-button"
            aria-label="${escapeHtml(text("approveSelectedAria"))}"
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
            aria-label="${escapeHtml(text("rejectSelectedAria"))}"
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
          <h3>${escapeHtml(text("summary"))}</h3>
          <span
            data-testid="request-policy-mode"
            data-value="${escapeHtml(selectedRequest.policy_mode)}"
          >
            ${escapeHtml(label(selectedRequest.policy_mode))}
          </span>
        </div>
        <dl class="facts" data-testid="request-facts-list">
          <div data-testid="request-fact-created">
            <dt>${escapeHtml(text("created"))}</dt>
            <dd>${escapeHtml(timestampLabel(selectedRequest.created_at, "unknown"))}</dd>
          </div>
          <div data-testid="request-fact-resolved">
            <dt>${escapeHtml(text("resolved"))}</dt>
            <dd>${escapeHtml(timestampLabel(selectedRequest.resolved_at))}</dd>
          </div>
          <div data-testid="request-provider-kind">
            <dt>${escapeHtml(text("provider"))}</dt>
            <dd>${escapeHtml(
              selectedRequest.provider_kind
                ? label(selectedRequest.provider_kind)
                : text("notAvailable"),
            )}</dd>
          </div>
          <div data-testid="request-fact-updated">
            <dt>${escapeHtml(text("updated"))}</dt>
            <dd>${escapeHtml(timestampLabel(selectedRequest.updated_at, "unknown"))}</dd>
          </div>
        </dl>
      </section>

      ${renderProviderRuntimeBlock({
        configuredProviderKind: state.settings?.provider_kind ?? null,
        actualProviderKind,
        providerCalled,
        providerTrace: suggestionTrace?.provider_trace ?? null,
        testIdPrefix: "request",
      })}
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
          <h3>${escapeHtml(text("requestAudit"))}</h3>
          <span data-testid="request-audit-count">
            ${escapeHtml(
              text("eventCount", { count: selectedAuditRecords.length }),
            )}
          </span>
        </div>
        ${renderAuditList(
          selectedAuditRecords,
          text("noRequestAudit"),
          "request-audit-list",
        )}
      </section>
    </div>
  `;
}

function renderResolvedAutoDetail(
  selectedResult: ResolvedAutoDecisionView | null,
): string {
  if (!selectedResult) {
    return `
      <div class="detail-empty-state" data-testid="request-detail-empty-state">
        <h2>${escapeHtml(text("noPendingRequest"))}</h2>
      </div>
    `;
  }

  const selectedAuditRecords = getRequestAuditRecords(
    state.dashboard?.recent_audit_records ?? [],
    selectedResult.request_id,
  );
  const providerLabel = selectedResult.automatic_decision.provider_called
    ? selectedResult.automatic_decision.provider_model
      ? `${selectedResult.automatic_decision.provider_kind ? label(selectedResult.automatic_decision.provider_kind) : text("provider")} / ${selectedResult.automatic_decision.provider_model}`
      : selectedResult.automatic_decision.provider_kind
        ? label(selectedResult.automatic_decision.provider_kind)
        : text("provider")
    : text("providerSkipped");
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
  const actualProviderKind =
    suggestionTrace?.provider_kind ??
    selectedResult.automatic_decision.provider_kind;

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
            ${escapeHtml(selectedResult.requested_by ?? text("system"))}
          </span>
          <span data-testid="resolved-auto-recorded-at">
            ${escapeHtml(elapsedLabel(selectedResult.recorded_at))}
          </span>
          <span class="id-pill" data-testid="resolved-auto-request-id-pill">
            ${escapeHtml(formatShortId(selectedResult.request_id))}
          </span>
        </div>
      </div>
      <div class="badge-row" data-testid="resolved-auto-detail-badges">
        ${renderBadge(label(statusValue), getDecisionTone(statusValue), {
          testId: "resolved-auto-approval-status",
          value: statusValue,
          kind: "approval_status",
        })}
        ${renderBadge(
          decisionLabel(decisionValue),
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
          <h3>${escapeHtml(text("summary"))}</h3>
          <span data-testid="resolved-auto-decision-source">
            ${escapeHtml(label(selectedResult.automatic_decision.decision_source))}
          </span>
        </div>
        <dl class="facts" data-testid="resolved-auto-facts-list">
          <div data-testid="resolved-auto-fact-submitted">
            <dt>${escapeHtml(text("submitted"))}</dt>
            <dd>${escapeHtml(timestampLabel(selectedResult.submitted_at, "unknown"))}</dd>
          </div>
          <div data-testid="resolved-auto-fact-recorded">
            <dt>${escapeHtml(text("recorded"))}</dt>
            <dd>${escapeHtml(timestampLabel(selectedResult.recorded_at, "unknown"))}</dd>
          </div>
          <div data-testid="resolved-auto-fact-provider">
            <dt>${escapeHtml(text("provider"))}</dt>
            <dd>${escapeHtml(providerLabel)}</dd>
          </div>
          <div data-testid="resolved-auto-fact-guardrail">
            <dt>${escapeHtml(text("guardrail"))}</dt>
            <dd>${escapeHtml(
              selectedResult.automatic_decision.secret_exposure_risk
                ? text("secretExposureRisk")
                : text("guardrailNone"),
            )}</dd>
          </div>
        </dl>
      </section>

      ${renderProviderRuntimeBlock({
        configuredProviderKind: state.settings?.provider_kind ?? null,
        actualProviderKind,
        providerCalled: selectedResult.automatic_decision.provider_called,
        providerTrace: suggestionTrace?.provider_trace ?? null,
        testIdPrefix: "resolved-auto",
      })}
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
          <h3>${escapeHtml(text("requestAudit"))}</h3>
          <span data-testid="resolved-auto-audit-count">
            ${escapeHtml(
              text("eventCount", { count: selectedAuditRecords.length }),
            )}
          </span>
        </div>
        ${renderAuditList(
          selectedAuditRecords,
          text("noRequestAudit"),
          "resolved-auto-audit-list",
        )}
      </section>
    </div>
  `;
}

function renderResolvedReviewDetail(
  selectedResult: ResolvedReviewRequestView | null,
): string {
  if (!selectedResult) {
    return `
      <div class="detail-empty-state" data-testid="request-detail-empty-state">
        <h2>${escapeHtml(text("noPendingRequest"))}</h2>
      </div>
    `;
  }

  const selectedAuditRecords = getRequestAuditRecords(
    state.dashboard?.recent_audit_records ?? [],
    selectedResult.request_id,
  );
  const suggestionSummary = getSuggestionSummary(selectedAuditRecords);
  const suggestionTrace = getSuggestionTrace(selectedAuditRecords);
  const providerLabel = suggestionSummary?.provider_model
    ? `${suggestionSummary.provider_kind ? label(suggestionSummary.provider_kind) : text("provider")} / ${suggestionSummary.provider_model}`
    : suggestionSummary?.provider_kind
      ? label(suggestionSummary.provider_kind)
      : text("notAvailable");
  const providerCalled =
    suggestionSummary !== null
      ? true
      : selectedResult.policy_mode === "manual_only"
        ? false
        : null;
  const actualProviderKind =
    suggestionTrace?.provider_kind ?? suggestionSummary?.provider_kind ?? null;
  const decisionValue =
    selectedResult.final_decision ?? selectedResult.approval_status;
  const statusValue =
    selectedResult.approval_status ?? selectedResult.final_decision;

  return `
    <div class="detail-header" data-testid="resolved-review-detail-header">
      <div class="detail-title-group">
        <h2>${escapeHtml(getResolvedReviewTitle(selectedResult))}</h2>
        ${
          selectedResult.reason
            ? `<p class="detail-reason" data-testid="resolved-review-reason">${escapeHtml(
                selectedResult.reason,
              )}</p>`
            : ""
        }
        <div class="detail-meta" data-testid="resolved-review-detail-overview">
          <span data-testid="resolved-review-requester">
            ${escapeHtml(selectedResult.requested_by ?? text("system"))}
          </span>
          <span data-testid="resolved-review-recorded-at">
            ${escapeHtml(elapsedLabel(selectedResult.recorded_at))}
          </span>
          <span class="id-pill" data-testid="resolved-review-request-id-pill">
            ${escapeHtml(formatShortId(selectedResult.request_id))}
          </span>
        </div>
      </div>
      <div class="badge-row" data-testid="resolved-review-detail-badges">
        ${renderBadge(
          label(statusValue ?? "pending"),
          getDecisionTone(statusValue),
          {
            testId: "resolved-review-approval-status",
            value: statusValue,
            kind: "approval_status",
          },
        )}
        ${renderBadge(
          decisionLabel(decisionValue),
          getDecisionTone(decisionValue),
          {
            testId: "resolved-review-final-decision",
            value: decisionValue,
            kind: "final_decision",
          },
        )}
      </div>
    </div>

    <div class="detail-grid">
      <section
        class="detail-section"
        data-testid="resolved-review-decision-card"
      >
        <div
          class="detail-section-header"
          data-testid="resolved-review-decision-card-header"
        >
          <h3>${escapeHtml(text("decision"))}</h3>
          <span data-testid="resolved-review-reviewed-by">
            ${escapeHtml(selectedResult.reviewed_by ?? text("notAvailable"))}
          </span>
        </div>
        <dl class="facts" data-testid="resolved-review-decision-facts">
          <div data-testid="resolved-review-fact-submitted">
            <dt>${escapeHtml(text("submitted"))}</dt>
            <dd>${escapeHtml(timestampLabel(selectedResult.submitted_at, "unknown"))}</dd>
          </div>
          <div data-testid="resolved-review-fact-resolved">
            <dt>${escapeHtml(text("resolved"))}</dt>
            <dd>${escapeHtml(timestampLabel(selectedResult.recorded_at, "unknown"))}</dd>
          </div>
        </dl>
        ${
          selectedResult.decision_note
            ? `<p class="suggestion-summary" data-testid="resolved-review-decision-note">${escapeHtml(
                selectedResult.decision_note,
              )}</p>`
            : ""
        }
      </section>

      <section
        class="detail-section"
        data-testid="resolved-review-summary-card"
      >
        <div
          class="detail-section-header"
          data-testid="resolved-review-summary-card-header"
        >
          <h3>${escapeHtml(text("summary"))}</h3>
          <span data-testid="resolved-review-policy-mode">
            ${escapeHtml(
              selectedResult.policy_mode
                ? label(selectedResult.policy_mode)
                : text("notAvailable"),
            )}
          </span>
        </div>
        <dl class="facts" data-testid="resolved-review-facts-list">
          <div data-testid="resolved-review-fact-created">
            <dt>${escapeHtml(text("created"))}</dt>
            <dd>${escapeHtml(timestampLabel(selectedResult.submitted_at, "unknown"))}</dd>
          </div>
          <div data-testid="resolved-review-fact-recorded">
            <dt>${escapeHtml(text("recorded"))}</dt>
            <dd>${escapeHtml(timestampLabel(selectedResult.recorded_at, "unknown"))}</dd>
          </div>
          <div data-testid="resolved-review-fact-provider">
            <dt>${escapeHtml(text("provider"))}</dt>
            <dd>${escapeHtml(providerLabel)}</dd>
          </div>
          <div data-testid="resolved-review-fact-requester">
            <dt>${escapeHtml(text("request"))}</dt>
            <dd>${escapeHtml(selectedResult.requested_by ?? text("notAvailable"))}</dd>
          </div>
        </dl>
      </section>

      ${renderProviderRuntimeBlock({
        configuredProviderKind: state.settings?.provider_kind ?? null,
        actualProviderKind,
        providerCalled,
        providerTrace: suggestionTrace?.provider_trace ?? null,
        testIdPrefix: "resolved-review",
      })}
      ${renderResolvedSuggestionBlock(suggestionSummary)}
      ${renderAcpTraceBlock(suggestionTrace)}
      ${renderClaudeTraceBlock(suggestionTrace)}

      <section
        class="detail-section detail-section-wide"
        data-testid="resolved-review-audit-card"
      >
        <div
          class="detail-section-header"
          data-testid="resolved-review-audit-card-header"
        >
          <h3>${escapeHtml(text("requestAudit"))}</h3>
          <span data-testid="resolved-review-audit-count">
            ${escapeHtml(
              text("eventCount", { count: selectedAuditRecords.length }),
            )}
          </span>
        </div>
        ${renderAuditList(
          selectedAuditRecords,
          text("noRequestAudit"),
          "resolved-review-audit-list",
        )}
      </section>
    </div>
  `;
}

function renderSettingsInput(options: {
  field: SettingsFieldKey;
  labelText: string;
  value: string;
  type: "number" | "password" | "text";
  autoComplete?: string;
  min?: string;
  step?: string;
}): string {
  return `
    <label class="settings-field" data-testid="settings-field-${options.field}">
      <span class="field-label">${escapeHtml(options.labelText)}</span>
      <input
        class="settings-input"
        data-settings-field="${options.field}"
        type="${options.type}"
        value="${escapeHtml(options.value)}"
        ${options.autoComplete ? `autocomplete="${options.autoComplete}"` : ""}
        ${options.min ? `min="${options.min}"` : ""}
        ${options.step ? `step="${options.step}"` : ""}
        ${state.isSettingsLoading || state.isSettingsSaving ? "disabled" : ""}
      />
    </label>
  `;
}

function renderSettingsTextarea(options: {
  field: SettingsFieldKey;
  labelText: string;
  value: string;
}): string {
  return `
    <label class="settings-field settings-field-wide" data-testid="settings-field-${options.field}">
      <span class="field-label">${escapeHtml(options.labelText)}</span>
      <textarea
        class="settings-input note-field"
        data-settings-field="${options.field}"
        rows="3"
        ${state.isSettingsLoading || state.isSettingsSaving ? "disabled" : ""}
      >${escapeHtml(options.value)}</textarea>
    </label>
  `;
}

function renderSettingsModal(): string {
  if (!state.isSettingsOpen) {
    return "";
  }

  const currentPolicyMode =
    state.settingsDraft?.default_policy_mode ??
    state.settings?.default_policy_mode ??
    "manual_only";
  const currentProviderKind =
    state.settingsDraft?.provider_kind ?? state.settings?.provider_kind ?? null;
  const acpSummary = buildAcpProgramSummary(
    state.settingsDraft ?? state.settings,
  );
  const canSaveSettings =
    state.settings !== null &&
    state.settingsDraft !== null &&
    !areSettingsEqual(state.settingsDraft, state.settings) &&
    !state.isSettingsLoading &&
    !state.isSettingsSaving;

  return `
    <div
      class="modal-backdrop"
      data-testid="settings-modal-backdrop"
      role="presentation"
    >
      <section
        class="modal-panel"
        data-testid="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settingsModalTitle"
      >
        <div class="modal-header" data-testid="settings-modal-header">
          <div class="modal-title-group">
            <h2 id="settingsModalTitle">${escapeHtml(text("settingsTitle"))}</h2>
            <div class="settings-pill-row">
              <span class="toolbar-count" data-testid="settings-current-policy">
                ${escapeHtml(
                  `${text("settingsCurrentPolicy")}: ${label(currentPolicyMode)}`,
                )}
              </span>
              <span class="toolbar-count" data-testid="settings-current-provider">
                ${escapeHtml(
                  `${text("settingsCurrentProvider")}: ${providerLabelOrFallback(currentProviderKind)}`,
                )}
              </span>
            </div>
          </div>
          <button
            id="closeSettingsButton"
            class="ghost"
            data-testid="close-settings-button"
            type="button"
            ${state.isSettingsSaving ? "disabled" : ""}
          >
            ${escapeHtml(text("close"))}
          </button>
        </div>

        ${
          state.settingsErrorMessage
            ? `
              <section
                class="alert"
                role="alert"
                data-testid="settings-error-banner"
              >
                <p data-testid="settings-error-message">${escapeHtml(
                  state.settingsErrorMessage,
                )}</p>
              </section>
            `
            : ""
        }

        ${
          state.settingsNoticeMessage
            ? `
              <section
                class="alert"
                role="status"
                data-testid="settings-notice-banner"
              >
                <p data-testid="settings-notice-message">${escapeHtml(
                  state.settingsNoticeMessage,
                )}</p>
              </section>
            `
            : ""
        }

        <div class="modal-grid" data-testid="settings-modal-grid">
          <section class="detail-section" data-testid="settings-policy-section">
            <div class="detail-section-header">
              <h3>${escapeHtml(text("settingsPolicyTitle"))}</h3>
              <span data-testid="settings-policy-status">
                ${escapeHtml(
                  state.isSettingsSaving
                    ? text("saving")
                    : state.isSettingsLoading
                      ? text("syncRefreshing")
                      : text("settingsSavedPolicy"),
                )}
              </span>
            </div>
            <p class="section-copy" data-testid="settings-policy-help">
              ${escapeHtml(text("settingsPolicyHelp"))}
            </p>
            <div class="settings-option-list" data-testid="settings-policy-options">
              ${getPolicyModeOptions()
                .map(
                  (option) => `
                    <label
                      class="settings-option ${
                        currentPolicyMode === option.value ? "active" : ""
                      }"
                      data-testid="settings-policy-option"
                      data-policy-mode="${option.value}"
                    >
                      <input
                        type="radio"
                        name="defaultPolicyMode"
                        value="${option.value}"
                        ${currentPolicyMode === option.value ? "checked" : ""}
                        ${state.isSettingsLoading || state.isSettingsSaving ? "disabled" : ""}
                      />
                      <div class="settings-option-copy">
                        <strong>${escapeHtml(option.title)}</strong>
                        <p>${escapeHtml(option.description)}</p>
                      </div>
                    </label>
                  `,
                )
                .join("")}
            </div>
          </section>

          <section class="detail-section" data-testid="settings-provider-section">
            <div class="detail-section-header">
              <h3>${escapeHtml(text("settingsProviderTitle"))}</h3>
              <span data-testid="settings-provider-status">
                ${escapeHtml(providerLabelOrFallback(currentProviderKind))}
              </span>
            </div>
            <p class="section-copy" data-testid="settings-provider-help">
              ${escapeHtml(text("settingsProviderHelp"))}
            </p>
            <div class="settings-placeholder" data-testid="settings-provider-internal-help">
              <p>${escapeHtml(text("settingsProviderInternalHelp"))}</p>
            </div>
            <div class="settings-option-list" data-testid="settings-provider-options">
              ${getProviderKindOptions()
                .map(
                  (option) => `
                    <label
                      class="settings-option ${
                        currentProviderKind === option.value ? "active" : ""
                      }"
                      data-testid="settings-provider-option"
                      data-provider-kind="${option.value}"
                    >
                      <input
                        type="radio"
                        name="providerKind"
                        value="${option.value}"
                        ${currentProviderKind === option.value ? "checked" : ""}
                        ${state.isSettingsLoading || state.isSettingsSaving ? "disabled" : ""}
                      />
                      <div class="settings-option-copy">
                        <strong>${escapeHtml(option.title)}</strong>
                        <p>${escapeHtml(option.description)}</p>
                      </div>
                    </label>
                  `,
                )
                .join("")}
            </div>
          </section>

          <section class="detail-section" data-testid="settings-openai-section">
            <div class="detail-section-header">
              <h3>${escapeHtml(text("settingsOpenAiTitle"))}</h3>
              <span>${escapeHtml(label("openai_compatible"))}</span>
            </div>
            <p class="section-copy">${escapeHtml(text("providerOpenAiDesc"))}</p>
            <div class="settings-form-grid">
              ${renderSettingsInput({
                field: "openai_api_base",
                labelText: text("openAiBase"),
                value: state.settingsDraft?.openai_api_base ?? "",
                type: "text",
                autoComplete: "url",
              })}
              ${renderSettingsInput({
                field: "openai_api_key",
                labelText: text("openAiApiKey"),
                value: state.settingsDraft?.openai_api_key ?? "",
                type: "password",
                autoComplete: "off",
              })}
              ${renderSettingsInput({
                field: "openai_model",
                labelText: text("openAiModel"),
                value: state.settingsDraft?.openai_model ?? "",
                type: "text",
                autoComplete: "off",
              })}
              ${renderSettingsInput({
                field: "openai_temperature",
                labelText: text("openAiTemperature"),
                value: String(state.settingsDraft?.openai_temperature ?? 0),
                type: "number",
                step: "0.1",
                min: "0",
              })}
            </div>
          </section>

          <section class="detail-section" data-testid="settings-claude-section">
            <div class="detail-section-header">
              <h3>${escapeHtml(text("settingsClaudeTitle"))}</h3>
              <span>${escapeHtml(label("claude"))}</span>
            </div>
            <p class="section-copy">${escapeHtml(text("providerClaudeDesc"))}</p>
            <div class="settings-form-grid">
              ${renderSettingsInput({
                field: "claude_api_base",
                labelText: text("claudeBase"),
                value: state.settingsDraft?.claude_api_base ?? "",
                type: "text",
                autoComplete: "url",
              })}
              ${renderSettingsInput({
                field: "claude_api_key",
                labelText: text("claudeApiKey"),
                value: state.settingsDraft?.claude_api_key ?? "",
                type: "password",
                autoComplete: "off",
              })}
              ${renderSettingsInput({
                field: "claude_model",
                labelText: text("claudeModel"),
                value: state.settingsDraft?.claude_model ?? "",
                type: "text",
                autoComplete: "off",
              })}
              ${renderSettingsInput({
                field: "claude_anthropic_version",
                labelText: text("claudeApiVersion"),
                value: state.settingsDraft?.claude_anthropic_version ?? "",
                type: "text",
                autoComplete: "off",
              })}
              ${renderSettingsInput({
                field: "claude_max_tokens",
                labelText: text("claudeMaxTokens"),
                value: String(state.settingsDraft?.claude_max_tokens ?? 1),
                type: "number",
                step: "1",
                min: "1",
              })}
              ${renderSettingsInput({
                field: "claude_temperature",
                labelText: text("claudeTemperature"),
                value: String(state.settingsDraft?.claude_temperature ?? 0),
                type: "number",
                step: "0.1",
                min: "0",
              })}
              ${renderSettingsInput({
                field: "claude_timeout_secs",
                labelText: text("claudeTimeout"),
                value: String(state.settingsDraft?.claude_timeout_secs ?? 1),
                type: "number",
                step: "1",
                min: "1",
              })}
            </div>
          </section>

          <section class="detail-section" data-testid="settings-acp-section">
            <div class="detail-section-header">
              <h3>${escapeHtml(text("settingsAcpTitle"))}</h3>
              <span>${escapeHtml(label("acp_codex"))}</span>
            </div>
            <p class="section-copy">${escapeHtml(text("providerAcpDesc"))}</p>
            <div class="settings-placeholder" data-testid="settings-acp-summary">
              <dl class="facts">
                <div data-testid="settings-acp-default-starter">
                  <dt>${escapeHtml(text("acpDefaultStarter"))}</dt>
                  <dd>${escapeHtml(acpSummary.defaultCommand)}</dd>
                </div>
                <div data-testid="settings-acp-current-program">
                  <dt>${escapeHtml(text("acpCurrentProgram"))}</dt>
                  <dd>${escapeHtml(acpSummary.currentProgram)}</dd>
                </div>
                <div data-testid="settings-acp-current-args">
                  <dt>${escapeHtml(text("acpCurrentArgs"))}</dt>
                  <dd>${escapeHtml(acpSummary.currentArgs)}</dd>
                </div>
                <div data-testid="settings-acp-client-mode">
                  <dt>${escapeHtml(text("acpClientMode"))}</dt>
                  <dd>${escapeHtml(
                    acpSummary.usesDefaultStarter
                      ? text("acpUsesDefaultStarter")
                      : text("acpUsesCustomClient"),
                  )}</dd>
                </div>
              </dl>
            </div>
            <div class="settings-form-grid">
              ${renderSettingsInput({
                field: "acp_codex_program",
                labelText: text("acpProgram"),
                value: state.settingsDraft?.acp_codex_program ?? "",
                type: "text",
                autoComplete: "off",
              })}
              ${renderSettingsTextarea({
                field: "acp_codex_args",
                labelText: text("acpArgs"),
                value: state.settingsDraft?.acp_codex_args ?? "",
              })}
              ${renderSettingsInput({
                field: "acp_timeout_secs",
                labelText: text("acpTimeout"),
                value: String(state.settingsDraft?.acp_timeout_secs ?? 1),
                type: "number",
                step: "1",
                min: "1",
              })}
            </div>
          </section>

          <section
            class="detail-section detail-section-low"
            data-testid="settings-llm-section"
          >
            <div class="detail-section-header">
              <h3>${escapeHtml(text("settingsLlmTitle"))}</h3>
              <span>${escapeHtml(text("settingsSavedSuccess"))}</span>
            </div>
            <p class="section-copy" data-testid="settings-llm-help">
              ${escapeHtml(text("settingsLlmHelp"))}
            </p>
            <div class="settings-placeholder" data-testid="settings-env-override-help">
              <p>${escapeHtml(text("settingsEnvOverrideHelp"))}</p>
            </div>
          </section>
        </div>

        <div class="modal-actions" data-testid="settings-modal-actions">
          <button
            id="saveSettingsButton"
            class="primary"
            data-testid="save-settings-button"
            type="button"
            ${canSaveSettings ? "" : "disabled"}
          >
            ${escapeHtml(
              state.isSettingsSaving ? text("saving") : text("save"),
            )}
          </button>
        </div>
      </section>
    </div>
  `;
}

function render(): void {
  document.documentElement.lang = state.locale;
  document.title = text("appTitle");

  const resolvedReviewEntries = getResolvedReviewRequestEntries(
    state.dashboard?.recent_audit_records ?? [],
  );
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
  const selectedResolvedReview = getSelectedResolvedReviewRequest(
    resolvedReviewEntries,
    state.selectedDetail,
  );
  const summary = getDashboardSummary(state.dashboard);
  const detailHtml = selectedResolvedReview
    ? renderResolvedReviewDetail(selectedResolvedReview)
    : selectedResolvedAuto
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
          <h1>${escapeHtml(text("toolbarTitle"))}</h1>
          <span
            class="toolbar-count"
            data-testid="pending-queue-count"
            data-queue-count="${summary.pendingCount}"
          >
            ${escapeHtml(text("openCount", { count: summary.pendingCount }))}
          </span>
        </div>
        <div class="toolbar-actions">
          <button
            id="openSettingsButton"
            class="ghost"
            data-testid="open-settings-button"
            type="button"
            ${state.isSettingsSaving ? "disabled" : ""}
          >
            ${escapeHtml(text("settings"))}
          </button>
          <div
            class="locale-switch"
            data-testid="locale-switcher"
            role="group"
            aria-label="${escapeHtml(text("localeSwitchAria"))}"
          >
            <button
              class="ghost locale-button ${state.locale === "en" ? "active" : ""}"
              data-locale="en"
              data-testid="locale-button-en"
              type="button"
              aria-pressed="${state.locale === "en" ? "true" : "false"}"
            >
              EN
            </button>
            <button
              class="ghost locale-button ${
                state.locale === "zh-CN" ? "active" : ""
              }"
              data-locale="zh-CN"
              data-testid="locale-button-zh"
              type="button"
              aria-pressed="${state.locale === "zh-CN" ? "true" : "false"}"
            >
              中文
            </button>
          </div>
          <div
            class="hero-status"
            data-testid="sync-status"
            data-sync-state="${getUiStateValue()}"
            role="status"
            aria-live="polite"
          >
            ${renderBadge(
              state.isSubmitting
                ? text("syncSubmitting")
                : state.isRefreshing
                  ? text("syncRefreshing")
                  : text("syncReady"),
              state.isSubmitting || state.isRefreshing ? "pending" : "neutral",
              {
                testId: "sync-status-badge",
                value: getUiStateValue(),
                kind: "sync_state",
              },
            )}
            <span data-testid="sync-timestamp">
              ${escapeHtml(timestampLabel(state.lastUpdatedAt, "waiting"))}
            </span>
          </div>
          <button
            id="refreshButton"
            class="ghost"
            data-testid="refresh-queue-button"
            aria-label="${escapeHtml(text("refreshQueueAria"))}"
            type="button"
            ${state.isSubmitting ? "disabled" : ""}
          >
            ${escapeHtml(text("refresh"))}
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
                aria-label="${escapeHtml(text("dismissErrorAria"))}"
                type="button"
              >
                ${escapeHtml(text("dismiss"))}
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
                <h2>${escapeHtml(text("queue"))}</h2>
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
              data-testid="resolved-review-results-section"
            >
              <div
                class="panel-header"
                data-testid="resolved-review-results-header"
              >
                <h2>${escapeHtml(text("recentDecisions"))}</h2>
                <span data-testid="resolved-review-results-count">
                  ${resolvedReviewEntries.length}
                </span>
              </div>
              <div class="queue-list" data-testid="resolved-review-results-list">
                ${renderResolvedReviewList(
                  resolvedReviewEntries,
                  state.selectedDetail?.kind === "resolved_request"
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
                <h2>${escapeHtml(text("autoResults"))}</h2>
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
            selectedRequest?.id ??
              selectedResolvedReview?.request_id ??
              selectedResolvedAuto?.request_id ??
              "",
          )}"
          data-detail-kind="${state.selectedDetail?.kind ?? "empty"}"
          data-policy-mode="${escapeHtml(
            selectedRequest?.policy_mode ??
              selectedResolvedReview?.policy_mode ??
              "",
          )}"
        >
          ${detailHtml}
        </section>
      </section>

      <section class="panel audit-panel" data-testid="global-audit-panel">
        <div class="panel-header" data-testid="global-audit-header">
          <h2>${escapeHtml(text("audit"))}</h2>
          <span data-testid="global-audit-count">${summary.auditCount}</span>
        </div>
        ${renderAuditList(
          state.dashboard?.recent_audit_records ?? [],
          text("noAuditEvents"),
          "global-audit-list",
        )}
      </section>
      ${renderSettingsModal()}
    </main>
  `;

  bindEvents();
}

function bindEvents(): void {
  window.onkeydown = (event: KeyboardEvent) => {
    if (
      event.key === "Escape" &&
      state.isSettingsOpen &&
      !state.isSettingsSaving
    ) {
      closeSettings();
    }
  };

  document
    .querySelectorAll<HTMLButtonElement>("[data-locale]")
    .forEach((element) => {
      element.addEventListener("click", () => {
        const locale = element.dataset.locale ?? null;
        if (!isLocale(locale) || locale === state.locale) {
          return;
        }

        applyLocale(locale);
        render();
      });
    });

  document
    .querySelector("#openSettingsButton")
    ?.addEventListener("click", () => {
      openSettings();
    });

  document
    .querySelector("#closeSettingsButton")
    ?.addEventListener("click", () => {
      closeSettings();
    });

  document
    .querySelectorAll<HTMLInputElement>('input[name="defaultPolicyMode"]')
    .forEach((element) => {
      element.addEventListener("change", () => {
        if (!state.settingsDraft) {
          return;
        }

        state.settingsDraft = {
          ...state.settingsDraft,
          default_policy_mode: element.value,
        };
        render();
      });
    });

  document
    .querySelectorAll<HTMLInputElement>('input[name="providerKind"]')
    .forEach((element) => {
      element.addEventListener("change", () => {
        if (!state.settingsDraft) {
          return;
        }

        state.settingsDraft = {
          ...state.settingsDraft,
          provider_kind: element.value,
        };
        render();
      });
    });

  document
    .querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("[data-settings-field]")
    .forEach((element) => {
      element.addEventListener("input", () => {
        updateSettingsDraftField(
          element.dataset.settingsField as SettingsFieldKey | undefined,
          element,
        );
      });
      element.addEventListener("change", () => {
        updateSettingsDraftField(
          element.dataset.settingsField as SettingsFieldKey | undefined,
          element,
        );
      });
    });

  document
    .querySelector("#saveSettingsButton")
    ?.addEventListener("click", () => {
      void saveSettings();
    });

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
    .querySelectorAll<HTMLButtonElement>("[data-select-resolved-request]")
    .forEach((element) => {
      element.addEventListener("click", () => {
        state.selectedDetail = element.dataset.selectResolvedRequest
          ? {
              kind: "resolved_request",
              id: element.dataset.selectResolvedRequest,
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

function openSettings(): void {
  state.isSettingsOpen = true;
  state.settingsErrorMessage = null;
  state.settingsNoticeMessage = null;

  state.settingsDraft = cloneSettings(state.settings);

  render();

  if (!state.isSettingsLoading) {
    void loadDesktopSettings();
  }
}

function closeSettings(): void {
  if (state.isSettingsSaving) {
    return;
  }

  state.isSettingsOpen = false;
  state.settingsErrorMessage = null;
  state.settingsNoticeMessage = null;
  state.settingsDraft = cloneSettings(state.settings);
  render();
}

function updateSettingsDraftField(
  field: SettingsFieldKey | undefined,
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
): void {
  if (!field || !state.settingsDraft) {
    return;
  }

  const numericFields = new Set<SettingsFieldKey>([
    "openai_temperature",
    "claude_max_tokens",
    "claude_temperature",
    "claude_timeout_secs",
    "acp_timeout_secs",
  ]);
  const rawValue = element.value;
  const parsedValue = numericFields.has(field) ? Number(rawValue) : rawValue;

  if (typeof parsedValue === "number" && Number.isNaN(parsedValue)) {
    return;
  }

  state.settingsDraft = {
    ...state.settingsDraft,
    [field]: parsedValue,
  } as DesktopSettings;
}

async function loadDesktopSettings(): Promise<void> {
  state.isSettingsLoading = true;
  state.settingsErrorMessage = null;
  state.settingsNoticeMessage = null;
  if (state.isSettingsOpen) {
    render();
  }

  try {
    const settings = await invoke<DesktopSettings>("desktop_settings");
    state.settings = settings;
    state.settingsDraft = cloneSettings(settings);
  } catch (error) {
    state.settingsErrorMessage = getErrorMessage(error);
  } finally {
    state.isSettingsLoading = false;
    if (state.isSettingsOpen) {
      render();
    }
  }
}

async function saveSettings(): Promise<void> {
  if (
    !state.settingsDraft ||
    state.isSettingsLoading ||
    state.isSettingsSaving
  ) {
    return;
  }

  const submitted = { ...state.settingsDraft };
  state.isSettingsSaving = true;
  state.settingsErrorMessage = null;
  state.settingsNoticeMessage = null;
  render();

  try {
    const settings = await invoke<DesktopSettings>("save_desktop_settings", {
      settings: submitted,
    });
    state.settings = settings;
    state.settingsDraft = cloneSettings(settings);
    const overriddenFields = getOverriddenSettingsFields(submitted, settings);
    state.settingsNoticeMessage =
      overriddenFields.length > 0
        ? text("settingsEnvOverrideDetected", {
            fields: overriddenFields.map(getSettingsFieldLabel).join(", "),
          })
        : text("settingsSavedSuccess");
  } catch (error) {
    state.settingsErrorMessage = getErrorMessage(error);
  } finally {
    state.isSettingsSaving = false;
    render();
  }
}

async function loadDashboard(options?: { silent?: boolean }): Promise<void> {
  const silent = options?.silent ?? false;
  state.isLoading = state.dashboard === null;
  state.isRefreshing = true;
  state.errorMessage = null;
  if (state.isLoading || !silent) {
    render();
  }

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

async function registerHandoffListener(): Promise<void> {
  await listen<HandoffPayload>(HANDOFF_EVENT, (event) => {
    queueHandoffRequest(event.payload.request_id);
  });

  const initialHandoffRequestId = await invoke<string | null>(
    "consume_handoff_request",
  );
  queueHandoffRequest(initialHandoffRequestId);
}

async function decide(
  requestId: string,
  decision: DecisionCommand,
): Promise<void> {
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

applyLocale(state.locale);
render();
void registerHandoffListener().catch((error) => {
  state.errorMessage = getErrorMessage(error);
  render();
});
void loadDesktopSettings();
void loadDashboard();
window.setInterval(() => {
  void loadDashboard({ silent: true });
}, AUTO_REFRESH_MS);
