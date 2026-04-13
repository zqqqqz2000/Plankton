import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type JSX } from "react";

import { formatTimestamp } from "../formatters";
import { t, translateCode, type Locale } from "../i18n";
import type {
  BitwardenCliLocator,
  BitwardenContainerOption,
  DotenvFileLocator,
  DotenvGroupOption,
  DotenvInspection,
  DotenvKeyOption,
  ImportFieldOption,
  ImportPickerOption,
  ImportedSecretReceipt,
  ImportedSecretReference,
  OnePasswordCliLocator,
  SecretImportSpec,
  SecretSourceLocator,
} from "../types";

type SecretImportProviderKind = SecretSourceLocator["provider_kind"];

type CommonImportDraft = {
  resource: string;
  displayName: string;
  description: string;
  tags: string;
};

type OnePasswordDraft = {
  account: string;
  vault: string;
  item: string;
  field: string;
  vaultId: string;
  itemId: string;
  fieldId: string;
};

type BitwardenDraft = {
  account: string;
  organization: string;
  collection: string;
  folder: string;
  item: string;
  field: string;
  itemId: string;
};

type DotenvDraft = {
  filePath: string;
  namespace: string;
  prefix: string;
  key: string;
};

type ProviderOption = {
  kind: SecretImportProviderKind;
  descriptionKey:
    | "provider1passwordCliDesc"
    | "providerBitwardenCliDesc"
    | "providerDotenvFileDesc";
  scopeKey:
    | "importScope1password"
    | "importScopeBitwarden"
    | "importScopeDotenv";
};

type PickerRenderableOption = {
  id: string;
  label: string;
  subtitle?: string | null;
};

type PickerSectionProps = {
  title: string;
  caption?: string;
  dataTestId: string;
  options: PickerRenderableOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  emptyMessage: string;
  loading: boolean;
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
  searchPlaceholder?: string;
};

type LocatorFieldProps = {
  dataTestId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  optionalLabel: string;
  optional?: boolean;
  hint?: string;
};

type PasswordManagementViewProps = {
  locale: Locale;
};

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    kind: "1password_cli",
    descriptionKey: "provider1passwordCliDesc",
    scopeKey: "importScope1password",
  },
  {
    kind: "bitwarden_cli",
    descriptionKey: "providerBitwardenCliDesc",
    scopeKey: "importScopeBitwarden",
  },
  {
    kind: "dotenv_file",
    descriptionKey: "providerDotenvFileDesc",
    scopeKey: "importScopeDotenv",
  },
];

const EMPTY_COMMON_DRAFT: CommonImportDraft = {
  resource: "",
  displayName: "",
  description: "",
  tags: "",
};

const EMPTY_ONEPASSWORD_DRAFT: OnePasswordDraft = {
  account: "",
  vault: "",
  item: "",
  field: "",
  vaultId: "",
  itemId: "",
  fieldId: "",
};

const EMPTY_BITWARDEN_DRAFT: BitwardenDraft = {
  account: "",
  organization: "",
  collection: "",
  folder: "",
  item: "",
  field: "",
  itemId: "",
};

const EMPTY_DOTENV_DRAFT: DotenvDraft = {
  filePath: "",
  namespace: "",
  prefix: "",
  key: "",
};

function optionalValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTags(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function matchesQuery(
  option: PickerRenderableOption,
  query: string | undefined,
): boolean {
  if (!query) {
    return true;
  }

  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  return [option.label, option.subtitle, option.id]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(normalizedQuery));
}

function fieldOptionId(field: ImportFieldOption): string {
  return field.field_id ?? field.selector;
}

function searchPlaceholder(locale: Locale, label: string): string {
  return locale === "zh-CN" ? `搜索${label}` : `Search ${label.toLowerCase()}`;
}

function sectionCaption(
  locale: Locale,
  english: string,
  chinese: string,
): string {
  return locale === "zh-CN" ? chinese : english;
}

function buildSourceLocator(
  providerKind: SecretImportProviderKind,
  onePasswordDraft: OnePasswordDraft,
  bitwardenDraft: BitwardenDraft,
  dotenvDraft: DotenvDraft,
): SecretSourceLocator {
  if (providerKind === "1password_cli") {
    return {
      provider_kind: "1password_cli",
      account: onePasswordDraft.account.trim(),
      vault: onePasswordDraft.vault.trim(),
      item: onePasswordDraft.item.trim(),
      field: onePasswordDraft.field.trim(),
      vault_id: optionalValue(onePasswordDraft.vaultId),
      item_id: optionalValue(onePasswordDraft.itemId),
      field_id: optionalValue(onePasswordDraft.fieldId),
    } satisfies OnePasswordCliLocator;
  }

  if (providerKind === "bitwarden_cli") {
    return {
      provider_kind: "bitwarden_cli",
      account: bitwardenDraft.account.trim(),
      organization: optionalValue(bitwardenDraft.organization),
      collection: optionalValue(bitwardenDraft.collection),
      folder: optionalValue(bitwardenDraft.folder),
      item: bitwardenDraft.item.trim(),
      field: bitwardenDraft.field.trim(),
      item_id: optionalValue(bitwardenDraft.itemId),
    } satisfies BitwardenCliLocator;
  }

  return {
    provider_kind: "dotenv_file",
    file_path: dotenvDraft.filePath.trim(),
    namespace: optionalValue(dotenvDraft.namespace),
    prefix: optionalValue(dotenvDraft.prefix),
    key: dotenvDraft.key.trim(),
  } satisfies DotenvFileLocator;
}

function buildImportSpec(options: {
  providerKind: SecretImportProviderKind;
  commonDraft: CommonImportDraft;
  onePasswordDraft: OnePasswordDraft;
  bitwardenDraft: BitwardenDraft;
  dotenvDraft: DotenvDraft;
}): SecretImportSpec {
  return {
    resource: options.commonDraft.resource.trim(),
    display_name: optionalValue(options.commonDraft.displayName),
    description: optionalValue(options.commonDraft.description),
    tags: parseTags(options.commonDraft.tags),
    source_locator: buildSourceLocator(
      options.providerKind,
      options.onePasswordDraft,
      options.bitwardenDraft,
      options.dotenvDraft,
    ),
  };
}

function getImportedContainerLabel(
  reference: ImportedSecretReference,
): string | null {
  if (reference.provider_kind === "1password_cli") {
    return reference.vault;
  }

  if (reference.provider_kind === "bitwarden_cli") {
    return (
      reference.collection ??
      reference.folder ??
      reference.organization ??
      reference.account
    );
  }

  return reference.namespace ?? reference.prefix ?? reference.file_path;
}

function getImportedFieldSelector(reference: ImportedSecretReference): string {
  if (reference.provider_kind === "dotenv_file") {
    return reference.key;
  }

  return reference.field;
}

function canSubmitImport(
  providerKind: SecretImportProviderKind,
  commonDraft: CommonImportDraft,
  onePasswordDraft: OnePasswordDraft,
  bitwardenDraft: BitwardenDraft,
  dotenvDraft: DotenvDraft,
): boolean {
  if (commonDraft.resource.trim().length === 0) {
    return false;
  }

  if (providerKind === "1password_cli") {
    return (
      onePasswordDraft.account.trim().length > 0 &&
      onePasswordDraft.vault.trim().length > 0 &&
      onePasswordDraft.item.trim().length > 0 &&
      onePasswordDraft.field.trim().length > 0
    );
  }

  if (providerKind === "bitwarden_cli") {
    return (
      bitwardenDraft.account.trim().length > 0 &&
      bitwardenDraft.item.trim().length > 0 &&
      bitwardenDraft.field.trim().length > 0
    );
  }

  return (
    dotenvDraft.filePath.trim().length > 0 && dotenvDraft.key.trim().length > 0
  );
}

function PickerSection(props: PickerSectionProps): JSX.Element {
  const visibleOptions = props.options.filter((option) =>
    matchesQuery(option, props.searchQuery),
  );

  return (
    <section className="detail-section" data-testid={props.dataTestId}>
      <div className="detail-section-header">
        <h3>{props.title}</h3>
        {props.caption ? <span>{props.caption}</span> : null}
      </div>
      {props.onSearchQueryChange ? (
        <input
          className="settings-input picker-search"
          data-testid={`${props.dataTestId}-search`}
          onChange={(event) => {
            props.onSearchQueryChange?.(event.currentTarget.value);
          }}
          placeholder={props.searchPlaceholder}
          type="search"
          value={props.searchQuery ?? ""}
        />
      ) : null}
      <div
        className="queue-list picker-list"
        data-testid={`${props.dataTestId}-list`}
      >
        {props.loading ? (
          <p className="empty" data-testid={`${props.dataTestId}-loading`}>
            {props.emptyMessage}
          </p>
        ) : visibleOptions.length === 0 ? (
          <p className="empty" data-testid={`${props.dataTestId}-empty`}>
            {props.emptyMessage}
          </p>
        ) : (
          visibleOptions.map((option) => {
            const isActive = option.id === props.selectedId;
            return (
              <button
                aria-pressed={isActive ? "true" : "false"}
                className={`queue-item ${isActive ? "active" : ""}`}
                data-option-id={option.id}
                data-selected={isActive ? "true" : "false"}
                data-testid={`${props.dataTestId}-option`}
                key={option.id}
                onClick={() => {
                  props.onSelect(option.id);
                }}
                type="button"
              >
                <div className="queue-item-header">
                  <strong>{option.label}</strong>
                </div>
                {option.subtitle ? (
                  <div className="queue-item-meta">
                    <span>{option.subtitle}</span>
                  </div>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </section>
  );
}

function LocatorField(props: LocatorFieldProps): JSX.Element {
  return (
    <label className="settings-field" data-testid={props.dataTestId}>
      <span className="field-label">
        {props.label}
        {props.optional ? (
          <span className="field-optional"> · {props.optionalLabel}</span>
        ) : null}
      </span>
      <input
        className="settings-input"
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
        }}
        type="text"
        value={props.value}
      />
      {props.hint ? <span className="field-hint">{props.hint}</span> : null}
    </label>
  );
}

export function PasswordManagementView(
  props: PasswordManagementViewProps,
): JSX.Element {
  const [providerKind, setProviderKind] =
    useState<SecretImportProviderKind>("1password_cli");
  const [commonDraft, setCommonDraft] =
    useState<CommonImportDraft>(EMPTY_COMMON_DRAFT);
  const [onePasswordDraft, setOnePasswordDraft] = useState<OnePasswordDraft>(
    EMPTY_ONEPASSWORD_DRAFT,
  );
  const [bitwardenDraft, setBitwardenDraft] = useState<BitwardenDraft>(
    EMPTY_BITWARDEN_DRAFT,
  );
  const [dotenvDraft, setDotenvDraft] =
    useState<DotenvDraft>(EMPTY_DOTENV_DRAFT);
  const [receipt, setReceipt] = useState<ImportedSecretReceipt | null>(null);
  const [browseErrorMessage, setBrowseErrorMessage] = useState<string | null>(
    null,
  );
  const [submitErrorMessage, setSubmitErrorMessage] = useState<string | null>(
    null,
  );
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [onePasswordAccounts, setOnePasswordAccounts] = useState<
    ImportPickerOption[]
  >([]);
  const [onePasswordVaults, setOnePasswordVaults] = useState<
    ImportPickerOption[]
  >([]);
  const [onePasswordItems, setOnePasswordItems] = useState<
    ImportPickerOption[]
  >([]);
  const [onePasswordFields, setOnePasswordFields] = useState<
    ImportFieldOption[]
  >([]);
  const [selectedOnePasswordAccountId, setSelectedOnePasswordAccountId] =
    useState<string | null>(null);
  const [selectedOnePasswordVaultId, setSelectedOnePasswordVaultId] = useState<
    string | null
  >(null);
  const [selectedOnePasswordItemId, setSelectedOnePasswordItemId] = useState<
    string | null
  >(null);
  const [selectedOnePasswordFieldId, setSelectedOnePasswordFieldId] = useState<
    string | null
  >(null);
  const [onePasswordItemQuery, setOnePasswordItemQuery] = useState("");
  const [isOnePasswordAccountsLoading, setIsOnePasswordAccountsLoading] =
    useState(false);
  const [isOnePasswordVaultsLoading, setIsOnePasswordVaultsLoading] =
    useState(false);
  const [isOnePasswordItemsLoading, setIsOnePasswordItemsLoading] =
    useState(false);
  const [isOnePasswordFieldsLoading, setIsOnePasswordFieldsLoading] =
    useState(false);

  const [bitwardenAccounts, setBitwardenAccounts] = useState<
    ImportPickerOption[]
  >([]);
  const [bitwardenContainers, setBitwardenContainers] = useState<
    BitwardenContainerOption[]
  >([]);
  const [bitwardenItems, setBitwardenItems] = useState<ImportPickerOption[]>(
    [],
  );
  const [bitwardenFields, setBitwardenFields] = useState<ImportFieldOption[]>(
    [],
  );
  const [selectedBitwardenAccountId, setSelectedBitwardenAccountId] = useState<
    string | null
  >(null);
  const [selectedBitwardenContainerId, setSelectedBitwardenContainerId] =
    useState<string | null>("all");
  const [selectedBitwardenItemId, setSelectedBitwardenItemId] = useState<
    string | null
  >(null);
  const [selectedBitwardenFieldId, setSelectedBitwardenFieldId] = useState<
    string | null
  >(null);
  const [bitwardenItemQuery, setBitwardenItemQuery] = useState("");
  const [isBitwardenAccountsLoading, setIsBitwardenAccountsLoading] =
    useState(false);
  const [isBitwardenContainersLoading, setIsBitwardenContainersLoading] =
    useState(false);
  const [isBitwardenItemsLoading, setIsBitwardenItemsLoading] = useState(false);
  const [isBitwardenFieldsLoading, setIsBitwardenFieldsLoading] =
    useState(false);

  const [dotenvInspection, setDotenvInspection] =
    useState<DotenvInspection | null>(null);
  const [selectedDotenvGroupId, setSelectedDotenvGroupId] = useState<
    string | null
  >("all");
  const [selectedDotenvKey, setSelectedDotenvKey] = useState<string | null>(
    null,
  );
  const [dotenvKeyQuery, setDotenvKeyQuery] = useState("");
  const [isDotenvPicking, setIsDotenvPicking] = useState(false);
  const [isDotenvInspecting, setIsDotenvInspecting] = useState(false);

  const selectedProvider = PROVIDER_OPTIONS.find(
    (option) => option.kind === providerKind,
  );
  const selectedOnePasswordAccount =
    onePasswordAccounts.find(
      (option) => option.id === selectedOnePasswordAccountId,
    ) ?? null;
  const selectedOnePasswordVault =
    onePasswordVaults.find(
      (option) => option.id === selectedOnePasswordVaultId,
    ) ?? null;
  const selectedOnePasswordItem =
    onePasswordItems.find(
      (option) => option.id === selectedOnePasswordItemId,
    ) ?? null;
  const selectedOnePasswordField =
    onePasswordFields.find(
      (field) => fieldOptionId(field) === selectedOnePasswordFieldId,
    ) ?? null;
  const selectedBitwardenAccount =
    bitwardenAccounts.find(
      (option) => option.id === selectedBitwardenAccountId,
    ) ?? null;
  const selectedBitwardenContainer =
    bitwardenContainers.find(
      (option) => option.id === selectedBitwardenContainerId,
    ) ?? null;
  const selectedBitwardenItem =
    bitwardenItems.find((option) => option.id === selectedBitwardenItemId) ??
    null;
  const selectedBitwardenField =
    bitwardenFields.find(
      (field) => fieldOptionId(field) === selectedBitwardenFieldId,
    ) ?? null;
  const selectedDotenvGroup =
    dotenvInspection?.groups.find(
      (group) => group.id === selectedDotenvGroupId,
    ) ?? null;
  const visibleDotenvKeys = (dotenvInspection?.keys ?? [])
    .filter((option) => option.group_id === (selectedDotenvGroupId ?? "all"))
    .filter((option) =>
      matchesQuery(
        {
          id: option.full_key,
          label: option.label,
          subtitle: option.full_key !== option.label ? option.full_key : null,
        },
        dotenvKeyQuery,
      ),
    );
  const canSubmit = canSubmitImport(
    providerKind,
    commonDraft,
    onePasswordDraft,
    bitwardenDraft,
    dotenvDraft,
  );

  function resetFeedback(): void {
    setBrowseErrorMessage(null);
    setSubmitErrorMessage(null);
    setNoticeMessage(null);
  }

  function suggestDisplayName(nextDisplayName: string): void {
    setCommonDraft((current) => {
      if (current.displayName.trim().length > 0) {
        return current;
      }

      return {
        ...current,
        displayName: nextDisplayName,
      };
    });
  }

  function handleBrowseError(error: unknown): void {
    setBrowseErrorMessage(
      error instanceof Error ? error.message : String(error),
    );
  }

  async function submitImport(): Promise<void> {
    setIsSubmitting(true);
    setSubmitErrorMessage(null);
    setNoticeMessage(null);

    try {
      const spec = buildImportSpec({
        providerKind,
        commonDraft,
        onePasswordDraft,
        bitwardenDraft,
        dotenvDraft,
      });
      const nextReceipt = await invoke<ImportedSecretReceipt>(
        "import_secret_source",
        {
          spec,
        },
      );
      setReceipt(nextReceipt);
      setNoticeMessage(
        t(props.locale, "importSourceSuccess", {
          resource: nextReceipt.reference.resource,
        }),
      );
    } catch (error) {
      setSubmitErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function selectOnePasswordAccount(nextAccountId: string): void {
    const nextAccount =
      onePasswordAccounts.find((option) => option.id === nextAccountId) ?? null;
    setSelectedOnePasswordAccountId(nextAccountId);
    setSelectedOnePasswordVaultId(null);
    setSelectedOnePasswordItemId(null);
    setSelectedOnePasswordFieldId(null);
    setOnePasswordVaults([]);
    setOnePasswordItems([]);
    setOnePasswordFields([]);
    setOnePasswordItemQuery("");
    setOnePasswordDraft((current) => ({
      ...current,
      account: nextAccount?.label ?? current.account,
      vault: "",
      item: "",
      field: "",
      vaultId: "",
      itemId: "",
      fieldId: "",
    }));
  }

  function selectOnePasswordVault(nextVaultId: string): void {
    const nextVault =
      onePasswordVaults.find((option) => option.id === nextVaultId) ?? null;
    setSelectedOnePasswordVaultId(nextVaultId);
    setSelectedOnePasswordItemId(null);
    setSelectedOnePasswordFieldId(null);
    setOnePasswordItems([]);
    setOnePasswordFields([]);
    setOnePasswordItemQuery("");
    setOnePasswordDraft((current) => ({
      ...current,
      vault: nextVault?.label ?? current.vault,
      vaultId: nextVault?.id ?? current.vaultId,
      item: "",
      field: "",
      itemId: "",
      fieldId: "",
    }));
  }

  function selectOnePasswordItem(nextItemId: string): void {
    const nextItem =
      onePasswordItems.find((option) => option.id === nextItemId) ?? null;
    setSelectedOnePasswordItemId(nextItemId);
    setSelectedOnePasswordFieldId(null);
    setOnePasswordFields([]);
    setOnePasswordDraft((current) => ({
      ...current,
      item: nextItem?.label ?? current.item,
      itemId: nextItem?.id ?? current.itemId,
      field: "",
      fieldId: "",
    }));
    if (nextItem) {
      suggestDisplayName(nextItem.label);
    }
  }

  function selectOnePasswordField(nextFieldId: string): void {
    const nextField =
      onePasswordFields.find((field) => fieldOptionId(field) === nextFieldId) ??
      null;
    setSelectedOnePasswordFieldId(nextFieldId);
    setOnePasswordDraft((current) => ({
      ...current,
      field: nextField?.selector ?? current.field,
      fieldId: nextField?.field_id ?? "",
    }));
    if (nextField && selectedOnePasswordItem) {
      suggestDisplayName(`${selectedOnePasswordItem.label}:${nextField.label}`);
    }
  }

  function selectBitwardenAccount(nextAccountId: string): void {
    const nextAccount =
      bitwardenAccounts.find((option) => option.id === nextAccountId) ?? null;
    setSelectedBitwardenAccountId(nextAccountId);
    setBitwardenDraft((current) => ({
      ...current,
      account: nextAccount?.label ?? current.account,
      organization: "",
      collection: "",
      folder: "",
      item: "",
      field: "",
      itemId: "",
    }));
    setSelectedBitwardenContainerId("all");
    setSelectedBitwardenItemId(null);
    setSelectedBitwardenFieldId(null);
    setBitwardenFields([]);
  }

  function selectBitwardenContainer(nextContainerId: string): void {
    const nextContainer =
      bitwardenContainers.find((option) => option.id === nextContainerId) ??
      null;
    setSelectedBitwardenContainerId(nextContainerId);
    setSelectedBitwardenItemId(null);
    setSelectedBitwardenFieldId(null);
    setBitwardenFields([]);
    setBitwardenDraft((current) => ({
      ...current,
      organization:
        nextContainer?.kind === "organization"
          ? nextContainer.label
          : (nextContainer?.organization_label ?? ""),
      collection:
        nextContainer?.kind === "collection" ? nextContainer.label : "",
      folder: nextContainer?.kind === "folder" ? nextContainer.label : "",
      item: "",
      field: "",
      itemId: "",
    }));
  }

  function selectBitwardenItem(nextItemId: string): void {
    const nextItem =
      bitwardenItems.find((option) => option.id === nextItemId) ?? null;
    setSelectedBitwardenItemId(nextItemId);
    setSelectedBitwardenFieldId(null);
    setBitwardenDraft((current) => ({
      ...current,
      item: nextItem?.label ?? current.item,
      itemId: nextItem?.id ?? current.itemId,
      field: "",
    }));
    if (nextItem) {
      suggestDisplayName(nextItem.label);
    }
  }

  function selectBitwardenField(nextFieldId: string): void {
    const nextField =
      bitwardenFields.find((field) => fieldOptionId(field) === nextFieldId) ??
      null;
    setSelectedBitwardenFieldId(nextFieldId);
    setBitwardenDraft((current) => ({
      ...current,
      field: nextField?.selector ?? current.field,
    }));
    if (nextField && selectedBitwardenItem) {
      suggestDisplayName(`${selectedBitwardenItem.label}:${nextField.label}`);
    }
  }

  function selectDotenvGroup(nextGroupId: string): void {
    const nextGroup =
      dotenvInspection?.groups.find((group) => group.id === nextGroupId) ??
      null;
    setSelectedDotenvGroupId(nextGroupId);
    setSelectedDotenvKey(null);
    setDotenvKeyQuery("");
    setDotenvDraft((current) => ({
      ...current,
      namespace: nextGroup?.namespace ?? "",
      prefix: nextGroup?.prefix ?? "",
      key: "",
    }));
  }

  function selectDotenvKey(option: DotenvKeyOption): void {
    setSelectedDotenvKey(option.full_key);
    const nextKey =
      selectedDotenvGroup?.prefix && option.group_id !== "all"
        ? option.label
        : option.full_key;
    setDotenvDraft((current) => ({
      ...current,
      key: nextKey,
    }));
    suggestDisplayName(nextKey);
  }

  async function chooseDotenvFile(): Promise<void> {
    setIsDotenvPicking(true);
    setBrowseErrorMessage(null);

    try {
      const filePath = await invoke<string | null>("pick_dotenv_file_command");
      if (!filePath) {
        return;
      }

      setDotenvDraft((current) => ({
        ...current,
        filePath,
        namespace: "",
        prefix: "",
        key: "",
      }));
      setSelectedDotenvGroupId("all");
      setSelectedDotenvKey(null);
      setDotenvKeyQuery("");
    } catch (error) {
      handleBrowseError(error);
    } finally {
      setIsDotenvPicking(false);
    }
  }

  useEffect(() => {
    resetFeedback();
  }, [providerKind]);

  useEffect(() => {
    if (providerKind !== "1password_cli") {
      return;
    }

    let active = true;
    setIsOnePasswordAccountsLoading(true);
    void invoke<ImportPickerOption[]>("list_onepassword_accounts_command")
      .then((accounts) => {
        if (!active) {
          return;
        }
        setOnePasswordAccounts(accounts);
        if (accounts.length === 1) {
          selectOnePasswordAccount(accounts[0].id);
        }
      })
      .catch((error) => {
        if (active) {
          handleBrowseError(error);
        }
      })
      .finally(() => {
        if (active) {
          setIsOnePasswordAccountsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [providerKind]);

  useEffect(() => {
    if (providerKind !== "1password_cli" || !selectedOnePasswordAccountId) {
      return;
    }

    let active = true;
    setIsOnePasswordVaultsLoading(true);
    void invoke<ImportPickerOption[]>("list_onepassword_vaults_command", {
      accountId: selectedOnePasswordAccountId,
    })
      .then((vaults) => {
        if (!active) {
          return;
        }
        setOnePasswordVaults(vaults);
        if (vaults.length === 1) {
          selectOnePasswordVault(vaults[0].id);
        }
      })
      .catch((error) => {
        if (active) {
          handleBrowseError(error);
        }
      })
      .finally(() => {
        if (active) {
          setIsOnePasswordVaultsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [providerKind, selectedOnePasswordAccountId]);

  useEffect(() => {
    if (
      providerKind !== "1password_cli" ||
      !selectedOnePasswordAccountId ||
      !selectedOnePasswordVaultId
    ) {
      return;
    }

    let active = true;
    setIsOnePasswordItemsLoading(true);
    void invoke<ImportPickerOption[]>("list_onepassword_items_command", {
      accountId: selectedOnePasswordAccountId,
      vaultId: selectedOnePasswordVaultId,
    })
      .then((items) => {
        if (!active) {
          return;
        }
        setOnePasswordItems(items);
        if (items.length === 1) {
          selectOnePasswordItem(items[0].id);
        }
      })
      .catch((error) => {
        if (active) {
          handleBrowseError(error);
        }
      })
      .finally(() => {
        if (active) {
          setIsOnePasswordItemsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [providerKind, selectedOnePasswordAccountId, selectedOnePasswordVaultId]);

  useEffect(() => {
    if (
      providerKind !== "1password_cli" ||
      !selectedOnePasswordAccountId ||
      !selectedOnePasswordVaultId ||
      !selectedOnePasswordItemId
    ) {
      return;
    }

    let active = true;
    setIsOnePasswordFieldsLoading(true);
    void invoke<ImportFieldOption[]>("list_onepassword_fields_command", {
      accountId: selectedOnePasswordAccountId,
      vaultId: selectedOnePasswordVaultId,
      itemId: selectedOnePasswordItemId,
    })
      .then((fields) => {
        if (!active) {
          return;
        }
        setOnePasswordFields(fields);
        if (fields.length === 1) {
          selectOnePasswordField(fieldOptionId(fields[0]));
        }
      })
      .catch((error) => {
        if (active) {
          handleBrowseError(error);
        }
      })
      .finally(() => {
        if (active) {
          setIsOnePasswordFieldsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [
    providerKind,
    selectedOnePasswordAccountId,
    selectedOnePasswordVaultId,
    selectedOnePasswordItemId,
  ]);

  useEffect(() => {
    if (providerKind !== "bitwarden_cli") {
      return;
    }

    let active = true;
    setIsBitwardenAccountsLoading(true);
    setIsBitwardenContainersLoading(true);

    void invoke<ImportPickerOption[]>("list_bitwarden_accounts_command")
      .then((accounts) => {
        if (!active) {
          return;
        }
        setBitwardenAccounts(accounts);
        if (accounts.length > 0) {
          selectBitwardenAccount(accounts[0].id);
        }
      })
      .catch((error) => {
        if (active) {
          handleBrowseError(error);
        }
      })
      .finally(() => {
        if (active) {
          setIsBitwardenAccountsLoading(false);
        }
      });

    void invoke<BitwardenContainerOption[]>("list_bitwarden_containers_command")
      .then((containers) => {
        if (!active) {
          return;
        }
        setBitwardenContainers(containers);
      })
      .catch((error) => {
        if (active) {
          handleBrowseError(error);
        }
      })
      .finally(() => {
        if (active) {
          setIsBitwardenContainersLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [providerKind]);

  useEffect(() => {
    if (providerKind !== "bitwarden_cli" || !selectedBitwardenAccountId) {
      return;
    }

    let active = true;
    setIsBitwardenItemsLoading(true);
    setSelectedBitwardenItemId(null);
    setSelectedBitwardenFieldId(null);
    setBitwardenFields([]);

    const container = bitwardenContainers.find(
      (option) => option.id === selectedBitwardenContainerId,
    );

    void invoke<ImportPickerOption[]>("list_bitwarden_items_command", {
      containerKind:
        container?.kind === "all" ? null : (container?.kind ?? null),
      containerId: container?.kind === "all" ? null : (container?.id ?? null),
      organizationId: container?.organization_id ?? null,
    })
      .then((items) => {
        if (!active) {
          return;
        }
        setBitwardenItems(items);
        if (items.length === 1) {
          selectBitwardenItem(items[0].id);
        }
      })
      .catch((error) => {
        if (active) {
          handleBrowseError(error);
        }
      })
      .finally(() => {
        if (active) {
          setIsBitwardenItemsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [
    providerKind,
    selectedBitwardenAccountId,
    selectedBitwardenContainerId,
    bitwardenContainers,
  ]);

  useEffect(() => {
    if (providerKind !== "bitwarden_cli" || !selectedBitwardenItemId) {
      return;
    }

    let active = true;
    setIsBitwardenFieldsLoading(true);

    void invoke<ImportFieldOption[]>("list_bitwarden_fields_command", {
      itemId: selectedBitwardenItemId,
    })
      .then((fields) => {
        if (!active) {
          return;
        }
        setBitwardenFields(fields);
        if (fields.length === 1) {
          selectBitwardenField(fieldOptionId(fields[0]));
        }
      })
      .catch((error) => {
        if (active) {
          handleBrowseError(error);
        }
      })
      .finally(() => {
        if (active) {
          setIsBitwardenFieldsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [providerKind, selectedBitwardenItemId]);

  useEffect(() => {
    if (
      providerKind !== "dotenv_file" ||
      dotenvDraft.filePath.trim().length === 0
    ) {
      return;
    }

    let active = true;
    setIsDotenvInspecting(true);

    void invoke<DotenvInspection>("inspect_dotenv_file_command", {
      filePath: dotenvDraft.filePath,
    })
      .then((inspection) => {
        if (!active) {
          return;
        }
        setDotenvInspection(inspection);
        setSelectedDotenvGroupId("all");
        setSelectedDotenvKey(null);
      })
      .catch((error) => {
        if (active) {
          handleBrowseError(error);
        }
      })
      .finally(() => {
        if (active) {
          setIsDotenvInspecting(false);
        }
      });

    return () => {
      active = false;
    };
  }, [providerKind, dotenvDraft.filePath]);

  const onePasswordFieldOptions = onePasswordFields.map((field) => ({
    id: fieldOptionId(field),
    label: field.label,
    subtitle: field.subtitle,
  }));
  const bitwardenContainerOptions = bitwardenContainers.map((container) => ({
    id: container.id,
    label: container.label,
    subtitle: container.subtitle,
  }));
  const bitwardenFieldOptions = bitwardenFields.map((field) => ({
    id: fieldOptionId(field),
    label: field.label,
    subtitle: field.subtitle,
  }));
  const dotenvGroupOptions = (dotenvInspection?.groups ?? []).map((group) => ({
    id: group.id,
    label: group.label,
    subtitle: sectionCaption(
      props.locale,
      `${group.key_count} key(s)`,
      `${group.key_count} 个 key`,
    ),
  }));
  const dotenvKeyOptions = visibleDotenvKeys.map((key) => ({
    id: key.full_key,
    label: key.label,
    subtitle: key.full_key !== key.label ? key.full_key : null,
  }));

  return (
    <section
      className="panel password-panel"
      data-testid="password-management-panel"
    >
      <div className="panel-header" data-testid="password-management-header">
        <h2>{t(props.locale, "passwordManagementTitle")}</h2>
        <span>{translateCode(props.locale, providerKind)}</span>
      </div>
      <p className="section-copy" data-testid="password-management-subtitle">
        {t(props.locale, "passwordManagementSubtitle")}
      </p>

      {submitErrorMessage || browseErrorMessage ? (
        <section
          className="alert"
          data-testid="password-import-error-banner"
          role="alert"
        >
          <p data-testid="password-import-error-message">
            {submitErrorMessage ?? browseErrorMessage}
          </p>
        </section>
      ) : null}

      {noticeMessage ? (
        <section
          className="alert"
          data-testid="password-import-notice-banner"
          role="status"
        >
          <p data-testid="password-import-notice-message">{noticeMessage}</p>
        </section>
      ) : null}

      <div className="password-layout" data-testid="password-management-layout">
        <section
          className="detail-section"
          data-testid="password-provider-section"
        >
          <div className="detail-section-header">
            <h3>{t(props.locale, "passwordProvidersTitle")}</h3>
            <span>
              {selectedProvider
                ? t(props.locale, selectedProvider.scopeKey)
                : ""}
            </span>
          </div>
          <p className="section-copy">
            {t(props.locale, "passwordProvidersHelp")}
          </p>
          <div
            className="provider-option-list"
            data-testid="password-provider-options"
          >
            {PROVIDER_OPTIONS.map((option) => (
              <button
                aria-pressed={providerKind === option.kind ? "true" : "false"}
                className={`provider-option ${
                  providerKind === option.kind ? "active" : ""
                }`}
                data-testid={`password-provider-option-${option.kind}`}
                key={option.kind}
                onClick={() => {
                  resetFeedback();
                  setProviderKind(option.kind);
                }}
                type="button"
              >
                <strong>{translateCode(props.locale, option.kind)}</strong>
                <p>{t(props.locale, option.descriptionKey)}</p>
                <span className="toolbar-count">
                  {t(props.locale, option.scopeKey)}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section
          className="detail-section"
          data-testid="password-common-section"
        >
          <div className="detail-section-header">
            <h3>{t(props.locale, "importDetailsTitle")}</h3>
            <span>{t(props.locale, "resourceId")}</span>
          </div>
          <p className="section-copy">{t(props.locale, "importDetailsHelp")}</p>
          <div className="settings-form-grid">
            <LocatorField
              dataTestId="password-field-resource"
              label={t(props.locale, "resourceId")}
              onChange={(value) => {
                setCommonDraft((current) => ({
                  ...current,
                  resource: value,
                }));
              }}
              optionalLabel={t(props.locale, "optional")}
              value={commonDraft.resource}
            />
            <LocatorField
              dataTestId="password-field-display-name"
              label={t(props.locale, "displayName")}
              onChange={(value) => {
                setCommonDraft((current) => ({
                  ...current,
                  displayName: value,
                }));
              }}
              optional
              optionalLabel={t(props.locale, "optional")}
              value={commonDraft.displayName}
            />
            <LocatorField
              dataTestId="password-field-description"
              label={t(props.locale, "description")}
              onChange={(value) => {
                setCommonDraft((current) => ({
                  ...current,
                  description: value,
                }));
              }}
              optional
              optionalLabel={t(props.locale, "optional")}
              value={commonDraft.description}
            />
            <label className="settings-field" data-testid="password-field-tags">
              <span className="field-label">{t(props.locale, "tags")}</span>
              <input
                className="settings-input"
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setCommonDraft((current) => ({
                    ...current,
                    tags: nextValue,
                  }));
                }}
                type="text"
                value={commonDraft.tags}
              />
              <span className="field-hint">{t(props.locale, "tagsHelp")}</span>
            </label>
          </div>
        </section>

        {providerKind === "1password_cli" ? (
          <>
            <PickerSection
              caption={sectionCaption(
                props.locale,
                "Configured account",
                "已配置账号",
              )}
              dataTestId="onepassword-account-picker"
              emptyMessage={
                isOnePasswordAccountsLoading
                  ? sectionCaption(
                      props.locale,
                      "Loading accounts",
                      "加载账号中",
                    )
                  : sectionCaption(
                      props.locale,
                      "No accounts available",
                      "没有可用账号",
                    )
              }
              loading={isOnePasswordAccountsLoading}
              onSelect={selectOnePasswordAccount}
              options={onePasswordAccounts}
              selectedId={selectedOnePasswordAccountId}
              title={t(props.locale, "account")}
            />

            <PickerSection
              caption={sectionCaption(props.locale, "Required", "必选")}
              dataTestId="onepassword-vault-picker"
              emptyMessage={
                selectedOnePasswordAccountId
                  ? isOnePasswordVaultsLoading
                    ? sectionCaption(
                        props.locale,
                        "Loading vaults",
                        "加载保险库中",
                      )
                    : sectionCaption(
                        props.locale,
                        "No vaults available",
                        "没有可用保险库",
                      )
                  : sectionCaption(
                      props.locale,
                      "Select an account first",
                      "先选择账号",
                    )
              }
              loading={isOnePasswordVaultsLoading}
              onSelect={selectOnePasswordVault}
              options={onePasswordVaults}
              selectedId={selectedOnePasswordVaultId}
              title={t(props.locale, "vault")}
            />

            <PickerSection
              caption={sectionCaption(
                props.locale,
                "Searchable list",
                "支持搜索",
              )}
              dataTestId="onepassword-item-picker"
              emptyMessage={
                selectedOnePasswordVaultId
                  ? isOnePasswordItemsLoading
                    ? sectionCaption(
                        props.locale,
                        "Loading items",
                        "加载条目中",
                      )
                    : sectionCaption(
                        props.locale,
                        "No items found",
                        "没有找到条目",
                      )
                  : sectionCaption(
                      props.locale,
                      "Select a vault first",
                      "先选择保险库",
                    )
              }
              loading={isOnePasswordItemsLoading}
              onSearchQueryChange={setOnePasswordItemQuery}
              onSelect={selectOnePasswordItem}
              options={onePasswordItems}
              searchPlaceholder={searchPlaceholder(
                props.locale,
                t(props.locale, "item"),
              )}
              searchQuery={onePasswordItemQuery}
              selectedId={selectedOnePasswordItemId}
              title={t(props.locale, "item")}
            />

            <PickerSection
              caption={sectionCaption(props.locale, "Field picker", "字段选择")}
              dataTestId="onepassword-field-picker"
              emptyMessage={
                selectedOnePasswordItemId
                  ? isOnePasswordFieldsLoading
                    ? sectionCaption(
                        props.locale,
                        "Loading fields",
                        "加载字段中",
                      )
                    : sectionCaption(
                        props.locale,
                        "No fields available",
                        "没有可用字段",
                      )
                  : sectionCaption(
                      props.locale,
                      "Select an item first",
                      "先选择条目",
                    )
              }
              loading={isOnePasswordFieldsLoading}
              onSelect={selectOnePasswordField}
              options={onePasswordFieldOptions}
              selectedId={selectedOnePasswordFieldId}
              title={t(props.locale, "field")}
            />

            {selectedOnePasswordItemId &&
            onePasswordFieldOptions.length === 0 ? (
              <section
                className="detail-section detail-section-low"
                data-testid="onepassword-field-fallback"
              >
                <div className="detail-section-header">
                  <h3>{t(props.locale, "field")}</h3>
                  <span>
                    {sectionCaption(
                      props.locale,
                      "Minimal fallback",
                      "最小兜底",
                    )}
                  </span>
                </div>
                <LocatorField
                  dataTestId="password-field-1password-field"
                  hint={sectionCaption(
                    props.locale,
                    "Only used when field enumeration is unavailable.",
                    "仅在字段枚举不可用时兜底使用。",
                  )}
                  label={t(props.locale, "field")}
                  onChange={(value) => {
                    setOnePasswordDraft((current) => ({
                      ...current,
                      field: value,
                    }));
                  }}
                  optionalLabel={t(props.locale, "optional")}
                  value={onePasswordDraft.field}
                />
              </section>
            ) : null}
          </>
        ) : null}

        {providerKind === "bitwarden_cli" ? (
          <>
            <PickerSection
              caption={sectionCaption(
                props.locale,
                "Detected session",
                "已检测到会话",
              )}
              dataTestId="bitwarden-account-picker"
              emptyMessage={
                isBitwardenAccountsLoading
                  ? sectionCaption(
                      props.locale,
                      "Loading account",
                      "加载账号中",
                    )
                  : sectionCaption(
                      props.locale,
                      "No Bitwarden session",
                      "没有 Bitwarden 会话",
                    )
              }
              loading={isBitwardenAccountsLoading}
              onSelect={selectBitwardenAccount}
              options={bitwardenAccounts}
              selectedId={selectedBitwardenAccountId}
              title={t(props.locale, "account")}
            />

            <PickerSection
              caption={sectionCaption(
                props.locale,
                "Container filter",
                "容器过滤",
              )}
              dataTestId="bitwarden-container-picker"
              emptyMessage={
                isBitwardenContainersLoading
                  ? sectionCaption(
                      props.locale,
                      "Loading containers",
                      "加载容器中",
                    )
                  : sectionCaption(
                      props.locale,
                      "No folders or collections available",
                      "没有可用容器",
                    )
              }
              loading={isBitwardenContainersLoading}
              onSelect={selectBitwardenContainer}
              options={bitwardenContainerOptions}
              selectedId={selectedBitwardenContainerId}
              title={sectionCaption(props.locale, "Container", "容器")}
            />

            <PickerSection
              caption={sectionCaption(
                props.locale,
                "Searchable item list",
                "支持搜索",
              )}
              dataTestId="bitwarden-item-picker"
              emptyMessage={
                isBitwardenItemsLoading
                  ? sectionCaption(props.locale, "Loading items", "加载条目中")
                  : sectionCaption(
                      props.locale,
                      "No items found",
                      "没有找到条目",
                    )
              }
              loading={isBitwardenItemsLoading}
              onSearchQueryChange={setBitwardenItemQuery}
              onSelect={selectBitwardenItem}
              options={bitwardenItems}
              searchPlaceholder={searchPlaceholder(
                props.locale,
                t(props.locale, "item"),
              )}
              searchQuery={bitwardenItemQuery}
              selectedId={selectedBitwardenItemId}
              title={t(props.locale, "item")}
            />

            <PickerSection
              caption={sectionCaption(props.locale, "Field picker", "字段选择")}
              dataTestId="bitwarden-field-picker"
              emptyMessage={
                selectedBitwardenItemId
                  ? isBitwardenFieldsLoading
                    ? sectionCaption(
                        props.locale,
                        "Loading fields",
                        "加载字段中",
                      )
                    : sectionCaption(
                        props.locale,
                        "No field suggestions",
                        "没有可用字段",
                      )
                  : sectionCaption(
                      props.locale,
                      "Select an item first",
                      "先选择条目",
                    )
              }
              loading={isBitwardenFieldsLoading}
              onSelect={selectBitwardenField}
              options={bitwardenFieldOptions}
              selectedId={selectedBitwardenFieldId}
              title={t(props.locale, "field")}
            />

            <section
              className="detail-section detail-section-low"
              data-testid="bitwarden-field-fallback"
            >
              <div className="detail-section-header">
                <h3>{t(props.locale, "field")}</h3>
                <span>
                  {sectionCaption(props.locale, "Minimal fallback", "最小兜底")}
                </span>
              </div>
              <LocatorField
                dataTestId="password-field-bitwarden-field"
                hint={sectionCaption(
                  props.locale,
                  "Keep a manual field fallback for custom names not returned by the CLI picker.",
                  "对 CLI picker 没列出的自定义字段保留最小手填兜底。",
                )}
                label={t(props.locale, "field")}
                onChange={(value) => {
                  setBitwardenDraft((current) => ({
                    ...current,
                    field: value,
                  }));
                }}
                optionalLabel={t(props.locale, "optional")}
                value={bitwardenDraft.field}
              />
            </section>
          </>
        ) : null}

        {providerKind === "dotenv_file" ? (
          <>
            <section
              className="detail-section"
              data-testid="dotenv-file-picker"
            >
              <div className="detail-section-header">
                <h3>{t(props.locale, "filePath")}</h3>
                <span>
                  {sectionCaption(
                    props.locale,
                    "Native chooser",
                    "原生文件选择器",
                  )}
                </span>
              </div>
              <div className="password-actions">
                <button
                  className="ghost"
                  data-testid="dotenv-choose-file-button"
                  disabled={isDotenvPicking}
                  onClick={() => {
                    void chooseDotenvFile();
                  }}
                  type="button"
                >
                  {sectionCaption(
                    props.locale,
                    "Choose .env File",
                    "选择 .env 文件",
                  )}
                </button>
              </div>
              <LocatorField
                dataTestId="password-field-dotenv-file"
                hint={sectionCaption(
                  props.locale,
                  "The chooser is the primary path. Keep file path as a minimal fallback only.",
                  "文件选择器是主路径；这里仅保留最小文件路径兜底。",
                )}
                label={t(props.locale, "filePath")}
                onChange={(value) => {
                  setDotenvDraft((current) => ({
                    ...current,
                    filePath: value,
                  }));
                }}
                optionalLabel={t(props.locale, "optional")}
                value={dotenvDraft.filePath}
              />
            </section>

            <PickerSection
              caption={sectionCaption(
                props.locale,
                "Prefix groups",
                "前缀分组",
              )}
              dataTestId="dotenv-group-picker"
              emptyMessage={
                dotenvDraft.filePath.trim().length === 0
                  ? sectionCaption(
                      props.locale,
                      "Choose a file first",
                      "先选择文件",
                    )
                  : isDotenvInspecting
                    ? sectionCaption(
                        props.locale,
                        "Inspecting file",
                        "分析文件中",
                      )
                    : sectionCaption(
                        props.locale,
                        "No keys found",
                        "没有找到 key",
                      )
              }
              loading={isDotenvInspecting}
              onSelect={selectDotenvGroup}
              options={dotenvGroupOptions}
              selectedId={selectedDotenvGroupId}
              title={sectionCaption(props.locale, "Import Range", "导入范围")}
            />

            <PickerSection
              caption={sectionCaption(props.locale, "Key list", "Key 列表")}
              dataTestId="dotenv-key-picker"
              emptyMessage={
                selectedDotenvGroupId
                  ? isDotenvInspecting
                    ? sectionCaption(
                        props.locale,
                        "Loading keys",
                        "加载 key 中",
                      )
                    : sectionCaption(
                        props.locale,
                        "No keys found",
                        "没有找到 key",
                      )
                  : sectionCaption(
                      props.locale,
                      "Choose a group first",
                      "先选择分组",
                    )
              }
              loading={isDotenvInspecting}
              onSearchQueryChange={setDotenvKeyQuery}
              onSelect={(nextKey) => {
                const option =
                  visibleDotenvKeys.find(
                    (entry) => entry.full_key === nextKey,
                  ) ?? null;
                if (option) {
                  selectDotenvKey(option);
                }
              }}
              options={dotenvKeyOptions}
              searchPlaceholder={searchPlaceholder(
                props.locale,
                t(props.locale, "key"),
              )}
              searchQuery={dotenvKeyQuery}
              selectedId={selectedDotenvKey}
              title={t(props.locale, "key")}
            />
          </>
        ) : null}

        <section
          className="detail-section detail-section-low"
          data-testid="password-boundaries-section"
        >
          <div className="detail-section-header">
            <h3>{t(props.locale, "passwordBoundariesTitle")}</h3>
            <span>{translateCode(props.locale, providerKind)}</span>
          </div>
          <ul className="boundary-list" data-testid="password-boundaries-list">
            <li>{t(props.locale, "passwordBoundaryNoLogin")}</li>
            <li>{t(props.locale, "passwordBoundaryNoSnapshot")}</li>
            <li>{t(props.locale, "passwordBoundaryNoRegression")}</li>
          </ul>
        </section>
      </div>

      <div className="password-actions" data-testid="password-import-actions">
        <button
          className="primary"
          data-testid="password-import-submit"
          disabled={!canSubmit || isSubmitting}
          onClick={() => {
            void submitImport();
          }}
          type="button"
        >
          {isSubmitting
            ? t(props.locale, "importingSource")
            : t(props.locale, "importSource")}
        </button>
      </div>

      {receipt ? (
        <section
          className="detail-section detail-section-wide"
          data-testid="password-import-receipt"
        >
          <div className="detail-section-header">
            <h3>{t(props.locale, "importReceiptTitle")}</h3>
            <span>
              {translateCode(props.locale, receipt.reference.provider_kind)}
            </span>
          </div>
          <dl className="facts">
            <div data-testid="password-receipt-resource">
              <dt>{t(props.locale, "importedResource")}</dt>
              <dd>{receipt.reference.resource}</dd>
            </div>
            <div data-testid="password-receipt-catalog-path">
              <dt>{t(props.locale, "catalogPath")}</dt>
              <dd>{receipt.catalog_path}</dd>
            </div>
            <div data-testid="password-receipt-container">
              <dt>{t(props.locale, "importedContainer")}</dt>
              <dd>
                {getImportedContainerLabel(receipt.reference) ??
                  t(props.locale, "notAvailable")}
              </dd>
            </div>
            <div data-testid="password-receipt-field">
              <dt>{t(props.locale, "importedField")}</dt>
              <dd>{getImportedFieldSelector(receipt.reference)}</dd>
            </div>
            <div data-testid="password-receipt-imported-at">
              <dt>{t(props.locale, "importedAt")}</dt>
              <dd>
                {formatTimestamp(
                  receipt.reference.imported_at,
                  t(props.locale, "notAvailable"),
                  props.locale,
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}
    </section>
  );
}
