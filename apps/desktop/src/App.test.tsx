// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  PendingRequestDetail,
  ResolvedAutoDetail,
  ResolvedReviewDetail,
  SettingsModal,
} from "./App";
import type {
  ResolvedAutoDecisionView,
  ResolvedReviewRequestView,
} from "./dashboardModel";
import type { AccessRequest, AuditRecord, DesktopSettings } from "./types";

type RenderHarness = {
  container: HTMLDivElement;
  rerender: (node: ReactNode) => void;
  unmount: () => void;
};

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
});

const BASE_SETTINGS: DesktopSettings = {
  locale: "en",
  default_policy_mode: "assisted",
  provider_kind: "claude",
  request_template: "Review {{ context.resource }}",
  llm_advice_template: "Advise on {{ context.resource }}",
  openai_api_base: "https://api.openai.test/v1",
  openai_api_key: "openai-key",
  openai_model: "gpt-5.4",
  openai_temperature: 0.2,
  claude_api_base: "https://api.anthropic.test",
  claude_api_key: "claude-key",
  claude_model: "claude-sonnet-4",
  claude_anthropic_version: "2023-06-01",
  claude_max_tokens: 4096,
  claude_temperature: 0.1,
  claude_timeout_secs: 30,
  acp_codex_program: "npx",
  acp_codex_args: "-y @zed-industries/codex-acp@0.11.1",
  acp_timeout_secs: 20,
};

function render(node: ReactNode): RenderHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);

  act(() => {
    root.render(node);
  });

  return {
    container,
    rerender(nextNode) {
      act(() => {
        root.render(nextNode);
      });
    },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function buildPendingRequest(): AccessRequest {
  return {
    id: "req-pending-1",
    context: {
      resource: "secret/demo",
      reason: "Need database credentials",
      requested_by: "alice",
      script_path: "/tmp/request.sh",
      call_chain: [],
      env_vars: {},
      metadata: {},
      created_at: "2026-04-13T04:00:00.000Z",
    },
    policy_mode: "assisted",
    approval_status: "pending",
    final_decision: null,
    provider_kind: "acp",
    rendered_prompt: "",
    llm_suggestion: {
      template_id: "tpl-1",
      template_version: "v1",
      prompt_contract_version: "pc-1",
      prompt_sha256: "sha",
      suggested_decision: "allow",
      rationale_summary: "Looks safe",
      risk_score: 12,
      provider_kind: "acp",
      provider_model: "codex",
      provider_response_id: "resp-1",
      x_request_id: "x-req-1",
      provider_trace: {
        rendered_prompt: "Review secret/demo",
        transport: "stdio",
        protocol: null,
        api_version: null,
        output_format: null,
        stop_reason: null,
        package_name: "@zed-industries/codex-acp",
        package_version: "0.11.1",
        session_id: "session-1",
        client_request_id: "client-1",
        agent_name: "Codex",
        agent_version: "5.4",
        beta_headers: [],
      },
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
      error: null,
      generated_at: "2026-04-13T04:00:01.000Z",
    },
    automatic_decision: null,
    created_at: "2026-04-13T04:00:00.000Z",
    updated_at: "2026-04-13T04:00:02.000Z",
    resolved_at: null,
  };
}

function buildReviewAuditRecords(requestId: string): AuditRecord[] {
  return [
    {
      id: "audit-suggestion-1",
      request_id: requestId,
      action: "llm_suggestion_generated",
      actor: "claude",
      note: "Model suggests approving this request.",
      payload: {
        provider_model: "claude-sonnet-4",
        suggested_decision: "allow",
        risk_score: 18,
        template_version: "v2",
        provider_response_id: "claude-response-1",
        x_request_id: "claude-request-1",
        usage: { total_tokens: 321 },
        provider_trace: {
          rendered_prompt: "Review secret/review",
          protocol: "anthropic_messages",
          api_version: "2023-06-01",
          output_format: "json",
          stop_reason: "end_turn",
        },
      },
      created_at: "2026-04-13T04:01:00.000Z",
    },
    {
      id: "audit-approval-1",
      request_id: requestId,
      action: "approval_recorded",
      actor: "reviewer",
      note: "Approved after confirming scope.",
      payload: {
        approval_status: "approved",
        decision: "allow",
      },
      created_at: "2026-04-13T04:02:00.000Z",
    },
  ];
}

function buildAutoAuditRecords(requestId: string): AuditRecord[] {
  return [
    {
      id: "audit-auto-suggestion-1",
      request_id: requestId,
      action: "llm_suggestion_generated",
      actor: "acp",
      note: "Automatic allow with low risk.",
      payload: {
        provider_model: "codex",
        suggested_decision: "allow",
        risk_score: 8,
        template_version: "v3",
        provider_response_id: "acp-response-1",
        x_request_id: "acp-request-1",
        usage: { total_tokens: 123 },
        provider_trace: {
          rendered_prompt: "Review secret/auto",
          transport: "stdio",
          package_name: "@zed-industries/codex-acp",
          package_version: "0.11.1",
          session_id: "session-2",
          client_request_id: "client-2",
          agent_name: "Codex",
          agent_version: "5.4",
        },
      },
      created_at: "2026-04-13T04:03:00.000Z",
    },
  ];
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("desktop React parity", () => {
  it("keeps the decision note focus and selection across detail rerenders", () => {
    const request = buildPendingRequest();
    const view = render(
      <PendingRequestDetail
        isSubmitting={false}
        lastUpdatedAt="2026-04-13T04:05:00.000Z"
        locale="en"
        noteDraft="hold focus"
        onDecide={() => {}}
        onNoteChange={() => {}}
        pendingDecision={null}
        recentAuditRecords={[]}
        request={request}
        settings={BASE_SETTINGS}
      />,
    );

    const textareaBefore = view.container.querySelector<HTMLTextAreaElement>(
      '[data-testid="decision-note-input"]',
    );
    expect(textareaBefore).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="acp-provider-trace-card"]'),
    ).not.toBeNull();
    const requestRuntimeToggle = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="request-provider-runtime-toggle"]',
    );
    act(() => {
      requestRuntimeToggle?.click();
    });
    expect(
      view.container.querySelector(
        '[data-testid="request-provider-rendered-prompt-block"]',
      )?.textContent,
    ).toContain("Review secret/demo");

    act(() => {
      textareaBefore?.focus();
      textareaBefore?.setSelectionRange(4, 4);
    });

    view.rerender(
      <PendingRequestDetail
        isSubmitting={false}
        lastUpdatedAt="2026-04-13T04:05:05.000Z"
        locale="en"
        noteDraft="hold focus"
        onDecide={() => {}}
        onNoteChange={() => {}}
        pendingDecision={null}
        recentAuditRecords={[]}
        request={request}
        settings={BASE_SETTINGS}
      />,
    );

    const textareaAfter = view.container.querySelector<HTMLTextAreaElement>(
      '[data-testid="decision-note-input"]',
    );
    expect(textareaAfter).toBe(textareaBefore);
    expect(document.activeElement).toBe(textareaAfter);
    expect(textareaAfter?.selectionStart).toBe(4);
    expect(textareaAfter?.selectionEnd).toBe(4);

    view.unmount();
  });

  it("renders full settings parity fields and keeps modal scroll offset on rerender", () => {
    const view = render(
      <SettingsModal
        canSave
        errorMessage={null}
        isLoading={false}
        isOpen
        isSaving={false}
        locale="en"
        noticeMessage={null}
        onClose={() => {}}
        onFieldChange={() => {}}
        onPolicyModeChange={() => {}}
        onProviderKindChange={() => {}}
        onSave={() => {}}
        settings={BASE_SETTINGS}
        settingsDraft={BASE_SETTINGS}
      />,
    );

    const modalBefore = view.container.querySelector<HTMLElement>(
      '[data-testid="settings-modal"]',
    );
    expect(modalBefore).not.toBeNull();

    const requiredIds = [
      "settings-field-openai_api_key",
      "settings-field-openai_temperature",
      "settings-field-claude_api_base",
      "settings-field-claude_api_key",
      "settings-field-claude_anthropic_version",
      "settings-field-claude_max_tokens",
      "settings-field-claude_temperature",
      "settings-field-acp_timeout_secs",
      "settings-acp-client-mode",
      "settings-llm-section",
      "settings-env-override-help",
    ];

    for (const testId of requiredIds) {
      expect(
        view.container.querySelector(`[data-testid="${testId}"]`),
      ).not.toBeNull();
    }
    act(() => {
      if (modalBefore) {
        modalBefore.scrollTop = 180;
        modalBefore.dispatchEvent(new Event("scroll"));
      }
    });

    view.rerender(
      <SettingsModal
        canSave
        errorMessage={null}
        isLoading={false}
        isOpen
        isSaving={false}
        locale="en"
        noticeMessage="Saved"
        onClose={() => {}}
        onFieldChange={() => {}}
        onPolicyModeChange={() => {}}
        onProviderKindChange={() => {}}
        onSave={() => {}}
        settings={BASE_SETTINGS}
        settingsDraft={{ ...BASE_SETTINGS, openai_model: "gpt-5.4-mini" }}
      />,
    );

    const modalAfter = view.container.querySelector<HTMLElement>(
      '[data-testid="settings-modal"]',
    );
    expect(modalAfter).toBe(modalBefore);
    expect(modalAfter?.scrollTop).toBe(180);

    view.unmount();
  });

  it("renders resolved review parity cards with suggestion and trace details", () => {
    const entry: ResolvedReviewRequestView = {
      request_id: "req-review-1",
      resource: "secret/review",
      reason: "Need prod access",
      requested_by: "bob",
      policy_mode: "assisted",
      submitted_at: "2026-04-13T04:00:00.000Z",
      recorded_at: "2026-04-13T04:02:00.000Z",
      approval_status: "approved",
      final_decision: "allow",
      reviewed_by: "reviewer",
      decision_note: "Approved after review",
    };
    const view = render(
      <ResolvedReviewDetail
        entry={entry}
        locale="en"
        recentAuditRecords={buildReviewAuditRecords(entry.request_id)}
        settings={BASE_SETTINGS}
      />,
    );

    const requiredIds = [
      "resolved-review-decision-card",
      "resolved-review-summary-card",
      "resolved-review-suggestion-card",
      "claude-provider-trace-card",
      "resolved-review-audit-card",
    ];

    for (const testId of requiredIds) {
      expect(
        view.container.querySelector(`[data-testid="${testId}"]`),
      ).not.toBeNull();
    }
    const reviewRuntimeToggle = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="resolved-review-provider-runtime-toggle"]',
    );
    act(() => {
      reviewRuntimeToggle?.click();
    });
    expect(
      view.container.querySelector(
        '[data-testid="resolved-review-provider-rendered-prompt-block"]',
      )?.textContent,
    ).toContain("Review secret/review");

    view.unmount();
  });

  it("renders resolved auto parity cards with provider trace details", () => {
    const entry: ResolvedAutoDecisionView = {
      request_id: "req-auto-1",
      resource: "secret/auto",
      reason: "Background access",
      requested_by: "system_auto",
      submitted_at: "2026-04-13T04:00:00.000Z",
      recorded_at: "2026-04-13T04:03:30.000Z",
      approval_status: "approved",
      final_decision: "allow",
      automatic_decision: {
        auto_disposition: "allow",
        decision_source: "llm",
        matched_rule_ids: ["rule-1"],
        secret_exposure_risk: false,
        provider_called: true,
        suggested_decision: "allow",
        risk_score: 8,
        template_id: "tpl-3",
        template_version: "v3",
        prompt_contract_version: "pc-3",
        provider_kind: "acp",
        provider_model: "codex",
        x_request_id: "acp-request-1",
        provider_response_id: "acp-response-1",
        redacted_fields: [],
        redaction_summary: "",
        auto_rationale_summary: "Allowed automatically.",
        fail_closed: false,
        evaluated_at: "2026-04-13T04:03:30.000Z",
      },
    };
    const view = render(
      <ResolvedAutoDetail
        entry={entry}
        locale="en"
        recentAuditRecords={buildAutoAuditRecords(entry.request_id)}
        settings={BASE_SETTINGS}
      />,
    );

    const requiredIds = [
      "resolved-auto-summary-card",
      "resolved-auto-audit-card",
      "acp-provider-trace-card",
    ];

    for (const testId of requiredIds) {
      expect(
        view.container.querySelector(`[data-testid="${testId}"]`),
      ).not.toBeNull();
    }
    const autoRuntimeToggle = view.container.querySelector<HTMLButtonElement>(
      '[data-testid="resolved-auto-provider-runtime-toggle"]',
    );
    act(() => {
      autoRuntimeToggle?.click();
    });
    expect(
      view.container.querySelector(
        '[data-testid="resolved-auto-provider-rendered-prompt-block"]',
      )?.textContent,
    ).toContain("Review secret/auto");

    view.unmount();
  });
});
