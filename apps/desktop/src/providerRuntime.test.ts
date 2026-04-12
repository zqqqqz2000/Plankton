import { describe, expect, it } from "vitest";

import {
  buildProviderRuntimeSummary,
  deriveTraceProviderKind,
} from "./providerRuntime";

describe("providerRuntime", () => {
  it("treats ACP trace metadata as an active ACP provider", () => {
    const summary = buildProviderRuntimeSummary({
      configuredProviderKind: "acp_codex",
      actualProviderKind: null,
      providerCalled: true,
      providerTrace: {
        transport: "stdio",
        protocol: null,
        api_version: null,
        output_format: null,
        stop_reason: null,
        package_name: "@zed-industries/codex-acp",
        package_version: "0.11.1",
        session_id: "session-1",
        client_request_id: "req-1",
        agent_name: "codex-acp",
        agent_version: "0.11.1",
        beta_headers: [],
      },
    });

    expect(summary.actualProviderKind).toBe("acp_codex");
    expect(summary.state).toBe("active");
  });

  it("reports configured ACP as not called when the request never reached a provider", () => {
    const summary = buildProviderRuntimeSummary({
      configuredProviderKind: "acp_codex",
      actualProviderKind: null,
      providerCalled: false,
      providerTrace: null,
    });

    expect(summary.state).toBe("configured_not_called");
  });

  it("reports runtime override when the configured provider and actual provider differ", () => {
    const summary = buildProviderRuntimeSummary({
      configuredProviderKind: "acp_codex",
      actualProviderKind: "claude",
      providerCalled: true,
      providerTrace: {
        transport: "https",
        protocol: "anthropic_messages",
        api_version: "2023-06-01",
        output_format: "json_schema",
        stop_reason: "end_turn",
        package_name: null,
        package_version: null,
        session_id: null,
        client_request_id: null,
        agent_name: null,
        agent_version: null,
        beta_headers: [],
      },
    });

    expect(summary.state).toBe("configured_overridden");
    expect(summary.actualProviderKind).toBe("claude");
  });

  it("derives Claude from provider trace when provider_kind is absent", () => {
    expect(
      deriveTraceProviderKind(null, {
        transport: "https",
        protocol: "anthropic_messages",
        api_version: "2023-06-01",
        output_format: "json_schema",
        stop_reason: "end_turn",
        package_name: null,
        package_version: null,
        session_id: null,
        client_request_id: null,
        agent_name: null,
        agent_version: null,
        beta_headers: [],
      }),
    ).toBe("claude");
  });
});
