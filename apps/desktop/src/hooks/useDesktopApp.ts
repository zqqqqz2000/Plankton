import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";

import {
  getSelectedRequest,
  getResolvedAutoDecisionEntries,
  getResolvedReviewRequestEntries,
} from "../dashboardModel";
import {
  normalizeHandoffRequestId,
  resolvePendingHandoffRequestId,
} from "../handoff";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  isLocale,
  type Locale,
  t,
  type TranslationKey,
} from "../i18n";
import type { DashboardData, DecisionCommand, DesktopSettings } from "../types";

const AUTO_REFRESH_MS = 5_000;
const HANDOFF_EVENT = "plankton://handoff-request";

const NUMERIC_SETTINGS_FIELDS = new Set<keyof DesktopSettings>([
  "openai_temperature",
  "claude_max_tokens",
  "claude_temperature",
  "claude_timeout_secs",
  "acp_timeout_secs",
]);

type HandoffPayload = {
  request_id: string;
};

export type DetailSelection =
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

export type DesktopAppState = {
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
};

type UseDesktopAppResult = {
  state: DesktopAppState;
  canSaveSettings: boolean;
  setLocale: (locale: Locale) => void;
  dismissError: () => void;
  refreshDashboard: (options?: { silent?: boolean }) => Promise<void>;
  openSettings: () => void;
  closeSettings: () => void;
  saveSettings: () => Promise<void>;
  setPolicyMode: (value: string) => void;
  setProviderKind: (value: string) => void;
  updateSettingsField: (field: keyof DesktopSettings, value: string) => void;
  selectPendingRequest: (requestId: string) => void;
  selectResolvedRequest: (requestId: string) => void;
  selectResolvedAuto: (requestId: string) => void;
  setNoteDraft: (value: string) => void;
  decide: (requestId: string, decision: DecisionCommand) => Promise<void>;
};

const INITIAL_STATE: DesktopAppState = {
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

function cloneSettings(
  settings: DesktopSettings | null,
): DesktopSettings | null {
  return settings ? { ...settings } : null;
}

function normalizeProviderKind(value: string): string {
  return value === "acp_codex" ? "acp" : value;
}

function normalizeSettings(settings: DesktopSettings): DesktopSettings {
  return {
    ...settings,
    provider_kind: normalizeProviderKind(settings.provider_kind),
  };
}

function areSettingsEqual(
  left: DesktopSettings | null,
  right: DesktopSettings | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.default_policy_mode === right.default_policy_mode &&
    normalizeProviderKind(left.provider_kind) ===
      normalizeProviderKind(right.provider_kind) &&
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

function getSettingsFieldLabel(
  locale: Locale,
  field: keyof DesktopSettings,
): string {
  const labelMap: Record<keyof DesktopSettings, TranslationKey> = {
    default_policy_mode: "settingsCurrentPolicy",
    provider_kind: "provider",
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

  return t(locale, labelMap[field]);
}

function getOverriddenSettingsFields(
  submitted: DesktopSettings,
  effective: DesktopSettings,
): Array<keyof DesktopSettings> {
  const fields: Array<keyof DesktopSettings> = [
    "default_policy_mode",
    "provider_kind",
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

  return fields.filter((field) => {
    if (field === "provider_kind") {
      return (
        normalizeProviderKind(submitted[field]) !==
        normalizeProviderKind(effective[field])
      );
    }

    return submitted[field] !== effective[field];
  });
}

function getSelectedResolvedAutoDecision(
  selection: DetailSelection,
  dashboard: DashboardData,
) {
  if (selection?.kind !== "resolved_auto") {
    return null;
  }

  return (
    getResolvedAutoDecisionEntries(dashboard.recent_audit_records).find(
      (entry) => entry.request_id === selection.id,
    ) ?? null
  );
}

function getSelectedResolvedReviewRequest(
  selection: DetailSelection,
  dashboard: DashboardData,
) {
  if (selection?.kind !== "resolved_request") {
    return null;
  }

  return (
    getResolvedReviewRequestEntries(dashboard.recent_audit_records).find(
      (entry) => entry.request_id === selection.id,
    ) ?? null
  );
}

function syncSelection(
  dashboard: DashboardData,
  selectedDetail: DetailSelection,
  pendingHandoffRequestId: string | null,
): Pick<DesktopAppState, "pendingHandoffRequestId" | "selectedDetail"> {
  const resolvedReviewEntries = getResolvedReviewRequestEntries(
    dashboard.recent_audit_records,
  );
  const resolvedAutoEntries = getResolvedAutoDecisionEntries(
    dashboard.recent_audit_records,
  );
  const handoffRequestId = resolvePendingHandoffRequestId(
    dashboard,
    pendingHandoffRequestId,
  );

  if (handoffRequestId) {
    return {
      pendingHandoffRequestId: null,
      selectedDetail: {
        kind: "pending_request",
        id: handoffRequestId,
      },
    };
  }

  const selectedPendingRequest =
    selectedDetail?.kind === "pending_request"
      ? getSelectedRequest(dashboard, selectedDetail.id)
      : null;
  const selectedResolvedAuto =
    selectedDetail?.kind === "resolved_auto"
      ? (resolvedAutoEntries.find(
          (entry) => entry.request_id === selectedDetail.id,
        ) ?? null)
      : null;
  const selectedResolvedReview =
    selectedDetail?.kind === "resolved_request"
      ? (resolvedReviewEntries.find(
          (entry) => entry.request_id === selectedDetail.id,
        ) ?? null)
      : null;

  if (selectedPendingRequest) {
    return {
      pendingHandoffRequestId,
      selectedDetail: {
        kind: "pending_request",
        id: selectedPendingRequest.id,
      },
    };
  }

  if (selectedResolvedReview) {
    return {
      pendingHandoffRequestId,
      selectedDetail: {
        kind: "resolved_request",
        id: selectedResolvedReview.request_id,
      },
    };
  }

  if (selectedResolvedAuto) {
    return {
      pendingHandoffRequestId,
      selectedDetail: {
        kind: "resolved_auto",
        id: selectedResolvedAuto.request_id,
      },
    };
  }

  const firstPendingRequest = dashboard.pending_requests[0];
  if (firstPendingRequest) {
    return {
      pendingHandoffRequestId,
      selectedDetail: {
        kind: "pending_request",
        id: firstPendingRequest.id,
      },
    };
  }

  const firstResolvedReview = resolvedReviewEntries[0];
  if (firstResolvedReview) {
    return {
      pendingHandoffRequestId,
      selectedDetail: {
        kind: "resolved_request",
        id: firstResolvedReview.request_id,
      },
    };
  }

  const firstResolvedAuto = resolvedAutoEntries[0];
  return {
    pendingHandoffRequestId,
    selectedDetail: firstResolvedAuto
      ? {
          kind: "resolved_auto",
          id: firstResolvedAuto.request_id,
        }
      : null,
  };
}

export function useDesktopApp(): UseDesktopAppResult {
  const [state, setState] = useState<DesktopAppState>(INITIAL_STATE);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    document.documentElement.lang = state.locale;
    document.title = t(state.locale, "appTitle");
  }, [state.locale]);

  const loadDesktopSettings = useEffectEvent(async () => {
    setState((current) => ({
      ...current,
      isSettingsLoading: true,
      settingsErrorMessage: null,
      settingsNoticeMessage: null,
    }));

    try {
      const loaded = normalizeSettings(
        await invoke<DesktopSettings>("desktop_settings"),
      );
      startTransition(() => {
        setState((current) => ({
          ...current,
          settings: loaded,
          settingsDraft: current.isSettingsOpen
            ? cloneSettings(loaded)
            : current.settingsDraft,
          isSettingsLoading: false,
        }));
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        isSettingsLoading: false,
        settingsErrorMessage: getErrorMessage(error),
      }));
    }
  });

  const loadDashboard = useEffectEvent(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      const shouldShowLoading = stateRef.current.dashboard === null;

      setState((current) => ({
        ...current,
        isLoading: shouldShowLoading,
        isRefreshing: true,
        errorMessage: null,
      }));

      try {
        const dashboard = await invoke<DashboardData>("dashboard");
        startTransition(() => {
          setState((current) => {
            const synced = syncSelection(
              dashboard,
              current.selectedDetail,
              current.pendingHandoffRequestId,
            );

            return {
              ...current,
              dashboard,
              isLoading: false,
              isRefreshing: false,
              lastUpdatedAt: new Date().toISOString(),
              pendingHandoffRequestId: synced.pendingHandoffRequestId,
              selectedDetail: synced.selectedDetail,
            };
          });
        });
      } catch (error) {
        setState((current) => ({
          ...current,
          isLoading: false,
          isRefreshing: false,
          errorMessage: getErrorMessage(error),
        }));
      }

      if (!silent && shouldShowLoading) {
        return;
      }
    },
  );

  const queueHandoffRequest = useEffectEvent(
    (requestId: string | null | undefined) => {
      const normalizedRequestId = normalizeHandoffRequestId(requestId);
      if (!normalizedRequestId) {
        return;
      }

      setState((current) => ({
        ...current,
        pendingHandoffRequestId: normalizedRequestId,
        noteDraft: "",
        errorMessage: null,
      }));
      void loadDashboard();
    },
  );

  const saveSettings = useEffectEvent(async () => {
    const current = stateRef.current;
    if (
      !current.settingsDraft ||
      current.isSettingsLoading ||
      current.isSettingsSaving
    ) {
      return;
    }

    const submitted = normalizeSettings({ ...current.settingsDraft });

    setState((previous) => ({
      ...previous,
      isSettingsSaving: true,
      settingsErrorMessage: null,
      settingsNoticeMessage: null,
      settingsDraft: submitted,
    }));

    try {
      const saved = normalizeSettings(
        await invoke<DesktopSettings>("save_desktop_settings", {
          settings: submitted,
        }),
      );
      const overriddenFields = getOverriddenSettingsFields(submitted, saved);

      startTransition(() => {
        setState((previous) => ({
          ...previous,
          settings: saved,
          settingsDraft: cloneSettings(saved),
          isSettingsSaving: false,
          settingsNoticeMessage:
            overriddenFields.length > 0
              ? t(previous.locale, "settingsEnvOverrideDetected", {
                  fields: overriddenFields
                    .map((field) =>
                      getSettingsFieldLabel(previous.locale, field),
                    )
                    .join(", "),
                })
              : t(previous.locale, "settingsSavedSuccess"),
        }));
      });
    } catch (error) {
      setState((previous) => ({
        ...previous,
        isSettingsSaving: false,
        settingsErrorMessage: getErrorMessage(error),
      }));
    }
  });

  const decide = useEffectEvent(
    async (requestId: string, decision: DecisionCommand) => {
      setState((current) => ({
        ...current,
        isSubmitting: true,
        pendingDecision: decision,
        errorMessage: null,
      }));

      try {
        await invoke(decision, {
          requestId,
          note: stateRef.current.noteDraft.trim() || null,
        });
        setState((current) => ({
          ...current,
          noteDraft: "",
        }));
        await loadDashboard();
      } catch (error) {
        setState((current) => ({
          ...current,
          errorMessage: getErrorMessage(error),
        }));
      } finally {
        setState((current) => ({
          ...current,
          isSubmitting: false,
          pendingDecision: null,
        }));
      }
    },
  );

  useEffect(() => {
    void loadDesktopSettings();
    void loadDashboard();
  }, []);

  useEffect(() => {
    let unlisten: null | (() => void) = null;
    let disposed = false;

    void listen<HandoffPayload>(HANDOFF_EVENT, (event) => {
      queueHandoffRequest(event.payload.request_id);
    })
      .then((handle) => {
        if (disposed) {
          handle();
          return;
        }

        unlisten = handle;
      })
      .catch((error) => {
        setState((current) => ({
          ...current,
          errorMessage: getErrorMessage(error),
        }));
      });

    void invoke<string | null>("consume_handoff_request")
      .then((requestId) => {
        queueHandoffRequest(requestId);
      })
      .catch((error) => {
        setState((current) => ({
          ...current,
          errorMessage: getErrorMessage(error),
        }));
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadDashboard({ silent: true });
    }, AUTO_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  return {
    state,
    canSaveSettings:
      state.settings !== null &&
      state.settingsDraft !== null &&
      !areSettingsEqual(state.settingsDraft, state.settings) &&
      !state.isSettingsLoading &&
      !state.isSettingsSaving,
    setLocale: (locale) => {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
      setState((current) => ({
        ...current,
        locale,
      }));
    },
    dismissError: () => {
      setState((current) => ({
        ...current,
        errorMessage: null,
      }));
    },
    refreshDashboard: loadDashboard,
    openSettings: () => {
      const current = stateRef.current;
      setState((previous) => ({
        ...previous,
        isSettingsOpen: true,
        settingsErrorMessage: null,
        settingsNoticeMessage: null,
        settingsDraft: cloneSettings(previous.settings),
      }));

      if (!current.settings && !current.isSettingsLoading) {
        void loadDesktopSettings();
      }
    },
    closeSettings: () => {
      if (stateRef.current.isSettingsSaving) {
        return;
      }

      setState((current) => ({
        ...current,
        isSettingsOpen: false,
        settingsErrorMessage: null,
        settingsNoticeMessage: null,
        settingsDraft: cloneSettings(current.settings),
      }));
    },
    saveSettings,
    setPolicyMode: (value) => {
      setState((current) => {
        if (!current.settingsDraft) {
          return current;
        }

        return {
          ...current,
          settingsDraft: {
            ...current.settingsDraft,
            default_policy_mode: value,
          },
        };
      });
    },
    setProviderKind: (value) => {
      setState((current) => {
        if (!current.settingsDraft) {
          return current;
        }

        return {
          ...current,
          settingsDraft: {
            ...current.settingsDraft,
            provider_kind: normalizeProviderKind(value),
          },
        };
      });
    },
    updateSettingsField: (field, value) => {
      setState((current) => {
        if (!current.settingsDraft) {
          return current;
        }

        if (NUMERIC_SETTINGS_FIELDS.has(field)) {
          const parsedValue = Number(value);
          if (Number.isNaN(parsedValue)) {
            return current;
          }

          return {
            ...current,
            settingsDraft: {
              ...current.settingsDraft,
              [field]: parsedValue,
            },
          };
        }

        return {
          ...current,
          settingsDraft: {
            ...current.settingsDraft,
            [field]: value,
          },
        };
      });
    },
    selectPendingRequest: (requestId) => {
      setState((current) => ({
        ...current,
        selectedDetail: {
          kind: "pending_request",
          id: requestId,
        },
        noteDraft: "",
      }));
    },
    selectResolvedRequest: (requestId) => {
      setState((current) => ({
        ...current,
        selectedDetail: {
          kind: "resolved_request",
          id: requestId,
        },
        noteDraft: "",
      }));
    },
    selectResolvedAuto: (requestId) => {
      setState((current) => ({
        ...current,
        selectedDetail: {
          kind: "resolved_auto",
          id: requestId,
        },
        noteDraft: "",
      }));
    },
    setNoteDraft: (value) => {
      setState((current) => ({
        ...current,
        noteDraft: value,
      }));
    },
    decide,
  };
}
