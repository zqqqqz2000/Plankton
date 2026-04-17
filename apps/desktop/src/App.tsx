import { useEffect, useRef, useState, type JSX } from "react";

import { buildAcpProgramSummary } from "./acpSettings";
import { getPreviewHighlightResult } from "./codePreview";
import {
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
import { formatElapsed, formatShortId, formatTimestamp } from "./formatters";
import { t, translateCode, type Locale, type TranslationKey } from "./i18n";
import { buildProviderRuntimeSummary } from "./providerRuntime";
import { useDesktopApp, type DetailSelection } from "./hooks/useDesktopApp";
import { PasswordManagementView } from "./components/PasswordManagementView";
import type {
  AccessRequest,
  AuditRecord,
  AutomaticDecisionTrace,
  CallChainEntry,
  DesktopSettings,
  LlmSuggestion,
  ProviderTrace,
} from "./types";

type BadgeTone = "pending" | "approved" | "rejected" | "neutral";
type NormalizedCallChainEntry = {
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
};

function text(
  locale: Locale,
  key: TranslationKey,
  values?: Record<string, number | string>,
): string {
  return t(locale, key, values);
}

function label(locale: Locale, value: string): string {
  return translateCode(locale, value);
}

function decisionLabel(locale: Locale, value: string | null): string {
  return value ? label(locale, value) : label(locale, "pending");
}

function timestampLabel(
  locale: Locale,
  value: string | null,
  fallbackKey: TranslationKey = "notResolved",
): string {
  return formatTimestamp(value, text(locale, fallbackKey), locale);
}

function elapsedLabel(locale: Locale, value: string | null): string {
  return formatElapsed(value, Date.now(), locale);
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

function getUiStateValue(options: {
  isLoading: boolean;
  isRefreshing: boolean;
  isSubmitting: boolean;
  hasDashboard: boolean;
}): "loading" | "refreshing" | "submitting" | "ready" {
  if (options.isSubmitting) {
    return "submitting";
  }

  if (options.isRefreshing) {
    return options.hasDashboard ? "refreshing" : "loading";
  }

  if (options.isLoading) {
    return "loading";
  }

  return "ready";
}

function providerLabelOrFallback(locale: Locale, value: string | null): string {
  return value ? label(locale, value) : text(locale, "notAvailable");
}

function ProviderPromptBlock(props: {
  locale: Locale;
  renderedPrompt: string | null;
  testIdPrefix: string;
}): JSX.Element | null {
  if (!props.renderedPrompt) {
    return null;
  }

  return (
    <div data-testid={`${props.testIdPrefix}-provider-rendered-prompt`}>
      <dt>{text(props.locale, "renderedPrompt")}</dt>
      <dd>
        <pre
          className="payload-block payload-code-block provider-prompt-block"
          data-testid={`${props.testIdPrefix}-provider-rendered-prompt-block`}
        >
          <code className="payload-code">{props.renderedPrompt}</code>
        </pre>
      </dd>
    </div>
  );
}

function isAcpTrace(
  providerKind: string | null,
  providerTrace: ProviderTrace | null,
): boolean {
  return (
    providerKind === "acp" ||
    providerKind === "acp_codex" ||
    providerTrace?.package_name === "@zed-industries/codex-acp" ||
    providerTrace?.transport === "stdio"
  );
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

function normalizeCallChainEntry(
  entry: CallChainEntry,
  locale: Locale,
): NormalizedCallChainEntry {
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
      text(locale, "unknown"),
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

function getResolvedAutoTitle(
  locale: Locale,
  entry: ResolvedAutoDecisionView,
): string {
  return (
    entry.resource ??
    `${text(locale, "request")} ${formatShortId(entry.request_id)}`
  );
}

function getResolvedReviewTitle(
  locale: Locale,
  entry: ResolvedReviewRequestView,
): string {
  return (
    entry.resource ??
    `${text(locale, "request")} ${formatShortId(entry.request_id)}`
  );
}

function getPolicyOptions(locale: Locale): Array<{
  value: string;
  title: string;
  description: string;
}> {
  return [
    {
      value: "manual_only",
      title: label(locale, "manual_only"),
      description: text(locale, "policyHumanReviewDesc"),
    },
    {
      value: "assisted",
      title: label(locale, "assisted"),
      description: text(locale, "policyAssistDesc"),
    },
    {
      value: "llm_automatic",
      title: label(locale, "auto"),
      description: text(locale, "policyAutomaticDesc"),
    },
  ];
}

function getProviderOptions(locale: Locale): Array<{
  value: string;
  title: string;
  description: string;
}> {
  return [
    {
      value: "openai_compatible",
      title: label(locale, "openai_compatible"),
      description: text(locale, "providerOpenAiDesc"),
    },
    {
      value: "claude",
      title: label(locale, "claude"),
      description: text(locale, "providerClaudeDesc"),
    },
    {
      value: "acp",
      title: label(locale, "acp"),
      description: text(locale, "providerAcpDesc"),
    },
  ];
}

type BadgeProps = {
  label: string;
  tone: BadgeTone;
  testId?: string;
  value?: string | null;
  kind?: string;
};

type TextareaSelection = {
  start: number;
  end: number;
  direction: "backward" | "forward" | "none" | undefined;
};

type AppView = "approvals" | "password_management";

function Badge(props: BadgeProps): JSX.Element {
  return (
    <span
      className={`badge badge-${props.tone}`}
      data-testid={props.testId}
      data-value={props.value ?? undefined}
      data-badge-kind={props.kind}
    >
      {props.label}
    </span>
  );
}

function getTextareaSelection(
  element: HTMLTextAreaElement,
): TextareaSelection | null {
  if (
    element.selectionStart === null ||
    element.selectionEnd === null ||
    document.activeElement !== element
  ) {
    return null;
  }

  return {
    start: element.selectionStart,
    end: element.selectionEnd,
    direction: element.selectionDirection ?? undefined,
  };
}

function StableTextarea(props: {
  ariaLabel?: string;
  className: string;
  dataSettingsField?: string;
  disabled: boolean;
  id?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  testId?: string;
  value: string;
}): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isFocusedRef = useRef(false);
  const selectionRef = useRef<TextareaSelection | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || !isFocusedRef.current || props.disabled) {
      return;
    }

    if (document.activeElement !== textarea) {
      textarea.focus();
    }

    if (selectionRef.current) {
      textarea.setSelectionRange(
        selectionRef.current.start,
        selectionRef.current.end,
        selectionRef.current.direction,
      );
    }
  }, [props.disabled, props.value]);

  return (
    <textarea
      aria-label={props.ariaLabel}
      className={props.className}
      data-settings-field={props.dataSettingsField}
      data-testid={props.testId}
      disabled={props.disabled}
      id={props.id}
      onBlur={() => {
        isFocusedRef.current = false;
      }}
      onChange={(event) => {
        selectionRef.current = getTextareaSelection(event.currentTarget);
        props.onChange(event.currentTarget.value);
      }}
      onFocus={(event) => {
        isFocusedRef.current = true;
        selectionRef.current = getTextareaSelection(event.currentTarget);
      }}
      onSelect={(event) => {
        selectionRef.current = getTextareaSelection(event.currentTarget);
      }}
      placeholder={props.placeholder}
      ref={textareaRef}
      rows={props.rows}
      value={props.value}
    />
  );
}

function KeyValueList(props: {
  values: Record<string, string>;
  testId: string;
}): JSX.Element | null {
  const entries = toKeyValueEntries(props.values);
  if (entries.length === 0) {
    return null;
  }

  return (
    <dl className="kv-list" data-testid={props.testId}>
      {entries.map(([key, value]) => (
        <div
          className="kv-row"
          data-testid={`${props.testId}-entry`}
          data-key={key}
          key={key}
        >
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AuditList(props: {
  locale: Locale;
  records: AuditRecord[];
  emptyMessage: string;
  testId: string;
}): JSX.Element {
  if (props.records.length === 0) {
    return (
      <p className="empty" data-testid={`${props.testId}-empty`}>
        {props.emptyMessage}
      </p>
    );
  }

  return (
    <div className="audit-list" data-testid={props.testId}>
      {props.records.map((record) => {
        const decision =
          typeof record.payload.decision === "string"
            ? record.payload.decision
            : null;
        const tone = decision ? getDecisionTone(decision) : "neutral";

        return (
          <article
            className="audit-row"
            data-testid={`${props.testId}-entry`}
            data-request-id={record.request_id}
            data-audit-action={record.action}
            data-decision={decision ?? undefined}
            key={record.id}
          >
            <div
              className="audit-row-main"
              data-testid={`${props.testId}-entry-header`}
            >
              <div className="audit-row-left">
                <Badge
                  kind="audit_action"
                  label={label(props.locale, record.action)}
                  testId={`${props.testId}-action-badge`}
                  tone={tone}
                  value={record.action}
                />
                <strong>{record.actor}</strong>
                {decision ? (
                  <Badge
                    kind="decision"
                    label={label(props.locale, decision)}
                    testId={`${props.testId}-decision-badge`}
                    tone={tone}
                    value={decision}
                  />
                ) : null}
              </div>
              <div
                className="audit-row-meta"
                data-testid={`${props.testId}-entry-meta`}
              >
                <span>{formatShortId(record.request_id)}</span>
                <span>
                  {timestampLabel(props.locale, record.created_at, "unknown")}
                </span>
              </div>
            </div>
            {record.note ? (
              <p
                className="audit-note"
                data-testid={`${props.testId}-entry-note`}
              >
                {record.note}
              </p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function CallChainList(props: {
  locale: Locale;
  callChain: CallChainEntry[];
}): JSX.Element {
  if (props.callChain.length === 0) {
    return (
      <p className="empty" data-testid="call-chain-empty">
        {text(props.locale, "noCallChain")}
      </p>
    );
  }

  return (
    <div className="call-chain-list" data-testid="call-chain-list">
      {props.callChain.map((step, index) => {
        const entry = normalizeCallChainEntry(step, props.locale);
        const previewResult = entry.previewText
          ? getPreviewHighlightResult(entry.path, entry.previewText)
          : null;
        const processMeta = entry.processName
          ? `${text(props.locale, "process")}: ${entry.processName}${
              entry.pid === null ? "" : ` (${entry.pid})`
            }${entry.ppid === null ? "" : ` → ${entry.ppid}`}`
          : null;
        const metaItems = [
          processMeta,
          entry.executablePath
            ? `${text(props.locale, "executable")}: ${entry.executablePath}`
            : null,
          entry.argv.length > 0
            ? `${text(props.locale, "arguments")}: ${entry.argv.join(" ")}`
            : null,
          entry.source
            ? `${text(props.locale, "source")}: ${label(props.locale, entry.source)}`
            : null,
          entry.previewStatus
            ? `${text(props.locale, "previewStatus")}: ${label(props.locale, entry.previewStatus)}`
            : null,
        ].filter((value): value is string => Boolean(value));

        return (
          <article
            className="call-chain-entry"
            data-step-index={index}
            data-testid="call-chain-step"
            key={`${entry.path}-${index}`}
          >
            <div className="call-chain-path" data-testid="call-chain-path">
              {entry.path}
            </div>
            {metaItems.length > 0 ? (
              <div
                className="call-chain-meta"
                data-testid="call-chain-step-meta"
              >
                {metaItems.map((item, metaIndex) => (
                  <span
                    data-meta-index={metaIndex}
                    data-testid="call-chain-meta-item"
                    key={`${metaIndex}-${item}`}
                  >
                    {item}
                  </span>
                ))}
              </div>
            ) : null}
            {previewResult ? (
              <>
                <div
                  className="call-chain-preview-header"
                  data-testid="call-chain-preview-header"
                >
                  <span className="context-label">
                    {text(props.locale, "callChainPreview")}
                  </span>
                  <span
                    className="call-chain-preview-mode"
                    data-testid="call-chain-preview-mode"
                  >
                    {previewResult.highlighted
                      ? previewResult.label
                      : text(props.locale, "plainText")}
                  </span>
                </div>
                <pre
                  className="payload-block payload-code-block call-chain-preview-block"
                  data-testid="call-chain-preview"
                >
                  <code
                    className={`payload-code${
                      previewResult.highlighted ? " hljs" : ""
                    }`}
                    data-highlighted={
                      previewResult.highlighted ? "true" : "false"
                    }
                    dangerouslySetInnerHTML={{ __html: previewResult.html }}
                  />
                </pre>
              </>
            ) : (
              <p
                className="empty compact-empty"
                data-testid="call-chain-preview-empty"
              >
                {entry.previewError ??
                  (entry.previewable
                    ? text(props.locale, "previewUnavailable")
                    : label(
                        props.locale,
                        entry.previewStatus ?? "not_previewable",
                      ))}
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

function ContextCard(props: {
  locale: Locale;
  request: AccessRequest;
}): JSX.Element | null {
  const groups: JSX.Element[] = [];
  const { request } = props;
  const resourceTags = request.context.resource_tags ?? [];
  const resourceMetadata = request.context.resource_metadata ?? {};

  if (resourceTags.length > 0) {
    groups.push(
      <div
        className="context-group"
        data-testid="resource-tags-card"
        key="resource-tags"
      >
        <span className="context-label" data-testid="resource-tags-count">
          {text(props.locale, "tags")}
        </span>
        <div className="imported-tag-list">
          {resourceTags.map((tag) => (
            <span className="id-pill" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      </div>,
    );
  }

  if (Object.keys(resourceMetadata).length > 0) {
    groups.push(
      <div
        className="context-group"
        data-testid="resource-metadata-card"
        key="resource-metadata"
      >
        <span className="context-label" data-testid="resource-metadata-count">
          {text(props.locale, "metadata")}
        </span>
        <KeyValueList
          testId="resource-metadata-list"
          values={resourceMetadata}
        />
      </div>,
    );
  }

  if (request.context.script_path) {
    groups.push(
      <div
        className="context-group"
        data-testid="request-script-path-group"
        key="script"
      >
        <span className="context-label">{text(props.locale, "script")}</span>
        <div className="context-value" data-testid="request-fact-script-path">
          {request.context.script_path}
        </div>
      </div>,
    );
  }

  groups.push(
    <div
      className="context-group"
      data-testid="call-chain-card"
      key="call-chain"
    >
      <span className="context-label">{text(props.locale, "callChain")}</span>
      <CallChainList
        callChain={request.context.call_chain}
        locale={props.locale}
      />
    </div>,
  );

  if (Object.keys(request.context.env_vars).length > 0) {
    groups.push(
      <div className="context-group" data-testid="environment-card" key="env">
        <span className="context-label" data-testid="environment-count">
          {text(props.locale, "environmentCount", {
            count: Object.keys(request.context.env_vars).length,
          })}
        </span>
        <KeyValueList
          testId="environment-list"
          values={request.context.env_vars}
        />
      </div>,
    );
  }

  if (Object.keys(request.context.metadata).length > 0) {
    groups.push(
      <div className="context-group" data-testid="metadata-card" key="metadata">
        <span className="context-label" data-testid="metadata-count">
          {text(props.locale, "metadataCount", {
            count: Object.keys(request.context.metadata).length,
          })}
        </span>
        <KeyValueList
          testId="metadata-list"
          values={request.context.metadata}
        />
      </div>,
    );
  }

  if (groups.length === 0) {
    return null;
  }

  return (
    <section
      className="detail-section detail-section-wide"
      data-testid="request-context-card"
    >
      <div className="detail-section-header">
        <h3>{text(props.locale, "callChain")}</h3>
      </div>
      <div className="context-stack">{groups}</div>
    </section>
  );
}

function SuggestionCard(props: {
  locale: Locale;
  suggestion: LlmSuggestion | null;
}): JSX.Element | null {
  const suggestion = props.suggestion;
  if (!suggestion) {
    return null;
  }

  const providerLabel = suggestion.provider_model
    ? `${label(props.locale, suggestion.provider_kind)} / ${suggestion.provider_model}`
    : label(props.locale, suggestion.provider_kind);

  return (
    <section
      className="detail-section detail-section-accent"
      data-testid="llm-suggestion-card"
    >
      <div
        className="detail-section-header"
        data-testid="llm-suggestion-card-header"
      >
        <h3>{text(props.locale, "suggestion")}</h3>
        <span data-testid="llm-suggestion-provider">{providerLabel}</span>
      </div>
      <div className="badge-row" data-testid="llm-suggestion-badges">
        <Badge
          kind="suggested_decision"
          label={label(props.locale, suggestion.suggested_decision)}
          testId="llm-suggestion-decision"
          tone={getDecisionTone(suggestion.suggested_decision)}
          value={suggestion.suggested_decision}
        />
        <Badge
          kind="risk_score"
          label={text(props.locale, "riskLabel", {
            score: suggestion.risk_score,
          })}
          testId="llm-suggestion-risk"
          tone="neutral"
          value={String(suggestion.risk_score)}
        />
      </div>
      <p className="suggestion-summary" data-testid="llm-suggestion-rationale">
        {suggestion.rationale_summary}
      </p>
      <div className="suggestion-meta" data-testid="llm-suggestion-meta">
        {[
          providerLabel,
          text(props.locale, "templateVersion", {
            version: suggestion.template_version,
          }),
          timestampLabel(props.locale, suggestion.generated_at, "unknown"),
        ].map((part, index) => (
          <span
            data-meta-index={index}
            data-testid="llm-suggestion-meta-item"
            key={`${index}-${part}`}
          >
            {part}
          </span>
        ))}
      </div>
      {suggestion.error ? (
        <p className="suggestion-error" data-testid="llm-suggestion-error">
          {suggestion.error}
        </p>
      ) : null}
    </section>
  );
}

function ResolvedSuggestionCard(props: {
  locale: Locale;
  suggestion: SuggestionSummaryView | null;
}): JSX.Element | null {
  const suggestion = props.suggestion;
  if (!suggestion) {
    return null;
  }

  const providerLabel = suggestion.provider_model
    ? `${suggestion.provider_kind ? label(props.locale, suggestion.provider_kind) : text(props.locale, "provider")} / ${suggestion.provider_model}`
    : suggestion.provider_kind
      ? label(props.locale, suggestion.provider_kind)
      : text(props.locale, "notAvailable");

  return (
    <section
      className="detail-section detail-section-accent"
      data-testid="resolved-review-suggestion-card"
    >
      <div
        className="detail-section-header"
        data-testid="resolved-review-suggestion-card-header"
      >
        <h3>{text(props.locale, "suggestion")}</h3>
        <span data-testid="resolved-review-suggestion-provider">
          {providerLabel}
        </span>
      </div>
      <div
        className="badge-row"
        data-testid="resolved-review-suggestion-badges"
      >
        {suggestion.suggested_decision ? (
          <Badge
            kind="suggested_decision"
            label={label(props.locale, suggestion.suggested_decision)}
            testId="resolved-review-suggestion-decision"
            tone={getDecisionTone(suggestion.suggested_decision)}
            value={suggestion.suggested_decision}
          />
        ) : null}
        {suggestion.risk_score === null ? null : (
          <Badge
            kind="risk_score"
            label={text(props.locale, "riskLabel", {
              score: suggestion.risk_score,
            })}
            testId="resolved-review-suggestion-risk"
            tone="neutral"
            value={String(suggestion.risk_score)}
          />
        )}
      </div>
      {suggestion.rationale_summary ? (
        <p
          className="suggestion-summary"
          data-testid="resolved-review-suggestion-rationale"
        >
          {suggestion.rationale_summary}
        </p>
      ) : null}
      {suggestion.error ? (
        <p
          className="suggestion-error"
          data-testid="resolved-review-suggestion-error"
        >
          {suggestion.error}
        </p>
      ) : null}
      <div
        className="suggestion-meta"
        data-testid="resolved-review-suggestion-meta"
      >
        {[
          providerLabel,
          suggestion.template_version
            ? text(props.locale, "templateVersion", {
                version: suggestion.template_version,
              })
            : text(props.locale, "notAvailable"),
          timestampLabel(props.locale, suggestion.generated_at, "unknown"),
        ].map((part, index) => (
          <span
            data-meta-index={index}
            data-testid="resolved-review-suggestion-meta-item"
            key={`${index}-${part}`}
          >
            {part}
          </span>
        ))}
      </div>
    </section>
  );
}

function ProviderRuntimeCard(props: {
  locale: Locale;
  configuredProviderKind: string | null;
  actualProviderKind: string | null;
  providerCalled: boolean | null;
  providerTrace: ProviderTrace | null;
  renderedPrompt: string | null;
  testIdPrefix: string;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const runtime = buildProviderRuntimeSummary({
    configuredProviderKind: props.configuredProviderKind,
    actualProviderKind: props.actualProviderKind,
    providerCalled: props.providerCalled,
    providerTrace: props.providerTrace,
  });

  const statusMessage = (() => {
    switch (runtime.state) {
      case "active":
        return text(props.locale, "providerStatusActive", {
          provider: providerLabelOrFallback(
            props.locale,
            runtime.actualProviderKind,
          ),
        });
      case "configured_not_called":
        return text(props.locale, "providerStatusConfiguredNotCalled", {
          provider: providerLabelOrFallback(
            props.locale,
            runtime.configuredProviderKind,
          ),
        });
      case "configured_pending":
        return text(props.locale, "providerStatusConfiguredPending", {
          provider: providerLabelOrFallback(
            props.locale,
            runtime.configuredProviderKind,
          ),
        });
      case "configured_overridden":
        return text(props.locale, "providerStatusConfiguredOverridden", {
          configured: providerLabelOrFallback(
            props.locale,
            runtime.configuredProviderKind,
          ),
          actual: providerLabelOrFallback(
            props.locale,
            runtime.actualProviderKind,
          ),
        });
      case "not_called":
        return text(props.locale, "providerStatusNotCalled");
      case "unavailable":
        return text(props.locale, "providerStatusUnavailable");
    }
  })();

  return (
    <section
      className="detail-section detail-section-low provider-runtime-card"
      data-testid={`${props.testIdPrefix}-provider-runtime-card`}
    >
      <div
        className="detail-section-header"
        data-testid={`${props.testIdPrefix}-provider-runtime-header`}
      >
        <h3>{text(props.locale, "providerRuntime")}</h3>
        <div className="provider-runtime-header-actions">
          <span data-testid={`${props.testIdPrefix}-provider-runtime-state`}>
            {providerLabelOrFallback(props.locale, runtime.actualProviderKind)}
          </span>
          <button
            className="ghost"
            data-testid={`${props.testIdPrefix}-provider-runtime-toggle`}
            onClick={() => {
              setIsOpen((current) => !current);
            }}
            type="button"
          >
            {isOpen
              ? text(props.locale, "collapsePanel")
              : text(props.locale, "expandPanel")}
          </button>
        </div>
      </div>
      {isOpen ? (
        <dl
          className="facts"
          data-testid={`${props.testIdPrefix}-provider-runtime-facts`}
        >
          <div data-testid={`${props.testIdPrefix}-configured-provider`}>
            <dt>{text(props.locale, "configuredProvider")}</dt>
            <dd>
              {providerLabelOrFallback(
                props.locale,
                runtime.configuredProviderKind,
              )}
            </dd>
          </div>
          <div data-testid={`${props.testIdPrefix}-effective-provider`}>
            <dt>{text(props.locale, "effectiveProvider")}</dt>
            <dd>
              {providerLabelOrFallback(props.locale, runtime.actualProviderKind)}
            </dd>
          </div>
          <div data-testid={`${props.testIdPrefix}-provider-runtime-status`}>
            <dt>{text(props.locale, "providerRuntimeStatus")}</dt>
            <dd>{statusMessage}</dd>
          </div>
          <div data-testid={`${props.testIdPrefix}-provider-runtime-trace`}>
            <dt>{text(props.locale, "providerTraceState")}</dt>
            <dd>
              {runtime.traceAvailable
                ? text(props.locale, "providerTraceVisible")
                : text(props.locale, "providerTraceMissing")}
            </dd>
          </div>
          <ProviderPromptBlock
            locale={props.locale}
            renderedPrompt={props.renderedPrompt}
            testIdPrefix={props.testIdPrefix}
          />
        </dl>
      ) : (
        <p
          className="section-copy provider-runtime-summary"
          data-testid={`${props.testIdPrefix}-provider-runtime-summary`}
        >
          {statusMessage}
        </p>
      )}
    </section>
  );
}

function AcpTraceCard(props: {
  locale: Locale;
  trace: SuggestionTraceView | null;
}): JSX.Element | null {
  const trace = props.trace;
  if (!trace || !isAcpTrace(trace.provider_kind, trace.provider_trace)) {
    return null;
  }

  const providerTrace = trace.provider_trace;
  const packageLabel =
    providerTrace?.package_name && providerTrace.package_version
      ? `${providerTrace.package_name} ${providerTrace.package_version}`
      : (providerTrace?.package_name ??
        providerTrace?.package_version ??
        text(props.locale, "unknown"));

  return (
    <section
      className="detail-section"
      data-provider-kind={trace.provider_kind ?? ""}
      data-testid="acp-provider-trace-card"
    >
      <div
        className="detail-section-header"
        data-testid="acp-provider-trace-card-header"
      >
        <h3>{text(props.locale, "acpTrace")}</h3>
        <span data-testid="acp-provider-model">
          {trace.provider_model ?? text(props.locale, "notAvailable")}
        </span>
      </div>
      <div className="badge-row" data-testid="acp-provider-trace-badges">
        <Badge
          kind="provider_kind"
          label={label(props.locale, trace.provider_kind ?? "acp")}
          testId="acp-provider-kind"
          tone="neutral"
          value={trace.provider_kind ?? "acp"}
        />
        <Badge
          kind="acp_transport"
          label={providerTrace?.transport ?? text(props.locale, "unknown")}
          testId="acp-transport"
          tone="neutral"
          value={providerTrace?.transport ?? "unknown"}
        />
        {providerTrace?.package_version ? (
          <Badge
            kind="acp_package_version"
            label={providerTrace.package_version}
            testId="acp-package-version"
            tone="neutral"
            value={providerTrace.package_version}
          />
        ) : null}
      </div>
      <dl className="facts" data-testid="acp-provider-trace-facts">
        <div data-testid="acp-trace-session-id">
          <dt>{text(props.locale, "session")}</dt>
          <dd>
            {providerTrace?.session_id ?? text(props.locale, "notAvailable")}
          </dd>
        </div>
        <div data-testid="acp-trace-agent-name">
          <dt>{text(props.locale, "agentName")}</dt>
          <dd>
            {providerTrace?.agent_name ?? text(props.locale, "notAvailable")}
          </dd>
        </div>
        <div data-testid="acp-trace-agent-version">
          <dt>{text(props.locale, "agentVersion")}</dt>
          <dd>
            {providerTrace?.agent_version ?? text(props.locale, "notAvailable")}
          </dd>
        </div>
        <div data-testid="acp-trace-package">
          <dt>{text(props.locale, "package")}</dt>
          <dd>{packageLabel}</dd>
        </div>
        <div data-testid="acp-trace-client-request-id">
          <dt>{text(props.locale, "clientRequest")}</dt>
          <dd>
            {providerTrace?.client_request_id ??
              text(props.locale, "notAvailable")}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ClaudeTraceCard(props: {
  locale: Locale;
  trace: SuggestionTraceView | null;
}): JSX.Element | null {
  const trace = props.trace;
  if (!trace || !isClaudeTrace(trace.provider_kind, trace.provider_trace)) {
    return null;
  }

  const providerTrace = trace.provider_trace;

  return (
    <section
      className="detail-section"
      data-provider-kind={trace.provider_kind ?? ""}
      data-testid="claude-provider-trace-card"
    >
      <div
        className="detail-section-header"
        data-testid="claude-provider-trace-card-header"
      >
        <h3>{text(props.locale, "claudeTrace")}</h3>
        <span data-testid="claude-provider-model">
          {trace.provider_model ?? text(props.locale, "notAvailable")}
        </span>
      </div>
      <div className="badge-row" data-testid="claude-provider-trace-badges">
        <Badge
          kind="provider_kind"
          label={label(props.locale, trace.provider_kind ?? "claude")}
          testId="claude-provider-kind"
          tone="neutral"
          value={trace.provider_kind ?? "claude"}
        />
        {providerTrace?.protocol ? (
          <Badge
            kind="protocol"
            label={providerTrace.protocol}
            testId="claude-protocol"
            tone="neutral"
            value={providerTrace.protocol}
          />
        ) : null}
        {providerTrace?.stop_reason ? (
          <Badge
            kind="stop_reason"
            label={label(props.locale, providerTrace.stop_reason)}
            testId="claude-stop-reason"
            tone="neutral"
            value={providerTrace.stop_reason}
          />
        ) : null}
      </div>
      <dl className="facts" data-testid="claude-provider-trace-facts">
        <div data-testid="claude-trace-response-id">
          <dt>{text(props.locale, "response")}</dt>
          <dd>
            {trace.provider_response_id ?? text(props.locale, "notAvailable")}
          </dd>
        </div>
        <div data-testid="claude-trace-request-id">
          <dt>{text(props.locale, "request")}</dt>
          <dd>{trace.x_request_id ?? text(props.locale, "notAvailable")}</dd>
        </div>
        <div data-testid="claude-trace-total-tokens">
          <dt>{text(props.locale, "totalTokens")}</dt>
          <dd>
            {trace.usage_total_tokens === null
              ? text(props.locale, "notAvailable")
              : String(trace.usage_total_tokens)}
          </dd>
        </div>
        <div data-testid="claude-trace-api-version">
          <dt>{text(props.locale, "apiVersion")}</dt>
          <dd>
            {providerTrace?.api_version ?? text(props.locale, "notAvailable")}
          </dd>
        </div>
        <div data-testid="claude-trace-output-format">
          <dt>{text(props.locale, "output")}</dt>
          <dd>
            {providerTrace?.output_format ?? text(props.locale, "notAvailable")}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function AutomaticDecisionCard(props: {
  locale: Locale;
  automaticDecision: AutomaticDecisionTrace | null;
}): JSX.Element | null {
  const automaticDecision = props.automaticDecision;
  if (!automaticDecision) {
    return null;
  }

  const guardrailHints: string[] = [];
  if (automaticDecision.secret_exposure_risk) {
    guardrailHints.push(text(props.locale, "secretExposureRisk"));
  }
  if (automaticDecision.fail_closed) {
    guardrailHints.push(text(props.locale, "failClosed"));
  }

  return (
    <section
      className="detail-section detail-section-wide detail-section-accent"
      data-auto-disposition={automaticDecision.auto_disposition}
      data-decision-source={automaticDecision.decision_source}
      data-testid="automatic-decision-card"
    >
      <div
        className="detail-section-header"
        data-testid="automatic-decision-card-header"
      >
        <h3>{text(props.locale, "automaticResult")}</h3>
        <span data-testid="automatic-decision-evaluated-at">
          {timestampLabel(
            props.locale,
            automaticDecision.evaluated_at,
            "unknown",
          )}
        </span>
      </div>
      <div className="badge-row" data-testid="automatic-decision-badges">
        <Badge
          kind="auto_disposition"
          label={label(props.locale, automaticDecision.auto_disposition)}
          testId="automatic-decision-disposition"
          tone={getDecisionTone(automaticDecision.auto_disposition)}
          value={automaticDecision.auto_disposition}
        />
        <Badge
          kind="decision_source"
          label={label(props.locale, automaticDecision.decision_source)}
          testId="automatic-decision-source"
          tone="neutral"
          value={automaticDecision.decision_source}
        />
        <Badge
          kind="provider_called"
          label={
            automaticDecision.provider_called
              ? text(props.locale, "providerCalled")
              : text(props.locale, "providerSkipped")
          }
          testId="automatic-decision-provider-called"
          tone={automaticDecision.provider_called ? "neutral" : "pending"}
          value={String(automaticDecision.provider_called)}
        />
        {automaticDecision.secret_exposure_risk ? (
          <Badge
            kind="guardrail"
            label={text(props.locale, "secretExposureRisk")}
            testId="automatic-decision-secret-exposure-risk"
            tone="rejected"
            value="true"
          />
        ) : null}
      </div>
      <p
        className="automatic-summary"
        data-testid="automatic-decision-rationale"
      >
        {automaticDecision.auto_rationale_summary}
      </p>
      {automaticDecision.matched_rule_ids.length > 0 ? (
        <p
          className="automatic-rules"
          data-testid="automatic-decision-matched-rules"
        >
          {automaticDecision.matched_rule_ids.join(", ")}
        </p>
      ) : null}
      {guardrailHints.length > 0 ? (
        <p
          className="automatic-hints"
          data-testid="automatic-decision-guardrails"
        >
          {guardrailHints.join(" | ")}
        </p>
      ) : null}
    </section>
  );
}

export function PendingRequestDetail(props: {
  locale: Locale;
  request: AccessRequest | null;
  settings: DesktopSettings | null;
  noteDraft: string;
  pendingDecision: string | null;
  lastUpdatedAt: string | null;
  isSubmitting: boolean;
  recentAuditRecords: AuditRecord[];
  showAudit?: boolean;
  showProviderDiagnostics?: boolean;
  onNoteChange: (value: string) => void;
  onDecide: (
    requestId: string,
    decision: "approve_request" | "reject_request",
  ) => void;
}): JSX.Element {
  const request = props.request;
  if (!request) {
    return (
      <div
        className="detail-empty-state"
        data-testid="request-detail-empty-state"
      >
        <h2>{text(props.locale, "noPendingRequest")}</h2>
      </div>
    );
  }

  const selectedAuditRecords = getRequestAuditRecords(
    props.recentAuditRecords,
    request.id,
  );
  const suggestionTrace = request.llm_suggestion
    ? {
        provider_kind: request.llm_suggestion.provider_kind,
        provider_model: request.llm_suggestion.provider_model,
        provider_response_id: request.llm_suggestion.provider_response_id,
        x_request_id: request.llm_suggestion.x_request_id,
        usage_total_tokens: request.llm_suggestion.usage?.total_tokens ?? null,
        rendered_prompt:
          request.llm_suggestion.provider_trace?.rendered_prompt ?? null,
        provider_trace: request.llm_suggestion.provider_trace,
      }
    : null;
  const providerCalled =
    request.automatic_decision?.provider_called ??
    (request.llm_suggestion ? true : null) ??
    (request.policy_mode === "manual_only" ? false : null);
  const actualProviderKind =
    suggestionTrace?.provider_kind ??
    request.automatic_decision?.provider_kind ??
    request.provider_kind;
  const showAudit = props.showAudit ?? true;
  const showProviderDiagnostics = props.showProviderDiagnostics ?? true;

  return (
    <>
      <div className="detail-header" data-testid="request-detail-header">
        <div className="detail-title-group">
          <h2>{request.context.resource}</h2>
          <p className="detail-reason" data-testid="request-reason">
            {request.context.reason}
          </p>
          <div className="detail-meta" data-testid="request-detail-overview">
            <span data-testid="request-requester">
              {request.context.requested_by}
            </span>
            <span data-testid="request-opened-at">
              {elapsedLabel(props.locale, request.created_at)}
            </span>
            <span className="id-pill" data-testid="request-id-pill">
              {formatShortId(request.id)}
            </span>
          </div>
        </div>
        <div className="badge-row" data-testid="request-detail-badges">
          <Badge
            kind="approval_status"
            label={label(props.locale, request.approval_status)}
            testId="request-approval-status"
            tone="pending"
            value={request.approval_status}
          />
          {request.final_decision ? (
            <Badge
              kind="final_decision"
              label={decisionLabel(props.locale, request.final_decision)}
              testId="request-final-decision"
              tone={getDecisionTone(request.final_decision)}
              value={request.final_decision}
            />
          ) : null}
        </div>
      </div>

      <div className="detail-grid">
        <AutomaticDecisionCard
          automaticDecision={request.automatic_decision}
          locale={props.locale}
        />

        <section className="detail-section" data-testid="review-decision-card">
          <div
            className="detail-section-header"
            data-testid="review-decision-card-header"
          >
            <h3>{text(props.locale, "decision")}</h3>
            <span data-testid="review-sync-timestamp">
              {timestampLabel(props.locale, props.lastUpdatedAt, "pendingSync")}
            </span>
          </div>
          <label className="field-label" htmlFor="decisionNote">
            {text(props.locale, "note")}
          </label>
          <StableTextarea
            aria-label={text(props.locale, "auditNoteAria")}
            className="note-field"
            disabled={props.isSubmitting}
            id="decisionNote"
            onChange={props.onNoteChange}
            placeholder={text(props.locale, "notePlaceholder")}
            testId="decision-note-input"
            value={props.noteDraft}
          />
          <div className="actions" data-testid="decision-actions">
            <button
              aria-label={text(props.locale, "approveSelectedAria")}
              className="primary"
              data-decision="approve_request"
              data-request-id={request.id}
              data-testid="approve-request-button"
              disabled={props.isSubmitting}
              id="approveButton"
              onClick={() => {
                props.onDecide(request.id, "approve_request");
              }}
              type="button"
            >
              {props.pendingDecision === "approve_request"
                ? text(props.locale, "approving")
                : text(props.locale, "approve")}
            </button>
            <button
              aria-label={text(props.locale, "rejectSelectedAria")}
              className="danger"
              data-decision="reject_request"
              data-request-id={request.id}
              data-testid="reject-request-button"
              disabled={props.isSubmitting}
              id="rejectButton"
              onClick={() => {
                props.onDecide(request.id, "reject_request");
              }}
              type="button"
            >
              {props.pendingDecision === "reject_request"
                ? text(props.locale, "rejecting")
                : text(props.locale, "reject")}
            </button>
          </div>
        </section>

        <section className="detail-section" data-testid="request-facts-card">
          <div
            className="detail-section-header"
            data-testid="request-facts-card-header"
          >
            <h3>{text(props.locale, "summary")}</h3>
            <span data-testid="request-policy-mode">
              {label(props.locale, request.policy_mode)}
            </span>
          </div>
          <dl className="facts" data-testid="request-facts-list">
            <div data-testid="request-fact-created">
              <dt>{text(props.locale, "created")}</dt>
              <dd>
                {timestampLabel(props.locale, request.created_at, "unknown")}
              </dd>
            </div>
            <div data-testid="request-fact-resolved">
              <dt>{text(props.locale, "resolved")}</dt>
              <dd>{timestampLabel(props.locale, request.resolved_at)}</dd>
            </div>
            <div data-testid="request-provider-kind">
              <dt>{text(props.locale, "provider")}</dt>
              <dd>
                {providerLabelOrFallback(props.locale, request.provider_kind)}
              </dd>
            </div>
            <div data-testid="request-fact-updated">
              <dt>{text(props.locale, "updated")}</dt>
              <dd>
                {timestampLabel(props.locale, request.updated_at, "unknown")}
              </dd>
            </div>
          </dl>
        </section>

        <SuggestionCard
          locale={props.locale}
          suggestion={request.llm_suggestion}
        />
        {showProviderDiagnostics ? (
          <AcpTraceCard locale={props.locale} trace={suggestionTrace} />
        ) : null}
        {showProviderDiagnostics ? (
          <ClaudeTraceCard locale={props.locale} trace={suggestionTrace} />
        ) : null}
        <ContextCard locale={props.locale} request={request} />
        {showAudit ? (
          <section
            className="detail-section detail-section-wide"
            data-testid="request-audit-card"
          >
            <div
              className="detail-section-header"
              data-testid="request-audit-card-header"
            >
              <h3>{text(props.locale, "requestAudit")}</h3>
              <span data-testid="request-audit-count">
                {text(props.locale, "eventCount", {
                  count: selectedAuditRecords.length,
                })}
              </span>
            </div>
            <AuditList
              emptyMessage={text(props.locale, "noRequestAudit")}
              locale={props.locale}
              records={selectedAuditRecords}
              testId="request-audit-list"
            />
          </section>
        ) : null}
        {showProviderDiagnostics ? (
          <ProviderRuntimeCard
            actualProviderKind={actualProviderKind}
            configuredProviderKind={props.settings?.provider_kind ?? null}
            locale={props.locale}
            providerCalled={providerCalled}
            renderedPrompt={suggestionTrace?.rendered_prompt ?? null}
            providerTrace={suggestionTrace?.provider_trace ?? null}
            testIdPrefix="request"
          />
        ) : null}
      </div>
    </>
  );
}

export function ResolvedAutoDetail(props: {
  locale: Locale;
  entry: ResolvedAutoDecisionView | null;
  settings: DesktopSettings | null;
  recentAuditRecords: AuditRecord[];
}): JSX.Element {
  const entry = props.entry;
  if (!entry) {
    return (
      <div
        className="detail-empty-state"
        data-testid="request-detail-empty-state"
      >
        <h2>{text(props.locale, "noPendingRequest")}</h2>
      </div>
    );
  }

  const selectedAuditRecords = getRequestAuditRecords(
    props.recentAuditRecords,
    entry.request_id,
  );
  const providerLabel = entry.automatic_decision.provider_called
    ? entry.automatic_decision.provider_model
      ? `${entry.automatic_decision.provider_kind ? label(props.locale, entry.automatic_decision.provider_kind) : text(props.locale, "provider")} / ${entry.automatic_decision.provider_model}`
      : entry.automatic_decision.provider_kind
        ? label(props.locale, entry.automatic_decision.provider_kind)
        : text(props.locale, "provider")
    : text(props.locale, "providerSkipped");
  const decisionValue =
    entry.final_decision ?? entry.automatic_decision.auto_disposition;
  const statusValue =
    entry.approval_status ?? entry.automatic_decision.auto_disposition;
  const summaryText =
    entry.reason ?? entry.automatic_decision.auto_rationale_summary;
  const suggestionTrace = getSuggestionTrace(selectedAuditRecords);
  const actualProviderKind =
    suggestionTrace?.provider_kind ?? entry.automatic_decision.provider_kind;

  return (
    <>
      <div className="detail-header" data-testid="resolved-auto-detail-header">
        <div className="detail-title-group">
          <h2>{getResolvedAutoTitle(props.locale, entry)}</h2>
          {summaryText ? (
            <p className="detail-reason" data-testid="resolved-auto-reason">
              {summaryText}
            </p>
          ) : null}
          <div
            className="detail-meta"
            data-testid="resolved-auto-detail-overview"
          >
            <span data-testid="resolved-auto-requester">
              {entry.requested_by ?? text(props.locale, "system")}
            </span>
            <span data-testid="resolved-auto-recorded-at">
              {elapsedLabel(props.locale, entry.recorded_at)}
            </span>
            <span
              className="id-pill"
              data-testid="resolved-auto-request-id-pill"
            >
              {formatShortId(entry.request_id)}
            </span>
          </div>
        </div>
        <div className="badge-row" data-testid="resolved-auto-detail-badges">
          <Badge
            kind="approval_status"
            label={label(props.locale, statusValue)}
            testId="resolved-auto-approval-status"
            tone={getDecisionTone(statusValue)}
            value={statusValue}
          />
          <Badge
            kind="final_decision"
            label={decisionLabel(props.locale, decisionValue)}
            testId="resolved-auto-final-decision"
            tone={getDecisionTone(decisionValue)}
            value={decisionValue}
          />
        </div>
      </div>

      <div className="detail-grid">
        <AutomaticDecisionCard
          automaticDecision={entry.automatic_decision}
          locale={props.locale}
        />

        <section
          className="detail-section"
          data-testid="resolved-auto-summary-card"
        >
          <div
            className="detail-section-header"
            data-testid="resolved-auto-summary-card-header"
          >
            <h3>{text(props.locale, "summary")}</h3>
            <span data-testid="resolved-auto-decision-source">
              {label(props.locale, entry.automatic_decision.decision_source)}
            </span>
          </div>
          <dl className="facts" data-testid="resolved-auto-facts-list">
            <div data-testid="resolved-auto-fact-submitted">
              <dt>{text(props.locale, "submitted")}</dt>
              <dd>
                {timestampLabel(props.locale, entry.submitted_at, "unknown")}
              </dd>
            </div>
            <div data-testid="resolved-auto-fact-recorded">
              <dt>{text(props.locale, "recorded")}</dt>
              <dd>
                {timestampLabel(props.locale, entry.recorded_at, "unknown")}
              </dd>
            </div>
            <div data-testid="resolved-auto-fact-provider">
              <dt>{text(props.locale, "provider")}</dt>
              <dd>{providerLabel}</dd>
            </div>
            <div data-testid="resolved-auto-fact-guardrail">
              <dt>{text(props.locale, "guardrail")}</dt>
              <dd>
                {entry.automatic_decision.secret_exposure_risk
                  ? text(props.locale, "secretExposureRisk")
                  : text(props.locale, "guardrailNone")}
              </dd>
            </div>
          </dl>
        </section>

        <AcpTraceCard locale={props.locale} trace={suggestionTrace} />
        <ClaudeTraceCard locale={props.locale} trace={suggestionTrace} />

        <section
          className="detail-section detail-section-wide"
          data-testid="resolved-auto-audit-card"
        >
          <div
            className="detail-section-header"
            data-testid="resolved-auto-audit-card-header"
          >
            <h3>{text(props.locale, "requestAudit")}</h3>
            <span data-testid="resolved-auto-audit-count">
              {text(props.locale, "eventCount", {
                count: selectedAuditRecords.length,
              })}
            </span>
          </div>
          <AuditList
            emptyMessage={text(props.locale, "noRequestAudit")}
            locale={props.locale}
            records={selectedAuditRecords}
            testId="resolved-auto-audit-list"
          />
        </section>
        <ProviderRuntimeCard
          actualProviderKind={actualProviderKind}
          configuredProviderKind={props.settings?.provider_kind ?? null}
          locale={props.locale}
          providerCalled={entry.automatic_decision.provider_called}
          renderedPrompt={suggestionTrace?.rendered_prompt ?? null}
          providerTrace={suggestionTrace?.provider_trace ?? null}
          testIdPrefix="resolved-auto"
        />
      </div>
    </>
  );
}

export function ResolvedReviewDetail(props: {
  locale: Locale;
  entry: ResolvedReviewRequestView | null;
  settings: DesktopSettings | null;
  recentAuditRecords: AuditRecord[];
}): JSX.Element {
  const entry = props.entry;
  if (!entry) {
    return (
      <div
        className="detail-empty-state"
        data-testid="request-detail-empty-state"
      >
        <h2>{text(props.locale, "noPendingRequest")}</h2>
      </div>
    );
  }

  const selectedAuditRecords = getRequestAuditRecords(
    props.recentAuditRecords,
    entry.request_id,
  );
  const suggestionSummary = getSuggestionSummary(selectedAuditRecords);
  const suggestionTrace = getSuggestionTrace(selectedAuditRecords);
  const providerLabel = suggestionSummary?.provider_model
    ? `${suggestionSummary.provider_kind ? label(props.locale, suggestionSummary.provider_kind) : text(props.locale, "provider")} / ${suggestionSummary.provider_model}`
    : suggestionSummary?.provider_kind
      ? label(props.locale, suggestionSummary.provider_kind)
      : text(props.locale, "notAvailable");
  const providerCalled =
    suggestionSummary !== null
      ? true
      : entry.policy_mode === "manual_only"
        ? false
        : null;
  const actualProviderKind =
    suggestionTrace?.provider_kind ?? suggestionSummary?.provider_kind ?? null;
  const decisionValue = entry.final_decision ?? entry.approval_status;
  const statusValue = entry.approval_status ?? entry.final_decision;

  return (
    <>
      <div
        className="detail-header"
        data-testid="resolved-review-detail-header"
      >
        <div className="detail-title-group">
          <h2>{getResolvedReviewTitle(props.locale, entry)}</h2>
          {entry.reason ? (
            <p className="detail-reason" data-testid="resolved-review-reason">
              {entry.reason}
            </p>
          ) : null}
          <div
            className="detail-meta"
            data-testid="resolved-review-detail-overview"
          >
            <span data-testid="resolved-review-requester">
              {entry.requested_by ?? text(props.locale, "system")}
            </span>
            <span data-testid="resolved-review-recorded-at">
              {elapsedLabel(props.locale, entry.recorded_at)}
            </span>
            <span
              className="id-pill"
              data-testid="resolved-review-request-id-pill"
            >
              {formatShortId(entry.request_id)}
            </span>
          </div>
        </div>
        <div className="badge-row" data-testid="resolved-review-detail-badges">
          <Badge
            kind="approval_status"
            label={label(props.locale, statusValue ?? "pending")}
            testId="resolved-review-approval-status"
            tone={getDecisionTone(statusValue)}
            value={statusValue}
          />
          <Badge
            kind="final_decision"
            label={decisionLabel(props.locale, decisionValue)}
            testId="resolved-review-final-decision"
            tone={getDecisionTone(decisionValue)}
            value={decisionValue}
          />
        </div>
      </div>

      <div className="detail-grid">
        <section
          className="detail-section"
          data-testid="resolved-review-decision-card"
        >
          <div
            className="detail-section-header"
            data-testid="resolved-review-decision-card-header"
          >
            <h3>{text(props.locale, "decision")}</h3>
            <span data-testid="resolved-review-reviewed-by">
              {entry.reviewed_by ?? text(props.locale, "notAvailable")}
            </span>
          </div>
          <dl className="facts" data-testid="resolved-review-decision-facts">
            <div data-testid="resolved-review-fact-submitted">
              <dt>{text(props.locale, "submitted")}</dt>
              <dd>
                {timestampLabel(props.locale, entry.submitted_at, "unknown")}
              </dd>
            </div>
            <div data-testid="resolved-review-fact-resolved">
              <dt>{text(props.locale, "resolved")}</dt>
              <dd>
                {timestampLabel(props.locale, entry.recorded_at, "unknown")}
              </dd>
            </div>
          </dl>
          {entry.decision_note ? (
            <p
              className="suggestion-summary"
              data-testid="resolved-review-decision-note"
            >
              {entry.decision_note}
            </p>
          ) : null}
        </section>

        <section
          className="detail-section"
          data-testid="resolved-review-summary-card"
        >
          <div
            className="detail-section-header"
            data-testid="resolved-review-summary-card-header"
          >
            <h3>{text(props.locale, "summary")}</h3>
            <span data-testid="resolved-review-policy-mode">
              {entry.policy_mode
                ? label(props.locale, entry.policy_mode)
                : text(props.locale, "notAvailable")}
            </span>
          </div>
          <dl className="facts" data-testid="resolved-review-facts-list">
            <div data-testid="resolved-review-fact-created">
              <dt>{text(props.locale, "created")}</dt>
              <dd>
                {timestampLabel(props.locale, entry.submitted_at, "unknown")}
              </dd>
            </div>
            <div data-testid="resolved-review-fact-recorded">
              <dt>{text(props.locale, "recorded")}</dt>
              <dd>
                {timestampLabel(props.locale, entry.recorded_at, "unknown")}
              </dd>
            </div>
            <div data-testid="resolved-review-fact-provider">
              <dt>{text(props.locale, "provider")}</dt>
              <dd>{providerLabel}</dd>
            </div>
            <div data-testid="resolved-review-fact-requester">
              <dt>{text(props.locale, "request")}</dt>
              <dd>
                {entry.requested_by ?? text(props.locale, "notAvailable")}
              </dd>
            </div>
          </dl>
        </section>

        <ResolvedSuggestionCard
          locale={props.locale}
          suggestion={suggestionSummary}
        />
        <AcpTraceCard locale={props.locale} trace={suggestionTrace} />
        <ClaudeTraceCard locale={props.locale} trace={suggestionTrace} />

        <section
          className="detail-section detail-section-wide"
          data-testid="resolved-review-audit-card"
        >
          <div
            className="detail-section-header"
            data-testid="resolved-review-audit-card-header"
          >
            <h3>{text(props.locale, "requestAudit")}</h3>
            <span data-testid="resolved-review-audit-count">
              {text(props.locale, "eventCount", {
                count: selectedAuditRecords.length,
              })}
            </span>
          </div>
          <AuditList
            emptyMessage={text(props.locale, "noRequestAudit")}
            locale={props.locale}
            records={selectedAuditRecords}
            testId="resolved-review-audit-list"
          />
        </section>
        <ProviderRuntimeCard
          actualProviderKind={actualProviderKind}
          configuredProviderKind={props.settings?.provider_kind ?? null}
          locale={props.locale}
          providerCalled={providerCalled}
          renderedPrompt={suggestionTrace?.rendered_prompt ?? null}
          providerTrace={suggestionTrace?.provider_trace ?? null}
          testIdPrefix="resolved-review"
        />
      </div>
    </>
  );
}

function SettingsField(props: {
  field: keyof DesktopSettings;
  labelText: string;
  type: "number" | "password" | "text";
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  autoComplete?: string;
  min?: string;
  step?: string;
  textarea?: boolean;
}): JSX.Element {
  return (
    <label
      className={`settings-field${props.textarea ? " settings-field-wide" : ""}`}
      data-testid={`settings-field-${props.field}`}
    >
      <span className="field-label">{props.labelText}</span>
      {props.textarea ? (
        <StableTextarea
          className="settings-input note-field"
          dataSettingsField={props.field}
          disabled={props.disabled}
          onChange={props.onChange}
          rows={3}
          value={props.value}
        />
      ) : (
        <input
          autoComplete={props.autoComplete}
          className="settings-input"
          data-settings-field={props.field}
          disabled={props.disabled}
          min={props.min}
          onChange={(event) => {
            props.onChange(event.currentTarget.value);
          }}
          step={props.step}
          type={props.type}
          value={props.value}
        />
      )}
    </label>
  );
}

export function SettingsModal(props: {
  locale: Locale;
  settings: DesktopSettings | null;
  settingsDraft: DesktopSettings | null;
  isOpen: boolean;
  isLoading: boolean;
  isSaving: boolean;
  errorMessage: string | null;
  noticeMessage: string | null;
  canSave: boolean;
  onClose: () => void;
  onSave: () => void;
  onPolicyModeChange: (value: string) => void;
  onProviderKindChange: (value: string) => void;
  onFieldChange: (field: keyof DesktopSettings, value: string) => void;
}): JSX.Element | null {
  const panelRef = useRef<HTMLElement | null>(null);
  const scrollTopRef = useRef(0);

  useEffect(() => {
    if (!props.isOpen) {
      scrollTopRef.current = 0;
      return;
    }

    if (panelRef.current) {
      panelRef.current.scrollTop = scrollTopRef.current;
    }
  });

  if (!props.isOpen) {
    return null;
  }

  const currentPolicyMode =
    props.settingsDraft?.default_policy_mode ??
    props.settings?.default_policy_mode ??
    "manual_only";
  const currentProviderKind =
    props.settingsDraft?.provider_kind ?? props.settings?.provider_kind ?? null;
  const acpSummary = buildAcpProgramSummary(
    props.settingsDraft ?? props.settings,
  );
  const disabled = props.isLoading || props.isSaving;

  return (
    <div
      className="modal-backdrop"
      data-testid="settings-modal-backdrop"
      role="presentation"
    >
      <section
        aria-labelledby="settingsModalTitle"
        aria-modal="true"
        className="modal-panel"
        data-testid="settings-modal"
        onScroll={(event) => {
          scrollTopRef.current = event.currentTarget.scrollTop;
        }}
        ref={panelRef}
        role="dialog"
      >
        <div className="modal-header" data-testid="settings-modal-header">
          <div className="modal-title-group">
            <h2 id="settingsModalTitle">
              {text(props.locale, "settingsTitle")}
            </h2>
            <div className="settings-pill-row">
              <span
                className="toolbar-count"
                data-testid="settings-current-policy"
              >
                {`${text(props.locale, "settingsCurrentPolicy")}: ${label(props.locale, currentPolicyMode)}`}
              </span>
              <span
                className="toolbar-count"
                data-testid="settings-current-provider"
              >
                {`${text(props.locale, "settingsCurrentProvider")}: ${providerLabelOrFallback(props.locale, currentProviderKind)}`}
              </span>
            </div>
          </div>
          <button
            className="ghost"
            data-testid="close-settings-button"
            disabled={props.isSaving}
            id="closeSettingsButton"
            onClick={props.onClose}
            type="button"
          >
            {text(props.locale, "close")}
          </button>
        </div>

        {props.errorMessage ? (
          <section
            className="alert"
            data-testid="settings-error-banner"
            role="alert"
          >
            <p data-testid="settings-error-message">{props.errorMessage}</p>
          </section>
        ) : null}

        {props.noticeMessage ? (
          <section
            className="alert"
            data-testid="settings-notice-banner"
            role="status"
          >
            <p data-testid="settings-notice-message">{props.noticeMessage}</p>
          </section>
        ) : null}

        <div className="modal-grid" data-testid="settings-modal-grid">
          <section
            className="detail-section"
            data-testid="settings-policy-section"
          >
            <div className="detail-section-header">
              <h3>{text(props.locale, "settingsPolicyTitle")}</h3>
              <span data-testid="settings-policy-status">
                {props.isSaving
                  ? text(props.locale, "saving")
                  : props.isLoading
                    ? text(props.locale, "syncRefreshing")
                    : text(props.locale, "settingsSavedPolicy")}
              </span>
            </div>
            <p className="section-copy" data-testid="settings-policy-help">
              {text(props.locale, "settingsPolicyHelp")}
            </p>
            <div
              className="settings-option-list"
              data-testid="settings-policy-options"
            >
              {getPolicyOptions(props.locale).map((option) => (
                <label
                  className={`settings-option ${
                    currentPolicyMode === option.value ? "active" : ""
                  }`}
                  data-policy-mode={option.value}
                  data-testid="settings-policy-option"
                  key={option.value}
                >
                  <input
                    checked={currentPolicyMode === option.value}
                    disabled={disabled}
                    name="defaultPolicyMode"
                    onChange={() => {
                      props.onPolicyModeChange(option.value);
                    }}
                    type="radio"
                    value={option.value}
                  />
                  <div className="settings-option-copy">
                    <strong>{option.title}</strong>
                    <p>{option.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </section>

          <section
            className="detail-section"
            data-testid="settings-provider-section"
          >
            <div className="detail-section-header">
              <h3>{text(props.locale, "settingsProviderTitle")}</h3>
              <span data-testid="settings-provider-status">
                {providerLabelOrFallback(props.locale, currentProviderKind)}
              </span>
            </div>
            <p className="section-copy" data-testid="settings-provider-help">
              {text(props.locale, "settingsProviderHelp")}
            </p>
            <div
              className="settings-placeholder"
              data-testid="settings-provider-internal-help"
            >
              <p>{text(props.locale, "settingsProviderInternalHelp")}</p>
            </div>
            <div
              className="settings-option-list"
              data-testid="settings-provider-options"
            >
              {getProviderOptions(props.locale).map((option) => (
                <label
                  className={`settings-option ${
                    currentProviderKind === option.value ? "active" : ""
                  }`}
                  data-provider-kind={option.value}
                  data-testid="settings-provider-option"
                  key={option.value}
                >
                  <input
                    checked={currentProviderKind === option.value}
                    disabled={disabled}
                    name="providerKind"
                    onChange={() => {
                      props.onProviderKindChange(option.value);
                    }}
                    type="radio"
                    value={option.value}
                  />
                  <div className="settings-option-copy">
                    <strong>{option.title}</strong>
                    <p>{option.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </section>

          <section
            className="detail-section"
            data-testid="settings-openai-section"
          >
            <div className="detail-section-header">
              <h3>{text(props.locale, "settingsOpenAiTitle")}</h3>
              <span>{label(props.locale, "openai_compatible")}</span>
            </div>
            <p className="section-copy">
              {text(props.locale, "providerOpenAiDesc")}
            </p>
            <div className="settings-form-grid">
              <SettingsField
                autoComplete="url"
                disabled={disabled}
                field="openai_api_base"
                labelText={text(props.locale, "openAiBase")}
                onChange={(value) => {
                  props.onFieldChange("openai_api_base", value);
                }}
                type="text"
                value={props.settingsDraft?.openai_api_base ?? ""}
              />
              <SettingsField
                autoComplete="off"
                disabled={disabled}
                field="openai_api_key"
                labelText={text(props.locale, "openAiApiKey")}
                onChange={(value) => {
                  props.onFieldChange("openai_api_key", value);
                }}
                type="password"
                value={props.settingsDraft?.openai_api_key ?? ""}
              />
              <SettingsField
                autoComplete="off"
                disabled={disabled}
                field="openai_model"
                labelText={text(props.locale, "openAiModel")}
                onChange={(value) => {
                  props.onFieldChange("openai_model", value);
                }}
                type="text"
                value={props.settingsDraft?.openai_model ?? ""}
              />
              <SettingsField
                disabled={disabled}
                field="openai_temperature"
                labelText={text(props.locale, "openAiTemperature")}
                min="0"
                onChange={(value) => {
                  props.onFieldChange("openai_temperature", value);
                }}
                step="0.1"
                type="number"
                value={String(props.settingsDraft?.openai_temperature ?? 0)}
              />
            </div>
          </section>

          <section
            className="detail-section"
            data-testid="settings-claude-section"
          >
            <div className="detail-section-header">
              <h3>{text(props.locale, "settingsClaudeTitle")}</h3>
              <span>{label(props.locale, "claude")}</span>
            </div>
            <p className="section-copy">
              {text(props.locale, "providerClaudeDesc")}
            </p>
            <div className="settings-form-grid">
              <SettingsField
                autoComplete="url"
                disabled={disabled}
                field="claude_api_base"
                labelText={text(props.locale, "claudeBase")}
                onChange={(value) => {
                  props.onFieldChange("claude_api_base", value);
                }}
                type="text"
                value={props.settingsDraft?.claude_api_base ?? ""}
              />
              <SettingsField
                autoComplete="off"
                disabled={disabled}
                field="claude_api_key"
                labelText={text(props.locale, "claudeApiKey")}
                onChange={(value) => {
                  props.onFieldChange("claude_api_key", value);
                }}
                type="password"
                value={props.settingsDraft?.claude_api_key ?? ""}
              />
              <SettingsField
                autoComplete="off"
                disabled={disabled}
                field="claude_model"
                labelText={text(props.locale, "claudeModel")}
                onChange={(value) => {
                  props.onFieldChange("claude_model", value);
                }}
                type="text"
                value={props.settingsDraft?.claude_model ?? ""}
              />
              <SettingsField
                autoComplete="off"
                disabled={disabled}
                field="claude_anthropic_version"
                labelText={text(props.locale, "claudeApiVersion")}
                onChange={(value) => {
                  props.onFieldChange("claude_anthropic_version", value);
                }}
                type="text"
                value={props.settingsDraft?.claude_anthropic_version ?? ""}
              />
              <SettingsField
                disabled={disabled}
                field="claude_max_tokens"
                labelText={text(props.locale, "claudeMaxTokens")}
                min="1"
                onChange={(value) => {
                  props.onFieldChange("claude_max_tokens", value);
                }}
                step="1"
                type="number"
                value={String(props.settingsDraft?.claude_max_tokens ?? 1)}
              />
              <SettingsField
                disabled={disabled}
                field="claude_temperature"
                labelText={text(props.locale, "claudeTemperature")}
                min="0"
                onChange={(value) => {
                  props.onFieldChange("claude_temperature", value);
                }}
                step="0.1"
                type="number"
                value={String(props.settingsDraft?.claude_temperature ?? 0)}
              />
              <SettingsField
                disabled={disabled}
                field="claude_timeout_secs"
                labelText={text(props.locale, "claudeTimeout")}
                min="1"
                onChange={(value) => {
                  props.onFieldChange("claude_timeout_secs", value);
                }}
                step="1"
                type="number"
                value={String(props.settingsDraft?.claude_timeout_secs ?? 1)}
              />
            </div>
          </section>

          <section
            className="detail-section"
            data-testid="settings-acp-section"
          >
            <div className="detail-section-header">
              <h3>{text(props.locale, "settingsAcpTitle")}</h3>
              <span>{label(props.locale, "acp")}</span>
            </div>
            <p className="section-copy">
              {text(props.locale, "providerAcpDesc")}
            </p>
            <div
              className="settings-placeholder"
              data-testid="settings-acp-summary"
            >
              <dl className="facts">
                <div data-testid="settings-acp-default-starter">
                  <dt>{text(props.locale, "acpDefaultStarter")}</dt>
                  <dd>{acpSummary.defaultCommand}</dd>
                </div>
                <div data-testid="settings-acp-current-program">
                  <dt>{text(props.locale, "acpCurrentProgram")}</dt>
                  <dd>{acpSummary.currentProgram}</dd>
                </div>
                <div data-testid="settings-acp-current-args">
                  <dt>{text(props.locale, "acpCurrentArgs")}</dt>
                  <dd>{acpSummary.currentArgs}</dd>
                </div>
                <div data-testid="settings-acp-client-mode">
                  <dt>{text(props.locale, "acpClientMode")}</dt>
                  <dd>
                    {acpSummary.usesDefaultStarter
                      ? text(props.locale, "acpUsesDefaultStarter")
                      : text(props.locale, "acpUsesCustomClient")}
                  </dd>
                </div>
              </dl>
            </div>
            <div className="settings-form-grid">
              <SettingsField
                autoComplete="off"
                disabled={disabled}
                field="acp_codex_program"
                labelText={text(props.locale, "acpProgram")}
                onChange={(value) => {
                  props.onFieldChange("acp_codex_program", value);
                }}
                type="text"
                value={props.settingsDraft?.acp_codex_program ?? ""}
              />
              <SettingsField
                disabled={disabled}
                field="acp_codex_args"
                labelText={text(props.locale, "acpArgs")}
                onChange={(value) => {
                  props.onFieldChange("acp_codex_args", value);
                }}
                textarea
                type="text"
                value={props.settingsDraft?.acp_codex_args ?? ""}
              />
              <SettingsField
                disabled={disabled}
                field="acp_timeout_secs"
                labelText={text(props.locale, "acpTimeout")}
                min="1"
                onChange={(value) => {
                  props.onFieldChange("acp_timeout_secs", value);
                }}
                step="1"
                type="number"
                value={String(props.settingsDraft?.acp_timeout_secs ?? 1)}
              />
            </div>
          </section>

          <section
            className="detail-section detail-section-low"
            data-testid="settings-llm-section"
          >
            <div className="detail-section-header">
              <h3>{text(props.locale, "settingsLlmTitle")}</h3>
              <span>{text(props.locale, "settingsSavedSuccess")}</span>
            </div>
            <p className="section-copy" data-testid="settings-llm-help">
              {text(props.locale, "settingsLlmHelp")}
            </p>
            <div
              className="settings-placeholder"
              data-testid="settings-env-override-help"
            >
              <p>{text(props.locale, "settingsEnvOverrideHelp")}</p>
            </div>
            <div className="settings-form-grid">
              <SettingsField
                disabled={disabled}
                field="request_template"
                labelText={text(props.locale, "settingsRequestTemplate")}
                onChange={(value) => {
                  props.onFieldChange("request_template", value);
                }}
                textarea
                type="text"
                value={props.settingsDraft?.request_template ?? ""}
              />
              <SettingsField
                disabled={disabled}
                field="llm_advice_template"
                labelText={text(props.locale, "settingsLlmAdviceTemplate")}
                onChange={(value) => {
                  props.onFieldChange("llm_advice_template", value);
                }}
                textarea
                type="text"
                value={props.settingsDraft?.llm_advice_template ?? ""}
              />
            </div>
            <div
              className="settings-placeholder"
              data-testid="settings-template-variables-help"
            >
              <p>{text(props.locale, "settingsTemplateVariables")}</p>
            </div>
          </section>
        </div>

        <div className="modal-actions" data-testid="settings-modal-actions">
          <button
            className="primary"
            data-testid="save-settings-button"
            disabled={!props.canSave}
            id="saveSettingsButton"
            onClick={props.onSave}
            type="button"
          >
            {props.isSaving
              ? text(props.locale, "saving")
              : text(props.locale, "save")}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function App(): JSX.Element {
  const [activeView, setActiveView] = useState<AppView>("approvals");
  const [isCompactModeDismissed, setIsCompactModeDismissed] = useState(false);
  const {
    state,
    canSaveSettings,
    closeSettings,
    decide,
    dismissError,
    openSettings,
    refreshDashboard,
    saveSettings,
    selectPendingRequest,
    selectResolvedAuto,
    selectResolvedRequest,
    setLocale,
    setNoteDraft,
    setPolicyMode,
    setProviderKind,
    updateSettingsField,
  } = useDesktopApp();

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
  const selectedResolvedReview =
    state.selectedDetail?.kind === "resolved_request"
      ? (resolvedReviewEntries.find(
          (entry) => entry.request_id === state.selectedDetail?.id,
        ) ?? null)
      : null;
  const selectedResolvedAuto =
    state.selectedDetail?.kind === "resolved_auto"
      ? (resolvedAutoEntries.find(
          (entry) => entry.request_id === state.selectedDetail?.id,
        ) ?? null)
      : null;
  const summary = getDashboardSummary(state.dashboard);
  const uiState = getUiStateValue({
    isLoading: state.isLoading,
    isRefreshing: state.isRefreshing,
    isSubmitting: state.isSubmitting,
    hasDashboard: state.dashboard !== null,
  });

  useEffect(() => {
    if (!state.lastHandoffRequestId) {
      return;
    }

    setActiveView("approvals");
    setIsCompactModeDismissed(false);
  }, [state.lastHandoffRequestId]);

  const isApprovalView = activeView === "approvals";
  const isCompactApprovalView =
    isApprovalView &&
    !isCompactModeDismissed &&
    Boolean(state.lastHandoffRequestId) &&
    summary.pendingCount === 1 &&
    state.selectedDetail?.kind === "pending_request" &&
    selectedRequest?.id === state.lastHandoffRequestId;
  const toolbarHeading = isApprovalView
    ? text(state.locale, "toolbarTitle")
    : text(state.locale, "passwordManagement");

  const detail = selectedResolvedReview ? (
    <ResolvedReviewDetail
      entry={selectedResolvedReview}
      locale={state.locale}
      recentAuditRecords={state.dashboard?.recent_audit_records ?? []}
      settings={state.settings}
    />
  ) : selectedResolvedAuto ? (
    <ResolvedAutoDetail
      entry={selectedResolvedAuto}
      locale={state.locale}
      recentAuditRecords={state.dashboard?.recent_audit_records ?? []}
      settings={state.settings}
    />
  ) : (
    <PendingRequestDetail
      isSubmitting={state.isSubmitting}
      lastUpdatedAt={state.lastUpdatedAt}
      locale={state.locale}
      noteDraft={state.noteDraft}
      onDecide={(requestId, decision) => {
        void decide(requestId, decision);
      }}
      onNoteChange={setNoteDraft}
      pendingDecision={state.pendingDecision}
      recentAuditRecords={state.dashboard?.recent_audit_records ?? []}
      request={selectedRequest}
      settings={state.settings}
      showAudit={!isCompactApprovalView}
      showProviderDiagnostics={!isCompactApprovalView}
    />
  );

  return (
    <main
      aria-busy={
        state.isLoading || state.isRefreshing || state.isSubmitting
          ? "true"
          : "false"
      }
      className="shell min-h-screen"
      data-approval-layout={isCompactApprovalView ? "compact" : "full"}
      data-testid="approval-console"
      data-ui-state={uiState}
    >
      <header className="toolbar" data-testid="console-hero">
        <div className="toolbar-title">
          <div className="toolbar-heading">
            <h1>{toolbarHeading}</h1>
            {isApprovalView && !isCompactApprovalView ? (
              <span
                className="toolbar-count"
                data-queue-count={summary.pendingCount}
                data-testid="pending-queue-count"
              >
                {text(state.locale, "openCount", {
                  count: summary.pendingCount,
                })}
              </span>
            ) : null}
          </div>
          {!isCompactApprovalView ? (
            <div
              aria-label={text(state.locale, "toolbarTitle")}
              className="toolbar-nav"
              data-testid="app-view-switcher"
              role="group"
            >
              <button
                aria-pressed={isApprovalView ? "true" : "false"}
                className={`ghost toolbar-tab ${isApprovalView ? "active" : ""}`}
                data-testid="view-tab-approvals"
                onClick={() => {
                  setActiveView("approvals");
                }}
                type="button"
              >
                {text(state.locale, "approvalsTab")}
              </button>
              <button
                aria-pressed={!isApprovalView ? "true" : "false"}
                className={`ghost toolbar-tab ${!isApprovalView ? "active" : ""}`}
                data-testid="view-tab-password-management"
                onClick={() => {
                  setActiveView("password_management");
                }}
                type="button"
              >
                {text(state.locale, "passwordManagement")}
              </button>
            </div>
          ) : (
            <p className="toolbar-compact-copy" data-testid="compact-mode-copy">
              {text(state.locale, "compactApprovalMode")}
            </p>
          )}
        </div>
        <div className="toolbar-actions">
          {isCompactApprovalView ? (
            <button
              className="ghost"
              data-testid="expand-approval-layout-button"
              onClick={() => {
                setIsCompactModeDismissed(true);
              }}
              type="button"
            >
              {text(state.locale, "expandFullView")}
            </button>
          ) : null}
          <button
            className="ghost"
            data-testid="open-settings-button"
            disabled={state.isSettingsSaving}
            id="openSettingsButton"
            onClick={openSettings}
            type="button"
          >
            {text(state.locale, "settings")}
          </button>
          <div
            aria-label={text(state.locale, "localeSwitchAria")}
            className="locale-switch"
            data-testid="locale-switcher"
            role="group"
          >
            <button
              aria-pressed={state.locale === "en" ? "true" : "false"}
              className={`ghost locale-button ${
                state.locale === "en" ? "active" : ""
              }`}
              data-testid="locale-button-en"
              onClick={() => {
                setLocale("en");
              }}
              type="button"
            >
              EN
            </button>
            <button
              aria-pressed={state.locale === "zh-CN" ? "true" : "false"}
              className={`ghost locale-button ${
                state.locale === "zh-CN" ? "active" : ""
              }`}
              data-testid="locale-button-zh"
              onClick={() => {
                setLocale("zh-CN");
              }}
              type="button"
            >
              中文
            </button>
          </div>
          {isApprovalView ? (
            <>
              <div
                className="hero-status"
                data-sync-state={uiState}
                data-testid="sync-status"
                role="status"
              >
                <Badge
                  kind="sync_state"
                  label={
                    state.isSubmitting
                      ? text(state.locale, "syncSubmitting")
                      : state.isRefreshing
                        ? text(state.locale, "syncRefreshing")
                        : text(state.locale, "syncReady")
                  }
                  testId="sync-status-badge"
                  tone={
                    state.isSubmitting || state.isRefreshing
                      ? "pending"
                      : "neutral"
                  }
                  value={uiState}
                />
                <span data-testid="sync-timestamp">
                  {timestampLabel(state.locale, state.lastUpdatedAt, "waiting")}
                </span>
              </div>
              <button
                aria-label={text(state.locale, "refreshQueueAria")}
                className="ghost"
                data-testid="refresh-queue-button"
                disabled={state.isSubmitting}
                id="refreshButton"
                onClick={() => {
                  void refreshDashboard();
                }}
                type="button"
              >
                {text(state.locale, "refresh")}
              </button>
            </>
          ) : null}
        </div>
      </header>

      {state.errorMessage ? (
        <section
          aria-live="polite"
          className="alert"
          data-testid="sync-error-banner"
          role="alert"
        >
          <p data-testid="sync-error-message">{state.errorMessage}</p>
          <button
            aria-label={text(state.locale, "dismissErrorAria")}
            className="ghost"
            data-testid="dismiss-error-button"
            onClick={dismissError}
            type="button"
          >
            {text(state.locale, "dismiss")}
          </button>
        </section>
      ) : null}

      {isApprovalView ? (
        <>
          <section
            className={`workspace-grid${isCompactApprovalView ? " workspace-grid-compact" : ""}`}
            data-testid="workspace-grid"
          >
            {!isCompactApprovalView ? (
              <aside
                className="panel queue-panel"
                data-testid="pending-queue-panel"
              >
                <div className="panel-stack" data-testid="sidebar-stack">
                <section
                  className="panel-section"
                  data-testid="pending-queue-section"
                >
                  <div
                    className="panel-header"
                    data-testid="pending-queue-header"
                  >
                    <h2>{text(state.locale, "queue")}</h2>
                    <span data-testid="pending-queue-requester-count">
                      {summary.pendingCount}
                    </span>
                  </div>
                  <div className="queue-list" data-testid="pending-queue-list">
                    {state.isLoading && !state.dashboard ? (
                      <p className="empty" data-testid="pending-queue-loading">
                        {text(state.locale, "loadingQueue")}
                      </p>
                    ) : !state.dashboard ||
                      state.dashboard.pending_requests.length === 0 ? (
                      <p className="empty" data-testid="pending-queue-empty">
                        {text(state.locale, "noPendingRequests")}
                      </p>
                    ) : (
                      state.dashboard.pending_requests.map((request) => {
                        const isActive =
                          state.selectedDetail?.kind === "pending_request" &&
                          state.selectedDetail.id === request.id;

                        return (
                          <button
                            aria-label={text(
                              state.locale,
                              "selectRequestAria",
                              {
                                id: request.id,
                              },
                            )}
                            aria-pressed={isActive ? "true" : "false"}
                            className={`queue-item ${isActive ? "active" : ""}`}
                            data-request-id={request.id}
                            data-selected={isActive ? "true" : "false"}
                            data-testid="queue-item"
                            key={request.id}
                            onClick={() => {
                              selectPendingRequest(request.id);
                            }}
                            type="button"
                          >
                            <div
                              className="queue-item-header"
                              data-testid="queue-item-header"
                            >
                              <strong>{request.context.resource}</strong>
                              <Badge
                                kind="approval_status"
                                label={label(
                                  state.locale,
                                  request.approval_status,
                                )}
                                testId="queue-item-status"
                                tone="pending"
                                value={request.approval_status}
                              />
                            </div>
                            <p className="queue-item-reason">
                              {request.context.reason}
                            </p>
                            <div
                              className="queue-item-meta"
                              data-testid="queue-item-meta"
                            >
                              <span>{request.context.requested_by}</span>
                              <span>
                                {elapsedLabel(state.locale, request.created_at)}
                              </span>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </section>

                <section
                  className="panel-section"
                  data-testid="resolved-review-results-section"
                >
                  <div
                    className="panel-header"
                    data-testid="resolved-review-results-header"
                  >
                    <h2>{text(state.locale, "recentDecisions")}</h2>
                    <span data-testid="resolved-review-results-count">
                      {resolvedReviewEntries.length}
                    </span>
                  </div>
                  <div
                    className="queue-list"
                    data-testid="resolved-review-results-list"
                  >
                    {resolvedReviewEntries.length === 0 ? (
                      <p
                        className="empty"
                        data-testid="resolved-review-results-empty"
                      >
                        {text(state.locale, "noRecentDecisions")}
                      </p>
                    ) : (
                      resolvedReviewEntries.map((entry) => {
                        const isActive =
                          state.selectedDetail?.kind === "resolved_request" &&
                          state.selectedDetail.id === entry.request_id;

                        return (
                          <button
                            aria-label={text(
                              state.locale,
                              "selectResolvedRequestAria",
                              {
                                id: entry.request_id,
                              },
                            )}
                            aria-pressed={isActive ? "true" : "false"}
                            className={`queue-item ${isActive ? "active" : ""}`}
                            data-request-id={entry.request_id}
                            data-selected={isActive ? "true" : "false"}
                            data-testid="resolved-review-item"
                            key={entry.request_id}
                            onClick={() => {
                              selectResolvedRequest(entry.request_id);
                            }}
                            type="button"
                          >
                            <div
                              className="queue-item-header"
                              data-testid="resolved-review-item-header"
                            >
                              <strong>
                                {getResolvedReviewTitle(state.locale, entry)}
                              </strong>
                              <Badge
                                kind="final_decision"
                                label={decisionLabel(
                                  state.locale,
                                  entry.final_decision ?? entry.approval_status,
                                )}
                                testId="resolved-review-item-status"
                                tone={getDecisionTone(
                                  entry.final_decision ?? entry.approval_status,
                                )}
                                value={
                                  entry.final_decision ?? entry.approval_status
                                }
                              />
                            </div>
                            {entry.reason ? (
                              <p
                                className="queue-item-reason"
                                data-testid="resolved-review-item-reason"
                              >
                                {entry.reason}
                              </p>
                            ) : null}
                            <div
                              className="queue-item-meta"
                              data-testid="resolved-review-item-meta"
                            >
                              <span>
                                {entry.requested_by ??
                                  text(state.locale, "system")}
                              </span>
                              <span>
                                {elapsedLabel(state.locale, entry.recorded_at)}
                              </span>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </section>

                <section
                  className="panel-section"
                  data-testid="resolved-auto-results-section"
                >
                  <div
                    className="panel-header"
                    data-testid="resolved-auto-results-header"
                  >
                    <h2>{text(state.locale, "autoResults")}</h2>
                    <span data-testid="resolved-auto-results-count">
                      {resolvedAutoEntries.length}
                    </span>
                  </div>
                  <div
                    className="queue-list"
                    data-testid="resolved-auto-results-list"
                  >
                    {resolvedAutoEntries.length === 0 ? (
                      <p
                        className="empty"
                        data-testid="resolved-auto-results-empty"
                      >
                        {text(state.locale, "noRecentAutoResults")}
                      </p>
                    ) : (
                      resolvedAutoEntries.map((entry) => {
                        const isActive =
                          state.selectedDetail?.kind === "resolved_auto" &&
                          state.selectedDetail.id === entry.request_id;

                        return (
                          <button
                            aria-label={text(
                              state.locale,
                              "selectAutoResultAria",
                              {
                                id: entry.request_id,
                              },
                            )}
                            aria-pressed={isActive ? "true" : "false"}
                            className={`queue-item ${isActive ? "active" : ""}`}
                            data-request-id={entry.request_id}
                            data-selected={isActive ? "true" : "false"}
                            data-testid="resolved-auto-item"
                            key={entry.request_id}
                            onClick={() => {
                              selectResolvedAuto(entry.request_id);
                            }}
                            type="button"
                          >
                            <div
                              className="queue-item-header"
                              data-testid="resolved-auto-item-header"
                            >
                              <strong>
                                {getResolvedAutoTitle(state.locale, entry)}
                              </strong>
                              <Badge
                                kind="auto_disposition"
                                label={label(
                                  state.locale,
                                  entry.automatic_decision.auto_disposition,
                                )}
                                testId="resolved-auto-item-status"
                                tone={getDecisionTone(
                                  entry.automatic_decision.auto_disposition,
                                )}
                                value={
                                  entry.automatic_decision.auto_disposition
                                }
                              />
                            </div>
                            <p
                              className="queue-item-reason"
                              data-testid="resolved-auto-item-summary"
                            >
                              {entry.reason ??
                                entry.automatic_decision.auto_rationale_summary}
                            </p>
                            <div
                              className="queue-item-meta"
                              data-testid="resolved-auto-item-meta"
                            >
                              <span>
                                {entry.requested_by ??
                                  text(state.locale, "system")}
                              </span>
                              <span>
                                {elapsedLabel(state.locale, entry.recorded_at)}
                              </span>
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                </section>
                </div>
              </aside>
            ) : null}

            <section
              className={`panel detail-panel${isCompactApprovalView ? " detail-panel-compact" : ""}`}
              data-detail-kind={state.selectedDetail?.kind ?? "empty"}
              data-policy-mode={
                selectedRequest?.policy_mode ??
                selectedResolvedReview?.policy_mode ??
                ""
              }
              data-selected-request-id={
                selectedRequest?.id ??
                selectedResolvedReview?.request_id ??
                selectedResolvedAuto?.request_id ??
                ""
              }
              data-testid="request-detail-panel"
            >
              {detail}
            </section>
          </section>

          {!isCompactApprovalView ? (
            <section
              className="panel audit-panel"
              data-testid="global-audit-panel"
            >
              <div className="panel-header" data-testid="global-audit-header">
                <h2>{text(state.locale, "audit")}</h2>
                <span data-testid="global-audit-count">{summary.auditCount}</span>
              </div>
              <AuditList
                emptyMessage={text(state.locale, "noAuditEvents")}
                locale={state.locale}
                records={state.dashboard?.recent_audit_records ?? []}
                testId="global-audit-list"
              />
            </section>
          ) : null}
        </>
      ) : (
        <PasswordManagementView locale={state.locale} />
      )}

      <SettingsModal
        canSave={canSaveSettings}
        errorMessage={state.settingsErrorMessage}
        isLoading={state.isSettingsLoading}
        isOpen={state.isSettingsOpen}
        isSaving={state.isSettingsSaving}
        locale={state.locale}
        noticeMessage={state.settingsNoticeMessage}
        onClose={closeSettings}
        onFieldChange={updateSettingsField}
        onPolicyModeChange={setPolicyMode}
        onProviderKindChange={setProviderKind}
        onSave={() => {
          void saveSettings();
        }}
        settings={state.settings}
        settingsDraft={state.settingsDraft}
      />
    </main>
  );
}
