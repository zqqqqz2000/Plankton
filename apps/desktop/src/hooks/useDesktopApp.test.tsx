// @vitest-environment jsdom

import { act } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauri.listen,
}));

import App from "../App";
import type { DashboardData, DesktopSettings } from "../types";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
});

type RenderHarness = {
  container: HTMLDivElement;
  unmount: () => void;
};

const SETTINGS: DesktopSettings = {
  default_policy_mode: "assisted",
  provider_kind: "claude",
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

const DASHBOARD: DashboardData = {
  pending_requests: [
    {
      id: "req-pending-1",
      context: {
        resource: "secret/pending",
        reason: "Need current token",
        requested_by: "alice",
        script_path: null,
        call_chain: [],
        env_vars: {},
        metadata: {},
        created_at: "2026-04-13T05:00:00.000Z",
      },
      policy_mode: "assisted",
      approval_status: "pending",
      final_decision: null,
      provider_kind: "claude",
      rendered_prompt: "",
      llm_suggestion: null,
      automatic_decision: null,
      created_at: "2026-04-13T05:00:00.000Z",
      updated_at: "2026-04-13T05:00:01.000Z",
      resolved_at: null,
    },
  ],
  recent_audit_records: [
    {
      id: "submitted-review",
      request_id: "req-review-1",
      action: "request_submitted",
      actor: "bob",
      note: "Need production access",
      payload: {
        resource: "secret/review",
        policy_mode: "assisted",
      },
      created_at: "2026-04-13T04:50:00.000Z",
    },
    {
      id: "suggested-review",
      request_id: "req-review-1",
      action: "llm_suggestion_generated",
      actor: "claude",
      note: "Approve after verification",
      payload: {
        provider_model: "claude-sonnet-4",
        suggested_decision: "allow",
        risk_score: 16,
        template_version: "v2",
        provider_trace: {
          protocol: "anthropic_messages",
          api_version: "2023-06-01",
          output_format: "json",
          stop_reason: "end_turn",
        },
      },
      created_at: "2026-04-13T04:50:10.000Z",
    },
    {
      id: "approved-review",
      request_id: "req-review-1",
      action: "approval_recorded",
      actor: "reviewer",
      note: "Approved after manual review",
      payload: {
        approval_status: "approved",
        decision: "allow",
      },
      created_at: "2026-04-13T04:51:00.000Z",
    },
    {
      id: "submitted-auto",
      request_id: "req-auto-1",
      action: "request_submitted",
      actor: "system_auto",
      note: "Background sync",
      payload: {
        resource: "secret/auto",
        policy_mode: "llm_automatic",
      },
      created_at: "2026-04-13T04:40:00.000Z",
    },
    {
      id: "auto-suggestion",
      request_id: "req-auto-1",
      action: "llm_suggestion_generated",
      actor: "acp",
      note: "Allow automatically",
      payload: {
        provider_model: "codex",
        suggested_decision: "allow",
        risk_score: 8,
        template_version: "v3",
        provider_trace: {
          transport: "stdio",
          package_name: "@zed-industries/codex-acp",
          package_version: "0.11.1",
          session_id: "session-1",
          client_request_id: "client-1",
          agent_name: "Codex",
          agent_version: "5.4",
        },
      },
      created_at: "2026-04-13T04:40:10.000Z",
    },
    {
      id: "decided-auto",
      request_id: "req-auto-1",
      action: "automatic_decision_recorded",
      actor: "system_auto",
      note: "Automatic allow",
      payload: {
        auto_disposition: "allow",
        decision_source: "llm",
        provider_called: true,
        provider_kind: "acp",
        provider_model: "codex",
        evaluated_at: "2026-04-13T04:41:00.000Z",
        approval_status: "approved",
        final_decision: "allow",
      },
      created_at: "2026-04-13T04:41:00.000Z",
    },
  ],
};

function render(): RenderHarness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);

  act(() => {
    root.render(<App />);
  });

  return {
    container,
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(
  element: HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | null,
): void {
  act(() => {
    element?.click();
  });
}

async function clickAsync(element: HTMLButtonElement | null): Promise<void> {
  await act(async () => {
    element?.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setFieldValue(
  element: HTMLInputElement | HTMLTextAreaElement | null,
  value: string,
): void {
  if (!element) {
    throw new Error("Expected field to exist");
  }

  const prototype = Object.getPrototypeOf(element) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  act(() => {
    valueSetter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function getPickerOption(
  container: HTMLElement,
  pickerTestId: string,
  optionId: string,
): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `[data-testid="${pickerTestId}-option"][data-option-id="${optionId}"]`,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  tauri.invoke.mockReset();
  tauri.listen.mockReset();
  tauri.unlisten.mockReset();
  tauri.unlisten.mockImplementation(() => {});
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("useDesktopApp runtime wiring", () => {
  it("does not re-enter mount effects and stabilizes the app shell", async () => {
    const commandCounts = new Map<string, number>();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    tauri.listen.mockImplementation(async () => {
      commandCounts.set("listen", (commandCounts.get("listen") ?? 0) + 1);
      return tauri.unlisten;
    });
    tauri.invoke.mockImplementation(async (command: string) => {
      commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1);

      switch (command) {
        case "dashboard":
          return DASHBOARD;
        case "desktop_settings":
          return SETTINGS;
        case "consume_handoff_request":
          return null;
        case "save_desktop_settings":
          return SETTINGS;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    const view = render();
    await flushReact();

    expect(commandCounts.get("dashboard")).toBe(1);
    expect(commandCounts.get("desktop_settings")).toBe(1);
    expect(commandCounts.get("consume_handoff_request")).toBe(1);
    expect(commandCounts.get("listen")).toBe(1);

    expect(
      view.container.querySelectorAll('[data-testid="queue-item"]'),
    ).toHaveLength(1);
    expect(
      view.container.querySelectorAll('[data-testid="resolved-review-item"]'),
    ).toHaveLength(1);
    expect(
      view.container.querySelectorAll('[data-testid="resolved-auto-item"]'),
    ).toHaveLength(1);
    expect(
      view.container.querySelector('[data-testid="request-detail-header"]'),
    ).not.toBeNull();

    act(() => {
      view.container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-settings-button"]',
        )
        ?.click();
    });
    await flushReact();

    expect(
      view.container.querySelector('[data-testid="settings-modal"]'),
    ).not.toBeNull();
    expect(commandCounts.get("desktop_settings")).toBe(1);
    expect(commandCounts.get("consume_handoff_request")).toBe(1);
    expect(commandCounts.get("listen")).toBe(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(commandCounts.get("dashboard")).toBe(2);
    expect(commandCounts.get("desktop_settings")).toBe(1);
    expect(commandCounts.get("consume_handoff_request")).toBe(1);
    expect(commandCounts.get("listen")).toBe(1);

    const maximumDepthErrors = consoleError.mock.calls
      .flat()
      .filter((value) =>
        typeof value === "string"
          ? value.includes("Maximum update depth exceeded")
          : false,
      );
    expect(maximumDepthErrors).toHaveLength(0);

    consoleError.mockRestore();
    view.unmount();
  });

  it("routes password-management imports through import_secret_source without breaking the approvals shell", async () => {
    const dotenvInspection = {
      file_path: "/tmp/app.env",
      groups: [
        {
          id: "all",
          label: "All keys",
          namespace: null,
          prefix: null,
          key_count: 2,
        },
        {
          id: "prod-app",
          label: "prod / APP_",
          namespace: "prod",
          prefix: "APP_",
          key_count: 1,
        },
      ],
      keys: [
        {
          group_id: "all",
          label: "APP_API_TOKEN",
          full_key: "APP_API_TOKEN",
        },
        {
          group_id: "all",
          label: "OTHER_KEY",
          full_key: "OTHER_KEY",
        },
        {
          group_id: "prod-app",
          label: "API_TOKEN",
          full_key: "APP_API_TOKEN",
        },
      ],
    };

    tauri.listen.mockImplementation(async () => tauri.unlisten);
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "dashboard":
          return DASHBOARD;
        case "desktop_settings":
          return SETTINGS;
        case "consume_handoff_request":
          return null;
        case "list_onepassword_accounts_command":
          return [];
        case "pick_dotenv_file_command":
          return "/tmp/app.env";
        case "inspect_dotenv_file_command":
          return dotenvInspection;
        case "import_secret_source":
          return {
            catalog_path: "catalog/password/env/api_token",
            reference: {
              provider_kind: "dotenv_file",
              resource: "secret/env/API_TOKEN",
              display_name: "API Token",
              description: "Imported from dotenv",
              tags: ["prod", "api"],
              imported_at: "2026-04-13T05:12:00.000Z",
              last_verified_at: null,
              file_path: "/tmp/app.env",
              namespace: "prod",
              prefix: "APP_",
              key: "API_TOKEN",
            },
          };
        case "save_desktop_settings":
          return SETTINGS;
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    const view = render();
    await flushReact();

    click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="view-tab-password-management"]',
      ),
    );
    await flushReact();

    expect(
      view.container.querySelector('[data-testid="password-management-panel"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="workspace-grid"]'),
    ).toBeNull();

    click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="password-provider-option-dotenv_file"]',
      ),
    );
    setFieldValue(
      view.container.querySelector<HTMLInputElement>(
        '[data-testid="password-field-resource"] input',
      ),
      "secret/env/API_TOKEN",
    );
    setFieldValue(
      view.container.querySelector<HTMLInputElement>(
        '[data-testid="password-field-display-name"] input',
      ),
      "API Token",
    );
    setFieldValue(
      view.container.querySelector<HTMLInputElement>(
        '[data-testid="password-field-description"] input',
      ),
      "Imported from dotenv",
    );
    setFieldValue(
      view.container.querySelector<HTMLInputElement>(
        '[data-testid="password-field-tags"] input',
      ),
      "prod, api",
    );
    await clickAsync(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="dotenv-choose-file-button"]',
      ),
    );
    await flushReact();
    await flushReact();

    click(getPickerOption(view.container, "dotenv-group-picker", "prod-app"));
    await flushReact();

    click(
      getPickerOption(view.container, "dotenv-key-picker", "APP_API_TOKEN"),
    );
    await flushReact();

    await clickAsync(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="password-import-submit"]',
      ),
    );
    await flushReact();

    const importCall = tauri.invoke.mock.calls.find(
      ([command]) => command === "import_secret_source",
    );
    expect(importCall).toBeDefined();
    expect(importCall?.[1]).toEqual({
      spec: {
        resource: "secret/env/API_TOKEN",
        display_name: "API Token",
        description: "Imported from dotenv",
        tags: ["prod", "api"],
        source_locator: {
          provider_kind: "dotenv_file",
          file_path: "/tmp/app.env",
          namespace: "prod",
          prefix: "APP_",
          key: "API_TOKEN",
        },
      },
    });

    expect(
      view.container.querySelector('[data-testid="password-import-receipt"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="password-import-notice-message"]',
      )?.textContent,
    ).toBe("Imported secret/env/API_TOKEN");
    expect(
      view.container.querySelector(
        '[data-testid="password-receipt-catalog-path"] dd',
      )?.textContent,
    ).toBe("catalog/password/env/api_token");
    expect(
      view.container.querySelector(
        '[data-testid="password-receipt-container"] dd',
      )?.textContent,
    ).toBe("prod");

    click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="view-tab-approvals"]',
      ),
    );
    await flushReact();

    expect(
      view.container.querySelectorAll('[data-testid="queue-item"]'),
    ).toHaveLength(1);
    expect(
      view.container.querySelector('[data-testid="password-management-panel"]'),
    ).toBeNull();

    view.unmount();
  });

  it("submits 1Password imports with stable account and field identifiers", async () => {
    tauri.listen.mockImplementation(async () => tauri.unlisten);
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "dashboard":
          return DASHBOARD;
        case "desktop_settings":
          return SETTINGS;
        case "consume_handoff_request":
          return null;
        case "list_onepassword_accounts_command":
          return [
            {
              id: "acct-1",
              label: "demo@example.com",
              subtitle: "example.1password.com",
            },
            {
              id: "acct-2",
              label: "other@example.com",
              subtitle: "other.1password.com",
            },
          ];
        case "list_onepassword_vaults_command":
          return [
            { id: "vault-1", label: "Private" },
            { id: "vault-2", label: "Shared" },
          ];
        case "list_onepassword_items_command":
          return [
            { id: "item-1", label: "Qq" },
            { id: "item-2", label: "Github" },
          ];
        case "list_onepassword_fields_command":
          return [
            {
              selector: "password",
              label: "Password",
              subtitle: "login.password",
              field_id: "field-1",
            },
            {
              selector: "username",
              label: "Username",
              subtitle: "login.username",
              field_id: "field-2",
            },
          ];
        case "import_secret_source":
          return {
            catalog_path: "catalog/password/op/password",
            reference: {
              provider_kind: "1password_cli",
              resource: "secret/op/password",
              display_name: "Qq:Password",
              description: null,
              tags: ["prod"],
              imported_at: "2026-04-13T05:12:00.000Z",
              last_verified_at: null,
              account: "demo@example.com",
              account_id: "acct-1",
              vault: "Private",
              vault_id: "vault-1",
              item: "Qq",
              item_id: "item-1",
              field: "password",
              field_id: "field-1",
            },
          };
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    const view = render();
    await flushReact();

    click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="view-tab-password-management"]',
      ),
    );
    await flushReact();
    await flushReact();

    expect(
      getPickerOption(view.container, "onepassword-account-picker", "acct-1"),
    ).not.toBeNull();
    click(
      getPickerOption(view.container, "onepassword-account-picker", "acct-1"),
    );
    await flushReact();
    await flushReact();

    expect(
      getPickerOption(view.container, "onepassword-vault-picker", "vault-1"),
    ).not.toBeNull();
    click(
      getPickerOption(view.container, "onepassword-vault-picker", "vault-1"),
    );
    await flushReact();
    await flushReact();

    expect(
      getPickerOption(view.container, "onepassword-item-picker", "item-1"),
    ).not.toBeNull();
    click(getPickerOption(view.container, "onepassword-item-picker", "item-1"));
    await flushReact();
    await flushReact();

    expect(
      getPickerOption(view.container, "onepassword-field-picker", "field-1"),
    ).not.toBeNull();
    click(
      getPickerOption(view.container, "onepassword-field-picker", "field-1"),
    );
    await flushReact();

    setFieldValue(
      view.container.querySelector<HTMLInputElement>(
        '[data-testid="password-field-resource"] input',
      ),
      "secret/op/password",
    );
    setFieldValue(
      view.container.querySelector<HTMLInputElement>(
        '[data-testid="password-field-tags"] input',
      ),
      "prod",
    );
    await flushReact();

    await clickAsync(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="password-import-submit"]',
      ),
    );
    await flushReact();

    const importCall = tauri.invoke.mock.calls.find(
      ([command]) => command === "import_secret_source",
    );
    expect(importCall).toBeDefined();
    expect(importCall?.[1]).toEqual({
      spec: {
        resource: "secret/op/password",
        display_name: "Qq",
        description: null,
        tags: ["prod"],
        source_locator: {
          provider_kind: "1password_cli",
          account: "demo@example.com",
          account_id: "acct-1",
          vault: "Private",
          vault_id: "vault-1",
          item: "Qq",
          item_id: "item-1",
          field: "password",
          field_id: "field-1",
        },
      },
    });

    expect(
      view.container.querySelector('[data-testid="password-import-receipt"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="password-import-notice-message"]',
      )?.textContent,
    ).toBe("Imported secret/op/password");

    view.unmount();
  });

  it("keeps 1Password vaults populated when the active account is clicked again", async () => {
    tauri.listen.mockImplementation(async () => tauri.unlisten);
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "dashboard":
          return DASHBOARD;
        case "desktop_settings":
          return SETTINGS;
        case "consume_handoff_request":
          return null;
        case "list_onepassword_accounts_command":
          return [
            { id: "acct-1", label: "demo@example.com" },
            { id: "acct-2", label: "other@example.com" },
          ];
        case "list_onepassword_vaults_command":
          return [
            { id: "vault-1", label: "Private" },
            { id: "vault-2", label: "Shared" },
          ];
        case "list_onepassword_items_command":
          return [];
        case "list_onepassword_fields_command":
          return [];
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    const view = render();
    await flushReact();

    click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="view-tab-password-management"]',
      ),
    );
    await flushReact();
    await flushReact();

    const accountOption = getPickerOption(
      view.container,
      "onepassword-account-picker",
      "acct-1",
    );
    expect(accountOption).not.toBeNull();

    click(accountOption);
    await flushReact();
    await flushReact();

    expect(
      getPickerOption(view.container, "onepassword-vault-picker", "vault-1"),
    ).not.toBeNull();
    expect(
      tauri.invoke.mock.calls.filter(
        ([command]) => command === "list_onepassword_vaults_command",
      ),
    ).toHaveLength(1);

    click(accountOption);
    await flushReact();

    expect(
      getPickerOption(view.container, "onepassword-vault-picker", "vault-1"),
    ).not.toBeNull();
    expect(
      tauri.invoke.mock.calls.filter(
        ([command]) => command === "list_onepassword_vaults_command",
      ),
    ).toHaveLength(1);

    view.unmount();
  });

  it("renders picker-first import controls for all password source types", async () => {
    tauri.listen.mockImplementation(async () => tauri.unlisten);
    tauri.invoke.mockImplementation(async (command: string) => {
      switch (command) {
        case "dashboard":
          return DASHBOARD;
        case "desktop_settings":
          return SETTINGS;
        case "consume_handoff_request":
          return null;
        case "list_onepassword_accounts_command":
          return [{ id: "acct-1", label: "Personal" }];
        case "list_onepassword_vaults_command":
          return [{ id: "vault-1", label: "Engineering" }];
        case "list_onepassword_items_command":
          return [{ id: "item-1", label: "API Token" }];
        case "list_onepassword_fields_command":
          return [
            {
              selector: "password",
              label: "Password",
              subtitle: "login.password",
              field_id: "field-1",
            },
          ];
        case "list_bitwarden_accounts_command":
          return [{ id: "bw-account", label: "user@example.com" }];
        case "list_bitwarden_containers_command":
          return [
            {
              id: "all",
              kind: "all",
              label: "All items",
              subtitle: "Everything",
              organization_id: null,
              organization_label: null,
            },
            {
              id: "collection-1",
              kind: "collection",
              label: "Payments",
              subtitle: "Corp",
              organization_id: "org-1",
              organization_label: "Corp",
            },
          ];
        case "list_bitwarden_items_command":
          return [{ id: "bw-item-1", label: "Stripe Secret" }];
        case "list_bitwarden_fields_command":
          return [
            {
              selector: "login.password",
              label: "Password",
              subtitle: "Generated password",
              field_id: null,
            },
          ];
        default:
          throw new Error(`Unexpected command: ${command}`);
      }
    });

    const view = render();
    await flushReact();

    click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="view-tab-password-management"]',
      ),
    );
    await flushReact();
    await flushReact();
    await flushReact();

    expect(
      view.container.querySelector(
        '[data-testid="password-provider-option-1password_cli"] .toolbar-count',
      )?.textContent,
    ).toBe("account / vault / item / field");
    expect(
      view.container.querySelector(
        '[data-testid="onepassword-account-picker"]',
      ),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="onepassword-vault-picker"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="onepassword-item-picker-search"]',
      ),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="onepassword-field-picker-option"][data-option-id="field-1"]',
      ),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="onepassword-field-fallback"]',
      ),
    ).toBeNull();

    click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="password-provider-option-bitwarden_cli"]',
      ),
    );
    await flushReact();
    await flushReact();
    await flushReact();

    expect(
      view.container.querySelector(
        '[data-testid="password-provider-option-bitwarden_cli"] .toolbar-count',
      )?.textContent,
    ).toBe("account / organization|collection|folder / item / field");
    expect(
      view.container.querySelector('[data-testid="bitwarden-account-picker"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="bitwarden-container-picker"]',
      ),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="bitwarden-item-picker-search"]',
      ),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="bitwarden-field-picker-option"][data-option-id="login.password"]',
      ),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="password-field-bitwarden-field"] input',
      ),
    ).not.toBeNull();

    click(
      view.container.querySelector<HTMLButtonElement>(
        '[data-testid="password-provider-option-dotenv_file"]',
      ),
    );
    await flushReact();

    expect(
      view.container.querySelector(
        '[data-testid="password-provider-option-dotenv_file"] .toolbar-count',
      )?.textContent,
    ).toBe("file / namespace|prefix / key");
    expect(
      view.container.querySelector('[data-testid="dotenv-choose-file-button"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector(
        '[data-testid="password-field-dotenv-file"] input',
      ),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="dotenv-group-picker"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-testid="dotenv-key-picker-search"]'),
    ).not.toBeNull();

    view.unmount();
  });
});
