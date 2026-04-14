import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type JSX } from "react";

import { ImportedSecretCatalogPanel } from "./ImportedSecretCatalogPanel";
import { formatTimestamp } from "../formatters";
import { t, translateCode, type Locale } from "../i18n";
import type {
  BitwardenContainerOption,
  DotenvGroupOption,
  DotenvInspection,
  DotenvKeyOption,
  ImportFieldOption,
  ImportPickerOption,
  ImportedSecretBatchReceipt,
  ImportedSecretCatalog,
  ImportedSecretReceipt,
  ImportedSecretReference,
  ImportedSecretReferenceUpdate,
  SecretImportBatchSpec,
  SecretImportSpec,
  SecretSourceLocator,
} from "../types";

type SecretImportProviderKind = SecretSourceLocator["provider_kind"];

type CommonImportDraft = {
  resource: string;
  displayName: string;
  description: string;
  tags: string;
  metadata: string;
};

type OnePasswordDraft = {
  account: string;
  accountId: string;
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

type ResourceTemplateMode = "default" | "custom";
type ResourceTemplateTokenMap = Record<string, string>;
type ResourcePreviewResult = {
  missingTokens: string[];
  resource: string | null;
};
type FieldOptionsByResourceId = Record<string, ImportFieldOption[]>;

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
  disabled?: boolean;
};

type MultiPickerSectionProps = {
  title: string;
  caption?: string;
  helper?: string;
  dataTestId: string;
  options: PickerRenderableOption[];
  selectedIds: string[];
  onToggleSelect: (id: string) => void;
  emptyMessage: string;
  loading: boolean;
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
  searchPlaceholder?: string;
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
  metadata: "",
};

const EMPTY_ONEPASSWORD_DRAFT: OnePasswordDraft = {
  account: "",
  accountId: "",
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

function parseMetadataDraft(value: string): {
  metadata: Record<string, string>;
  invalidLines: string[];
} {
  const metadata: Record<string, string> = {};
  const invalidLines: string[] = [];

  for (const rawLine of value.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === line.length - 1) {
      invalidLines.push(line);
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const nextValue = line.slice(separatorIndex + 1).trim();
    if (key.length === 0 || nextValue.length === 0) {
      invalidLines.push(line);
      continue;
    }

    metadata[key] = nextValue;
  }

  return {
    metadata,
    invalidLines,
  };
}

function normalizeResourceSegment(value: string): string | null {
  let normalized = "";
  let previousWasDash = false;

  for (const character of value.trim()) {
    let next: string;
    if (
      (character >= "a" && character <= "z") ||
      (character >= "0" && character <= "9") ||
      character === "_" ||
      character === "."
    ) {
      next = character;
    } else if (character >= "A" && character <= "Z") {
      next = character.toLowerCase();
    } else {
      next = "-";
    }

    if (next === "-") {
      if (normalized.length === 0 || previousWasDash) {
        continue;
      }

      previousWasDash = true;
      normalized += next;
      continue;
    }

    previousWasDash = false;
    normalized += next;
  }

  const trimmed = normalized.replace(/^[-_.]+|[-_.]+$/g, "");
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeResourcePath(value: string): string {
  return value
    .split("/")
    .map((segment) => normalizeResourceSegment(segment))
    .filter((segment): segment is string => segment !== null)
    .join("/");
}

function defaultResourceTemplateForProvider(
  providerKind: SecretImportProviderKind,
): string {
  if (providerKind === "1password_cli") {
    return "secret/{{ account }}/{{ vault }}/{{ item }}/{{ field }}";
  }

  if (providerKind === "bitwarden_cli") {
    return "secret/{{ container }}/{{ item }}/{{ field }}";
  }

  return "secret/{{ source_name }}/{{ key }}";
}

function availableTemplateTokens(
  providerKind: SecretImportProviderKind,
): string[] {
  if (providerKind === "1password_cli") {
    return [
      "provider_kind",
      "account",
      "account_id",
      "vault",
      "vault_id",
      "container",
      "item",
      "item_id",
      "field",
      "field_id",
    ];
  }

  if (providerKind === "bitwarden_cli") {
    return [
      "provider_kind",
      "account",
      "organization",
      "collection",
      "folder",
      "container",
      "item",
      "item_id",
      "field",
    ];
  }

  return [
    "provider_kind",
    "file_path",
    "file_name",
    "file_stem",
    "namespace",
    "prefix",
    "source_name",
    "key",
  ];
}

function pathFileName(value: string): string {
  return value.split(/[/\\]/).filter(Boolean).at(-1) ?? "dotenv";
}

function pathFileStem(value: string): string {
  const fileName = pathFileName(value);
  const lastDot = fileName.lastIndexOf(".");
  return lastDot > 0 ? fileName.slice(0, lastDot) : fileName;
}

function templateTokensForSourceLocator(
  locator: SecretSourceLocator,
): ResourceTemplateTokenMap {
  if (locator.provider_kind === "1password_cli") {
    const tokens: ResourceTemplateTokenMap = {
      provider_kind: locator.provider_kind,
      account: locator.account,
      vault: locator.vault,
      container: locator.vault,
      item: locator.item,
      field: locator.field,
    };

    if (locator.account_id) {
      tokens.account_id = locator.account_id;
    }
    if (locator.vault_id) {
      tokens.vault_id = locator.vault_id;
    }
    if (locator.item_id) {
      tokens.item_id = locator.item_id;
    }
    if (locator.field_id) {
      tokens.field_id = locator.field_id;
    }

    return tokens;
  }

  if (locator.provider_kind === "bitwarden_cli") {
    const container =
      locator.collection ??
      locator.folder ??
      locator.organization ??
      locator.account;
    const tokens: ResourceTemplateTokenMap = {
      provider_kind: locator.provider_kind,
      account: locator.account,
      container,
      item: locator.item,
      field: locator.field,
    };

    if (locator.organization) {
      tokens.organization = locator.organization;
    }
    if (locator.collection) {
      tokens.collection = locator.collection;
    }
    if (locator.folder) {
      tokens.folder = locator.folder;
    }
    if (locator.item_id) {
      tokens.item_id = locator.item_id;
    }

    return tokens;
  }

  const tokens: ResourceTemplateTokenMap = {
    provider_kind: locator.provider_kind,
    file_path: locator.file_path,
    file_name: pathFileName(locator.file_path),
    file_stem: pathFileStem(locator.file_path),
    key: locator.key,
  };

  if (locator.namespace) {
    tokens.namespace = locator.namespace;
    tokens.source_name = locator.namespace;
  }
  if (locator.prefix) {
    tokens.prefix = locator.prefix;
    if (!tokens.source_name) {
      tokens.source_name = locator.prefix;
    }
  }
  if (!tokens.source_name) {
    tokens.source_name = tokens.file_stem || tokens.file_name;
  }

  return tokens;
}

function renderGeneratedResource(
  template: string,
  tokens: ResourceTemplateTokenMap,
): ResourcePreviewResult {
  const missingTokens = Array.from(
    new Set(
      Array.from(template.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi))
        .map((match) => match[1])
        .filter((token) => !(token in tokens)),
    ),
  );

  if (missingTokens.length > 0) {
    return {
      missingTokens,
      resource: null,
    };
  }

  const rendered = template.replace(
    /\{\{\s*([a-z0-9_]+)\s*\}\}/gi,
    (_, token: string) => tokens[token] ?? "",
  );
  const normalized = normalizeResourcePath(rendered);

  return {
    missingTokens: [],
    resource: normalized.length > 0 ? normalized : null,
  };
}

function previewResourceForImport(
  spec: SecretImportSpec,
  resourceTemplate: string | null,
): ResourcePreviewResult {
  const explicitResource = spec.resource.trim();
  if (explicitResource.length > 0) {
    return {
      missingTokens: [],
      resource: explicitResource,
    };
  }

  const template =
    resourceTemplate && resourceTemplate.trim().length > 0
      ? resourceTemplate
      : defaultResourceTemplateForProvider(spec.source_locator.provider_kind);

  return renderGeneratedResource(
    template,
    templateTokensForSourceLocator(spec.source_locator),
  );
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values));
}

function batchResourceTemplateForSubmit(
  mode: ResourceTemplateMode,
  template: string,
  explicitResource: string,
): string | null {
  if (explicitResource.trim().length > 0 || mode !== "custom") {
    return null;
  }

  const trimmed = template.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function importBatchPayload(
  resourceTemplate: string | null,
  imports: SecretImportSpec[],
): SecretImportBatchSpec {
  return {
    resource_template: resourceTemplate,
    imports,
  };
}

function optionById<T extends { id: string }>(
  options: T[],
  nextId: string | null,
): T | null {
  if (!nextId) {
    return null;
  }

  return options.find((option) => option.id === nextId) ?? null;
}

function hasCachedFieldOptions(
  cache: FieldOptionsByResourceId,
  resourceId: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(cache, resourceId);
}

function toggleSelection(
  current: string[],
  id: string,
  selectionMode: "single" | "multi",
): string[] {
  if (selectionMode === "single") {
    return current[0] === id ? [] : [id];
  }

  if (current.includes(id)) {
    return current.filter((entry) => entry !== id);
  }

  return [...current, id];
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

function dotenvKeySelectionId(option: DotenvKeyOption): string {
  return `${option.group_id}:${option.full_key}`;
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

function MultiPickerSection(props: MultiPickerSectionProps): JSX.Element {
  const visibleOptions = props.options.filter((option) =>
    matchesQuery(option, props.searchQuery),
  );

  return (
    <section className="detail-section" data-testid={props.dataTestId}>
      <div className="detail-section-header">
        <h3>{props.title}</h3>
        {props.caption ? <span>{props.caption}</span> : null}
      </div>
      {props.helper ? (
        <p className="section-copy" data-testid={`${props.dataTestId}-helper`}>
          {props.helper}
        </p>
      ) : null}
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
            const isActive = props.selectedIds.includes(option.id);
            return (
              <button
                aria-pressed={isActive ? "true" : "false"}
                className={`queue-item ${isActive ? "active" : ""}`}
                data-option-id={option.id}
                data-selected={isActive ? "true" : "false"}
                data-testid={`${props.dataTestId}-option`}
                key={option.id}
                onClick={() => {
                  props.onToggleSelect(option.id);
                }}
                type="button"
              >
                <div className="queue-item-header">
                  <strong>{option.label}</strong>
                  <span>{isActive ? "Selected" : "Select"}</span>
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
        disabled={props.disabled}
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
  const [resourceTemplateMode, setResourceTemplateMode] =
    useState<ResourceTemplateMode>("default");
  const [resourceTemplate, setResourceTemplate] = useState("");
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
  const [receipts, setReceipts] = useState<ImportedSecretReceipt[]>([]);
  const [importedCatalog, setImportedCatalog] =
    useState<ImportedSecretCatalog | null>(null);
  const [browseErrorMessage, setBrowseErrorMessage] = useState<string | null>(
    null,
  );
  const [submitErrorMessage, setSubmitErrorMessage] = useState<string | null>(
    null,
  );
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [catalogErrorMessage, setCatalogErrorMessage] = useState<string | null>(
    null,
  );
  const [catalogNoticeMessage, setCatalogNoticeMessage] = useState<
    string | null
  >(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCatalogLoading, setIsCatalogLoading] = useState(false);

  const [onePasswordAccounts, setOnePasswordAccounts] = useState<
    ImportPickerOption[]
  >([]);
  const [onePasswordVaults, setOnePasswordVaults] = useState<
    ImportPickerOption[]
  >([]);
  const [onePasswordItems, setOnePasswordItems] = useState<
    ImportPickerOption[]
  >([]);
  const [onePasswordFieldsByItemId, setOnePasswordFieldsByItemId] =
    useState<FieldOptionsByResourceId>({});
  const [selectedOnePasswordAccountId, setSelectedOnePasswordAccountId] =
    useState<string | null>(null);
  const [selectedOnePasswordVaultId, setSelectedOnePasswordVaultId] = useState<
    string | null
  >(null);
  const [selectedOnePasswordItemId, setSelectedOnePasswordItemId] = useState<
    string | null
  >(null);
  const [selectedOnePasswordItemIds, setSelectedOnePasswordItemIds] = useState<
    string[]
  >([]);
  const [selectedOnePasswordFieldId, setSelectedOnePasswordFieldId] = useState<
    string | null
  >(null);
  const [selectedOnePasswordFieldIds, setSelectedOnePasswordFieldIds] =
    useState<string[]>([]);
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
  const [bitwardenFieldsByItemId, setBitwardenFieldsByItemId] =
    useState<FieldOptionsByResourceId>({});
  const [selectedBitwardenAccountId, setSelectedBitwardenAccountId] = useState<
    string | null
  >(null);
  const [selectedBitwardenContainerId, setSelectedBitwardenContainerId] =
    useState<string | null>("all");
  const [selectedBitwardenItemId, setSelectedBitwardenItemId] = useState<
    string | null
  >(null);
  const [selectedBitwardenItemIds, setSelectedBitwardenItemIds] = useState<
    string[]
  >([]);
  const [selectedBitwardenFieldId, setSelectedBitwardenFieldId] = useState<
    string | null
  >(null);
  const [selectedBitwardenFieldIds, setSelectedBitwardenFieldIds] = useState<
    string[]
  >([]);
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
  const [selectedDotenvKeys, setSelectedDotenvKeys] = useState<string[]>([]);
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
  const onePasswordFields: ImportFieldOption[] = selectedOnePasswordItemId
    ? (onePasswordFieldsByItemId[selectedOnePasswordItemId] ?? [])
    : [];
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
  const bitwardenFields: ImportFieldOption[] = selectedBitwardenItemId
    ? (bitwardenFieldsByItemId[selectedBitwardenItemId] ?? [])
    : [];
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
  const selectedOnePasswordItems = onePasswordItems.filter((option) =>
    selectedOnePasswordItemIds.includes(option.id),
  );
  const selectedOnePasswordFields = onePasswordFields.filter((field) =>
    selectedOnePasswordFieldIds.includes(fieldOptionId(field)),
  );
  const isOnePasswordMultiResourceMode = selectedOnePasswordItemIds.length > 1;
  const areOnePasswordSelectedFieldsReady =
    selectedOnePasswordItems.length > 0 &&
    selectedOnePasswordItems.every((item) =>
      hasCachedFieldOptions(onePasswordFieldsByItemId, item.id),
    );
  const selectedBitwardenItems = bitwardenItems.filter((option) =>
    selectedBitwardenItemIds.includes(option.id),
  );
  const selectedBitwardenFields = bitwardenFields.filter((field) =>
    selectedBitwardenFieldIds.includes(fieldOptionId(field)),
  );
  const isBitwardenMultiResourceMode = selectedBitwardenItemIds.length > 1;
  const areBitwardenSelectedFieldsReady =
    selectedBitwardenItems.length > 0 &&
    selectedBitwardenItems.every((item) =>
      hasCachedFieldOptions(bitwardenFieldsByItemId, item.id),
    );
  const selectedDotenvKeyOptions = (dotenvInspection?.keys ?? []).filter(
    (option) => selectedDotenvKeys.includes(dotenvKeySelectionId(option)),
  );
  const explicitResource = commonDraft.resource.trim();
  const sharedResourceTemplate = batchResourceTemplateForSubmit(
    resourceTemplateMode,
    resourceTemplate,
    explicitResource,
  );
  const resolvedResourceTemplate =
    resourceTemplateMode === "custom"
      ? resourceTemplate
      : defaultResourceTemplateForProvider(providerKind);
  const metadataDraft = parseMetadataDraft(commonDraft.metadata);

  let plannedSpecs: SecretImportSpec[] = [];
  let planBlockerMessage: string | null = null;

  if (
    resourceTemplateMode === "custom" &&
    commonDraft.resource.trim().length === 0 &&
    resourceTemplate.trim().length === 0
  ) {
    planBlockerMessage = sectionCaption(
      props.locale,
      "Custom resource templates cannot be empty.",
      "自定义资源模板不能为空。",
    );
  } else if (metadataDraft.invalidLines.length > 0) {
    planBlockerMessage = sectionCaption(
      props.locale,
      `Metadata must use KEY=VALUE lines: ${metadataDraft.invalidLines.join(", ")}`,
      `元信息必须使用 KEY=VALUE 格式：${metadataDraft.invalidLines.join("、")}`,
    );
  } else if (providerKind === "1password_cli") {
    if (
      onePasswordDraft.account.trim().length > 0 &&
      onePasswordDraft.vault.trim().length > 0 &&
      selectedOnePasswordItems.length > 0
    ) {
      const manualResource = commonDraft.resource.trim();
      const manualDisplayName = optionalValue(commonDraft.displayName);
      const description = optionalValue(commonDraft.description);
      const tags = parseTags(commonDraft.tags);
      const metadata = metadataDraft.metadata;
      const isSingleImport =
        selectedOnePasswordItems.length === 1 &&
        selectedOnePasswordFields.length === 1;

      if (isOnePasswordMultiResourceMode) {
        if (areOnePasswordSelectedFieldsReady) {
          plannedSpecs = selectedOnePasswordItems.flatMap((item) =>
            (onePasswordFieldsByItemId[item.id] ?? []).map((field) => {
              return {
                resource: "",
                display_name: null,
                description,
                tags,
                metadata,
                source_locator: {
                  provider_kind: "1password_cli",
                  account: onePasswordDraft.account.trim(),
                  account_id: optionalValue(onePasswordDraft.accountId),
                  vault: onePasswordDraft.vault.trim(),
                  vault_id: optionalValue(onePasswordDraft.vaultId),
                  item: item.label,
                  item_id: item.id,
                  field: field.selector,
                  field_id: optionalValue(field.field_id ?? ""),
                },
              } satisfies SecretImportSpec;
            }),
          );
        }
      } else if (selectedOnePasswordFields.length > 0) {
        plannedSpecs = selectedOnePasswordItems.flatMap((item) =>
          selectedOnePasswordFields.map((field) => {
            return {
              resource:
                manualResource.length > 0 && isSingleImport
                  ? manualResource
                  : "",
              display_name: isSingleImport ? manualDisplayName : null,
              description,
              tags,
              metadata,
              source_locator: {
                provider_kind: "1password_cli",
                account: onePasswordDraft.account.trim(),
                account_id: optionalValue(onePasswordDraft.accountId),
                vault: onePasswordDraft.vault.trim(),
                vault_id: optionalValue(onePasswordDraft.vaultId),
                item: item.label,
                item_id: item.id,
                field: field.selector,
                field_id: optionalValue(field.field_id ?? ""),
              },
            } satisfies SecretImportSpec;
          }),
        );
      }
    }
  } else if (providerKind === "bitwarden_cli") {
    if (
      bitwardenDraft.account.trim().length > 0 &&
      selectedBitwardenItems.length > 0
    ) {
      const manualResource = commonDraft.resource.trim();
      const manualDisplayName = optionalValue(commonDraft.displayName);
      const description = optionalValue(commonDraft.description);
      const tags = parseTags(commonDraft.tags);
      const metadata = metadataDraft.metadata;
      const isSingleImport =
        selectedBitwardenItems.length === 1 &&
        selectedBitwardenFields.length === 1;

      if (isBitwardenMultiResourceMode) {
        if (areBitwardenSelectedFieldsReady) {
          plannedSpecs = selectedBitwardenItems.flatMap((item) =>
            (bitwardenFieldsByItemId[item.id] ?? []).map((field) => {
              return {
                resource: "",
                display_name: null,
                description,
                tags,
                metadata,
                source_locator: {
                  provider_kind: "bitwarden_cli",
                  account: bitwardenDraft.account.trim(),
                  organization: optionalValue(bitwardenDraft.organization),
                  collection: optionalValue(bitwardenDraft.collection),
                  folder: optionalValue(bitwardenDraft.folder),
                  item: item.label,
                  item_id: item.id,
                  field: field.selector,
                },
              } satisfies SecretImportSpec;
            }),
          );
        }
      } else if (selectedBitwardenFields.length > 0) {
        plannedSpecs = selectedBitwardenItems.flatMap((item) =>
          selectedBitwardenFields.map((field) => {
            return {
              resource:
                manualResource.length > 0 && isSingleImport
                  ? manualResource
                  : "",
              display_name: isSingleImport ? manualDisplayName : null,
              description,
              tags,
              metadata,
              source_locator: {
                provider_kind: "bitwarden_cli",
                account: bitwardenDraft.account.trim(),
                organization: optionalValue(bitwardenDraft.organization),
                collection: optionalValue(bitwardenDraft.collection),
                folder: optionalValue(bitwardenDraft.folder),
                item: item.label,
                item_id: item.id,
                field: field.selector,
              },
            } satisfies SecretImportSpec;
          }),
        );
      }
    }
  } else if (
    dotenvDraft.filePath.trim().length > 0 &&
    selectedDotenvKeyOptions.length > 0
  ) {
    const manualResource = commonDraft.resource.trim();
    const manualDisplayName = optionalValue(commonDraft.displayName);
    const description = optionalValue(commonDraft.description);
    const tags = parseTags(commonDraft.tags);
    const metadata = metadataDraft.metadata;
    const isSingleImport = selectedDotenvKeyOptions.length === 1;

    plannedSpecs = selectedDotenvKeyOptions.map((option) => {
      const resolvedKey =
        selectedDotenvGroup?.prefix && option.group_id !== "all"
          ? option.label
          : option.full_key;

      return {
        resource:
          manualResource.length > 0 && isSingleImport ? manualResource : "",
        display_name: isSingleImport ? manualDisplayName : null,
        description,
        tags,
        metadata,
        source_locator: {
          provider_kind: "dotenv_file",
          file_path: dotenvDraft.filePath.trim(),
          namespace: optionalValue(selectedDotenvGroup?.namespace ?? ""),
          prefix: optionalValue(selectedDotenvGroup?.prefix ?? ""),
          key: resolvedKey,
        },
      } satisfies SecretImportSpec;
    });
  }

  const plannedPreviewEntries = plannedSpecs.map((spec) => ({
    spec,
    ...previewResourceForImport(spec, sharedResourceTemplate),
  }));

  if (!planBlockerMessage) {
    const missingTokens = uniqueValues(
      plannedPreviewEntries.flatMap((entry) => entry.missingTokens),
    );

    if (missingTokens.length > 0) {
      planBlockerMessage = sectionCaption(
        props.locale,
        `Template uses unsupported placeholders: ${missingTokens.join(", ")}`,
        `模板包含不支持的占位符：${missingTokens.join("、")}`,
      );
    }
  }

  if (!planBlockerMessage) {
    const invalidPreview = plannedPreviewEntries.find(
      (entry) => entry.resource === null,
    );

    if (invalidPreview) {
      planBlockerMessage = sectionCaption(
        props.locale,
        "The current template does not produce a valid resource id.",
        "当前模板没有生成有效的资源标识。",
      );
    }
  }

  if (!planBlockerMessage) {
    const duplicates = plannedPreviewEntries.reduce<Record<string, number>>(
      (counts, entry) => {
        const resource = entry.resource ?? "";
        counts[resource] = (counts[resource] ?? 0) + 1;
        return counts;
      },
      {},
    );
    const duplicateResource = Object.keys(duplicates).find(
      (resource) => duplicates[resource] > 1,
    );

    if (duplicateResource) {
      planBlockerMessage = sectionCaption(
        props.locale,
        `Resource template produced duplicate ids: ${duplicateResource}`,
        `资源模板生成了重复资源标识：${duplicateResource}`,
      );
    }
  }

  const previewResources = plannedPreviewEntries
    .map((entry) => entry.resource)
    .filter((resource): resource is string => resource !== null);
  const previewEmptyMessage =
    providerKind === "1password_cli" && isOnePasswordMultiResourceMode
      ? isOnePasswordFieldsLoading || !areOnePasswordSelectedFieldsReady
        ? sectionCaption(
            props.locale,
            "Loading fields for the selected resources.",
            "正在加载所选资源的字段。",
          )
        : sectionCaption(
            props.locale,
            "No importable fields were found for the selected resources.",
            "所选资源没有可导入的字段。",
          )
      : providerKind === "bitwarden_cli" && isBitwardenMultiResourceMode
        ? isBitwardenFieldsLoading || !areBitwardenSelectedFieldsReady
          ? sectionCaption(
              props.locale,
              "Loading fields for the selected resources.",
              "正在加载所选资源的字段。",
            )
          : sectionCaption(
              props.locale,
              "No importable fields were found for the selected resources.",
              "所选资源没有可导入的字段。",
            )
        : sectionCaption(
            props.locale,
            "Select resources and fields to preview generated ids.",
            "先选择资源和字段，再预览生成后的资源标识。",
          );
  const isBatchMode =
    plannedSpecs.length > 1 ||
    selectedOnePasswordItemIds.length > 1 ||
    selectedOnePasswordFieldIds.length > 1 ||
    selectedBitwardenItemIds.length > 1 ||
    selectedBitwardenFieldIds.length > 1 ||
    selectedDotenvKeys.length > 1;
  const canSubmit = plannedSpecs.length > 0 && planBlockerMessage === null;
  const importedReceipts = receipts;

  function resetFeedback(): void {
    setBrowseErrorMessage(null);
    setSubmitErrorMessage(null);
    setNoticeMessage(null);
    setReceipts([]);
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

  async function loadImportedCatalog(options?: {
    silent?: boolean;
  }): Promise<void> {
    if (!options?.silent) {
      setIsCatalogLoading(true);
    }
    setCatalogErrorMessage(null);

    try {
      const nextCatalog = await invoke<ImportedSecretCatalog>(
        "list_imported_secret_sources",
      );
      setImportedCatalog(nextCatalog);
    } catch (error) {
      setCatalogErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (!options?.silent) {
        setIsCatalogLoading(false);
      }
    }
  }

  function handleBrowseError(error: unknown): void {
    setBrowseErrorMessage(
      error instanceof Error ? error.message : String(error),
    );
  }

  async function saveImportedSecret(
    update: ImportedSecretReferenceUpdate,
  ): Promise<void> {
    setCatalogErrorMessage(null);

    try {
      const receipt = await invoke<ImportedSecretReceipt>(
        "update_imported_secret_source",
        {
          update,
        },
      );
      setCatalogNoticeMessage(
        sectionCaption(
          props.locale,
          `Saved metadata for ${receipt.reference.resource}`,
          `已保存 ${receipt.reference.resource} 的元信息`,
        ),
      );
      await loadImportedCatalog({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCatalogErrorMessage(message);
      throw error;
    }
  }

  async function deleteImportedSecret(resource: string): Promise<void> {
    setCatalogErrorMessage(null);

    try {
      const deleted = await invoke<boolean>("delete_imported_secret_source", {
        resource,
      });
      if (!deleted) {
        throw new Error(
          sectionCaption(
            props.locale,
            `Imported resource was not found: ${resource}`,
            `未找到导入资源：${resource}`,
          ),
        );
      }
      setCatalogNoticeMessage(
        sectionCaption(
          props.locale,
          `Removed import ${resource}`,
          `已删除导入 ${resource}`,
        ),
      );
      await loadImportedCatalog({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCatalogErrorMessage(message);
      throw error;
    }
  }

  async function submitImport(): Promise<void> {
    setIsSubmitting(true);
    setSubmitErrorMessage(null);
    setNoticeMessage(null);

    try {
      const nextBatchReceipt = await invoke<ImportedSecretBatchReceipt>(
        "import_secret_sources",
        {
          spec: importBatchPayload(sharedResourceTemplate, plannedSpecs),
        },
      );
      const nextReceipts = nextBatchReceipt.receipts;

      setReceipts(nextReceipts);
      await loadImportedCatalog({ silent: true });
      setNoticeMessage(
        nextReceipts.length === 1
          ? t(props.locale, "importSourceSuccess", {
              resource: nextReceipts[0].reference.resource,
            })
          : sectionCaption(
              props.locale,
              `Imported ${nextReceipts.length} resources`,
              `已导入 ${nextReceipts.length} 个资源`,
            ),
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
    applyOnePasswordAccountSelection(nextAccountId, onePasswordAccounts);
  }

  function applyOnePasswordAccountSelection(
    nextAccountId: string,
    options: ImportPickerOption[],
  ): void {
    if (nextAccountId === selectedOnePasswordAccountId) {
      return;
    }

    const nextAccount = optionById(options, nextAccountId);
    setSelectedOnePasswordAccountId(nextAccountId);
    setSelectedOnePasswordVaultId(null);
    setSelectedOnePasswordItemId(null);
    setSelectedOnePasswordItemIds([]);
    setSelectedOnePasswordFieldId(null);
    setSelectedOnePasswordFieldIds([]);
    setOnePasswordVaults([]);
    setOnePasswordItems([]);
    setOnePasswordFieldsByItemId({});
    setOnePasswordItemQuery("");
    setOnePasswordDraft((current) => ({
      ...current,
      account: nextAccount?.label ?? current.account,
      accountId: nextAccount?.id ?? current.accountId,
      vault: "",
      item: "",
      field: "",
      vaultId: "",
      itemId: "",
      fieldId: "",
    }));
  }

  function selectOnePasswordVault(nextVaultId: string): void {
    applyOnePasswordVaultSelection(nextVaultId, onePasswordVaults);
  }

  function applyOnePasswordVaultSelection(
    nextVaultId: string,
    options: ImportPickerOption[],
  ): void {
    if (nextVaultId === selectedOnePasswordVaultId) {
      return;
    }

    const nextVault = optionById(options, nextVaultId);
    setSelectedOnePasswordVaultId(nextVaultId);
    setSelectedOnePasswordItemId(null);
    setSelectedOnePasswordItemIds([]);
    setSelectedOnePasswordFieldId(null);
    setSelectedOnePasswordFieldIds([]);
    setOnePasswordItems([]);
    setOnePasswordFieldsByItemId({});
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

  function toggleOnePasswordItem(nextItemId: string): void {
    applyOnePasswordItemSelection(nextItemId, onePasswordItems);
  }

  function applyOnePasswordItemSelection(
    nextItemId: string,
    options: ImportPickerOption[],
  ): void {
    const nextSelectedIds = toggleSelection(
      selectedOnePasswordItemIds,
      nextItemId,
      "multi",
    );
    const nextPrimaryId = nextSelectedIds.at(-1) ?? null;
    const nextItem = optionById(options, nextPrimaryId);

    setSelectedOnePasswordItemIds(nextSelectedIds);
    setSelectedOnePasswordItemId(nextPrimaryId);
    setSelectedOnePasswordFieldId(null);
    setSelectedOnePasswordFieldIds([]);
    setOnePasswordDraft((current) => ({
      ...current,
      item: nextItem?.label ?? "",
      itemId: nextItem?.id ?? "",
      field: "",
      fieldId: "",
    }));
    if (nextItem) {
      suggestDisplayName(nextItem.label);
    }
  }

  function toggleOnePasswordField(nextFieldId: string): void {
    applyOnePasswordFieldSelection(nextFieldId, onePasswordFields);
  }

  function applyOnePasswordFieldSelection(
    nextFieldId: string,
    options: ImportFieldOption[],
  ): void {
    const selectionMode =
      selectedOnePasswordItemIds.length > 1 ? "single" : "multi";
    const nextSelectedIds = toggleSelection(
      selectedOnePasswordFieldIds,
      nextFieldId,
      selectionMode,
    );
    const nextPrimaryId = nextSelectedIds.at(0) ?? null;
    const nextField =
      options.find((field) => fieldOptionId(field) === nextPrimaryId) ?? null;

    setSelectedOnePasswordFieldIds(nextSelectedIds);
    setSelectedOnePasswordFieldId(nextPrimaryId);
    setOnePasswordDraft((current) => ({
      ...current,
      field: nextField?.selector ?? "",
      fieldId:
        selectedOnePasswordItemIds.length === 1
          ? (nextField?.field_id ?? "")
          : "",
    }));
    if (nextField && selectedOnePasswordItem) {
      suggestDisplayName(`${selectedOnePasswordItem.label}:${nextField.label}`);
    }
  }

  function selectBitwardenAccount(nextAccountId: string): void {
    applyBitwardenAccountSelection(nextAccountId, bitwardenAccounts);
  }

  function applyBitwardenAccountSelection(
    nextAccountId: string,
    options: ImportPickerOption[],
  ): void {
    const nextAccount = optionById(options, nextAccountId);
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
    setSelectedBitwardenItemIds([]);
    setSelectedBitwardenFieldId(null);
    setSelectedBitwardenFieldIds([]);
    setBitwardenFieldsByItemId({});
  }

  function selectBitwardenContainer(nextContainerId: string): void {
    const nextContainer =
      bitwardenContainers.find((option) => option.id === nextContainerId) ??
      null;
    setSelectedBitwardenContainerId(nextContainerId);
    setSelectedBitwardenItemId(null);
    setSelectedBitwardenItemIds([]);
    setSelectedBitwardenFieldId(null);
    setSelectedBitwardenFieldIds([]);
    setBitwardenFieldsByItemId({});
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

  function toggleBitwardenItem(nextItemId: string): void {
    applyBitwardenItemSelection(nextItemId, bitwardenItems);
  }

  function applyBitwardenItemSelection(
    nextItemId: string,
    options: ImportPickerOption[],
  ): void {
    const nextSelectedIds = toggleSelection(
      selectedBitwardenItemIds,
      nextItemId,
      "multi",
    );
    const nextPrimaryId = nextSelectedIds.at(-1) ?? null;
    const nextItem = optionById(options, nextPrimaryId);

    setSelectedBitwardenItemIds(nextSelectedIds);
    setSelectedBitwardenItemId(nextPrimaryId);
    setSelectedBitwardenFieldId(null);
    setSelectedBitwardenFieldIds([]);
    setBitwardenDraft((current) => ({
      ...current,
      item: nextItem?.label ?? "",
      itemId: nextItem?.id ?? "",
      field: "",
    }));
    if (nextItem) {
      suggestDisplayName(nextItem.label);
    }
  }

  function toggleBitwardenField(nextFieldId: string): void {
    const selectionMode =
      selectedBitwardenItemIds.length > 1 ? "single" : "multi";
    const nextSelectedIds = toggleSelection(
      selectedBitwardenFieldIds,
      nextFieldId,
      selectionMode,
    );
    const nextPrimaryId = nextSelectedIds.at(0) ?? null;
    const nextField =
      bitwardenFields.find((field) => fieldOptionId(field) === nextPrimaryId) ??
      null;

    setSelectedBitwardenFieldIds(nextSelectedIds);
    setSelectedBitwardenFieldId(nextPrimaryId);
    setBitwardenDraft((current) => ({
      ...current,
      field: nextField?.selector ?? "",
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
    setSelectedDotenvKeys([]);
    setDotenvKeyQuery("");
    setDotenvDraft((current) => ({
      ...current,
      namespace: nextGroup?.namespace ?? "",
      prefix: nextGroup?.prefix ?? "",
      key: "",
    }));
  }

  function toggleDotenvKey(option: DotenvKeyOption): void {
    const nextSelectedIds = toggleSelection(
      selectedDotenvKeys,
      dotenvKeySelectionId(option),
      "multi",
    );
    const nextPrimarySelectionId = nextSelectedIds.at(-1) ?? null;
    const nextPrimaryOption =
      (dotenvInspection?.keys ?? []).find(
        (entry) => dotenvKeySelectionId(entry) === nextPrimarySelectionId,
      ) ?? null;
    const nextKey =
      nextPrimaryOption &&
      selectedDotenvGroup?.prefix &&
      nextPrimaryOption.group_id !== "all"
        ? nextPrimaryOption.label
        : (nextPrimaryOption?.full_key ?? "");

    setSelectedDotenvKeys(nextSelectedIds);
    setSelectedDotenvKey(nextPrimarySelectionId);
    setDotenvDraft((current) => ({
      ...current,
      key: nextKey,
    }));
    if (nextKey) {
      suggestDisplayName(nextKey);
    }
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
      setSelectedDotenvKeys([]);
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
    void loadImportedCatalog();
  }, []);

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
          applyOnePasswordAccountSelection(accounts[0].id, accounts);
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
          applyOnePasswordVaultSelection(vaults[0].id, vaults);
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
          applyOnePasswordItemSelection(items[0].id, items);
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
      selectedOnePasswordItemIds.length === 0
    ) {
      return;
    }

    const missingItemIds = selectedOnePasswordItemIds.filter(
      (itemId) => !hasCachedFieldOptions(onePasswordFieldsByItemId, itemId),
    );
    if (missingItemIds.length === 0) {
      return;
    }

    let active = true;
    setIsOnePasswordFieldsLoading(true);
    void Promise.all(
      missingItemIds.map(async (itemId) => ({
        itemId,
        fields: await invoke<ImportFieldOption[]>(
          "list_onepassword_fields_command",
          {
            accountId: selectedOnePasswordAccountId,
            vaultId: selectedOnePasswordVaultId,
            itemId,
          },
        ),
      })),
    )
      .then((results) => {
        if (!active) {
          return;
        }
        setOnePasswordFieldsByItemId((current) => {
          const next = { ...current };
          for (const { itemId, fields } of results) {
            next[itemId] = fields;
          }
          return next;
        });
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
    selectedOnePasswordItemIds,
    onePasswordFieldsByItemId,
  ]);

  useEffect(() => {
    if (
      providerKind !== "1password_cli" ||
      !selectedOnePasswordItemId ||
      selectedOnePasswordItemIds.length !== 1 ||
      selectedOnePasswordFieldIds.length > 0
    ) {
      return;
    }

    const fields = onePasswordFieldsByItemId[selectedOnePasswordItemId] ?? [];
    if (fields.length === 1) {
      applyOnePasswordFieldSelection(fieldOptionId(fields[0]), fields);
    }
  }, [
    onePasswordFieldsByItemId,
    providerKind,
    selectedOnePasswordFieldIds.length,
    selectedOnePasswordItemId,
    selectedOnePasswordItemIds.length,
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
          applyBitwardenAccountSelection(accounts[0].id, accounts);
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
    setSelectedBitwardenItemIds([]);
    setSelectedBitwardenFieldId(null);
    setSelectedBitwardenFieldIds([]);
    setBitwardenFieldsByItemId({});

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
          applyBitwardenItemSelection(items[0].id, items);
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
    if (
      providerKind !== "bitwarden_cli" ||
      selectedBitwardenItemIds.length === 0
    ) {
      return;
    }

    const missingItemIds = selectedBitwardenItemIds.filter(
      (itemId) => !hasCachedFieldOptions(bitwardenFieldsByItemId, itemId),
    );
    if (missingItemIds.length === 0) {
      return;
    }

    let active = true;
    setIsBitwardenFieldsLoading(true);

    void Promise.all(
      missingItemIds.map(async (itemId) => ({
        itemId,
        fields: await invoke<ImportFieldOption[]>(
          "list_bitwarden_fields_command",
          {
            itemId,
          },
        ),
      })),
    )
      .then((results) => {
        if (!active) {
          return;
        }
        setBitwardenFieldsByItemId((current) => {
          const next = { ...current };
          for (const { itemId, fields } of results) {
            next[itemId] = fields;
          }
          return next;
        });
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
  }, [bitwardenFieldsByItemId, providerKind, selectedBitwardenItemIds]);

  useEffect(() => {
    if (
      providerKind !== "bitwarden_cli" ||
      !selectedBitwardenItemId ||
      selectedBitwardenItemIds.length !== 1 ||
      selectedBitwardenFieldIds.length > 0
    ) {
      return;
    }

    const fields = bitwardenFieldsByItemId[selectedBitwardenItemId] ?? [];
    if (fields.length === 1) {
      toggleBitwardenField(fieldOptionId(fields[0]));
    }
  }, [
    bitwardenFieldsByItemId,
    providerKind,
    selectedBitwardenFieldIds.length,
    selectedBitwardenItemId,
    selectedBitwardenItemIds.length,
  ]);

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
    id: dotenvKeySelectionId(key),
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
            <span>
              {isBatchMode
                ? sectionCaption(
                    props.locale,
                    `${plannedSpecs.length} imports planned`,
                    `计划导入 ${plannedSpecs.length} 条`,
                  )
                : t(props.locale, "resourceId")}
            </span>
          </div>
          <p className="section-copy">
            {isBatchMode
              ? sectionCaption(
                  props.locale,
                  "Resource id and display name stay optional. Batch mode uses generated resource ids for each import.",
                  "资源标识和显示名都可留空；批量模式会为每条导入生成默认资源标识。",
                )
              : t(props.locale, "importDetailsHelp")}
          </p>
          <div className="settings-form-grid">
            <LocatorField
              dataTestId="password-field-resource"
              label={t(props.locale, "resourceId")}
              disabled={isBatchMode}
              hint={
                isBatchMode
                  ? sectionCaption(
                      props.locale,
                      "Manual resource ids are only available for single imports. Use the template below for batch imports.",
                      "手填资源标识仅用于单条导入；批量导入请使用下方模板。",
                    )
                  : sectionCaption(
                      props.locale,
                      "Leave empty to generate the default resource id automatically.",
                      "留空时自动生成默认资源标识。",
                    )
              }
              onChange={(value) => {
                setCommonDraft((current) => ({
                  ...current,
                  resource: value,
                }));
              }}
              optional
              optionalLabel={t(props.locale, "optional")}
              value={commonDraft.resource}
            />
            <LocatorField
              dataTestId="password-field-display-name"
              label={t(props.locale, "displayName")}
              disabled={isBatchMode}
              hint={
                isBatchMode
                  ? sectionCaption(
                      props.locale,
                      "Batch mode derives display names from each selected resource.",
                      "批量模式会按每个已选资源自动生成显示名。",
                    )
                  : undefined
              }
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
              <span className="field-label">
                {t(props.locale, "tags")}
                <span className="field-optional">
                  {" "}
                  · {t(props.locale, "optional")}
                </span>
              </span>
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
              <span className="field-hint">
                {sectionCaption(
                  props.locale,
                  "Optional. Applied to every generated import in batch mode.",
                  "可留空；批量模式下会应用到每条生成的导入记录。",
                )}
              </span>
            </label>
            <label
              className="settings-field settings-field-wide"
              data-testid="password-field-metadata"
            >
              <span className="field-label">
                {t(props.locale, "metadata")}
                <span className="field-optional">
                  {" "}
                  · {t(props.locale, "optional")}
                </span>
              </span>
              <textarea
                className="settings-input note-field"
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setCommonDraft((current) => ({
                    ...current,
                    metadata: nextValue,
                  }));
                }}
                placeholder={sectionCaption(
                  props.locale,
                  "team=backend\nowner=alice",
                  "team=backend\nowner=alice",
                )}
                value={commonDraft.metadata}
              />
              <span className="field-hint">
                {t(props.locale, "metadataFormatHelp")}
              </span>
            </label>
          </div>
        </section>

        <section
          className="detail-section"
          data-testid="password-template-section"
        >
          <div className="detail-section-header">
            <h3>
              {sectionCaption(props.locale, "Resource Template", "资源模板")}
            </h3>
            <span>
              {resourceTemplateMode === "default"
                ? sectionCaption(props.locale, "Default", "默认")
                : sectionCaption(props.locale, "Custom", "自定义")}
            </span>
          </div>
          <p className="section-copy">
            {sectionCaption(
              props.locale,
              "Default ids are generated from the current provider locator. Switch to a custom template only when you need a different path shape.",
              "默认资源标识会按当前 provider locator 自动生成；只有在需要不同路径规则时再切到自定义模板。",
            )}
          </p>
          <div
            className="provider-option-list"
            data-testid="password-template-mode-options"
          >
            <button
              aria-pressed={
                resourceTemplateMode === "default" ? "true" : "false"
              }
              className={`provider-option ${
                resourceTemplateMode === "default" ? "active" : ""
              }`}
              data-testid="password-template-mode-default"
              onClick={() => {
                setResourceTemplateMode("default");
              }}
              type="button"
            >
              <strong>
                {sectionCaption(props.locale, "Default Rule", "默认规则")}
              </strong>
              <p>{defaultResourceTemplateForProvider(providerKind)}</p>
            </button>
            <button
              aria-pressed={
                resourceTemplateMode === "custom" ? "true" : "false"
              }
              className={`provider-option ${
                resourceTemplateMode === "custom" ? "active" : ""
              }`}
              data-testid="password-template-mode-custom"
              onClick={() => {
                setResourceTemplateMode("custom");
              }}
              type="button"
            >
              <strong>
                {sectionCaption(props.locale, "Custom Template", "自定义模板")}
              </strong>
              <p>
                {sectionCaption(
                  props.locale,
                  "Use placeholders such as {{ item }} or {{ field }}",
                  "使用 {{ item }} / {{ field }} 等占位符",
                )}
              </p>
            </button>
          </div>
          {resourceTemplateMode === "custom" ? (
            <LocatorField
              dataTestId="password-field-resource-template"
              hint={sectionCaption(
                props.locale,
                `Supported placeholders: ${availableTemplateTokens(providerKind).join(", ")}`,
                `支持的占位符：${availableTemplateTokens(providerKind).join("、")}`,
              )}
              label={sectionCaption(props.locale, "Template", "模板")}
              onChange={setResourceTemplate}
              optionalLabel={t(props.locale, "optional")}
              value={resourceTemplate}
            />
          ) : null}
          <div
            className="detail-section detail-section-low"
            data-testid="password-template-preview"
          >
            <div className="detail-section-header">
              <h3>
                {sectionCaption(props.locale, "Import Preview", "导入预览")}
              </h3>
              <span>
                {sectionCaption(
                  props.locale,
                  `${plannedSpecs.length} target(s)`,
                  `${plannedSpecs.length} 个目标`,
                )}
              </span>
            </div>
            {planBlockerMessage ? (
              <p
                className="empty"
                data-testid="password-template-preview-blocker"
              >
                {planBlockerMessage}
              </p>
            ) : plannedSpecs.length === 0 ? (
              <p
                className="empty"
                data-testid="password-template-preview-empty"
              >
                {previewEmptyMessage}
              </p>
            ) : (
              <ol
                className="boundary-list"
                data-testid="password-template-preview-list"
              >
                {previewResources.slice(0, 6).map((resource) => (
                  <li key={resource}>
                    <code>{resource}</code>
                  </li>
                ))}
              </ol>
            )}
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

            <MultiPickerSection
              caption={sectionCaption(
                props.locale,
                `${selectedOnePasswordItemIds.length} selected`,
                `已选 ${selectedOnePasswordItemIds.length} 个`,
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
              helper={sectionCaption(
                props.locale,
                isOnePasswordMultiResourceMode
                  ? "All fields from the selected resources will be imported."
                  : "Single-resource mode supports selecting specific fields from the current resource.",
                isOnePasswordMultiResourceMode
                  ? "当前会导入所选资源的全部字段。"
                  : "单资源模式支持从当前资源中选择指定字段。",
              )}
              loading={isOnePasswordItemsLoading}
              onSearchQueryChange={setOnePasswordItemQuery}
              onToggleSelect={toggleOnePasswordItem}
              options={onePasswordItems}
              searchPlaceholder={searchPlaceholder(
                props.locale,
                t(props.locale, "item"),
              )}
              searchQuery={onePasswordItemQuery}
              selectedIds={selectedOnePasswordItemIds}
              title={t(props.locale, "item")}
            />

            {!isOnePasswordMultiResourceMode ? (
              <MultiPickerSection
                caption={sectionCaption(
                  props.locale,
                  `${selectedOnePasswordFieldIds.length} selected`,
                  `已选 ${selectedOnePasswordFieldIds.length} 个`,
                )}
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
                helper={sectionCaption(
                  props.locale,
                  "Single-resource mode supports selecting multiple fields from the same resource.",
                  "单资源模式支持对同一个资源多选字段。",
                )}
                loading={isOnePasswordFieldsLoading}
                onToggleSelect={toggleOnePasswordField}
                options={onePasswordFieldOptions}
                selectedIds={selectedOnePasswordFieldIds}
                title={t(props.locale, "field")}
              />
            ) : null}

            {!isOnePasswordMultiResourceMode &&
            selectedOnePasswordItemId &&
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

            <MultiPickerSection
              caption={sectionCaption(
                props.locale,
                `${selectedBitwardenItemIds.length} selected`,
                `已选 ${selectedBitwardenItemIds.length} 个`,
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
              helper={sectionCaption(
                props.locale,
                isBitwardenMultiResourceMode
                  ? "All fields from the selected resources will be imported."
                  : "Single-resource mode supports selecting specific fields from the current resource.",
                isBitwardenMultiResourceMode
                  ? "当前会导入所选资源的全部字段。"
                  : "单资源模式支持从当前资源中选择指定字段。",
              )}
              loading={isBitwardenItemsLoading}
              onSearchQueryChange={setBitwardenItemQuery}
              onToggleSelect={toggleBitwardenItem}
              options={bitwardenItems}
              searchPlaceholder={searchPlaceholder(
                props.locale,
                t(props.locale, "item"),
              )}
              searchQuery={bitwardenItemQuery}
              selectedIds={selectedBitwardenItemIds}
              title={t(props.locale, "item")}
            />

            {!isBitwardenMultiResourceMode ? (
              <>
                <MultiPickerSection
                  caption={sectionCaption(
                    props.locale,
                    `${selectedBitwardenFieldIds.length} selected`,
                    `已选 ${selectedBitwardenFieldIds.length} 个`,
                  )}
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
                  helper={sectionCaption(
                    props.locale,
                    "Single-resource mode supports selecting multiple fields from the same resource.",
                    "单资源模式支持对同一个资源多选字段。",
                  )}
                  loading={isBitwardenFieldsLoading}
                  onToggleSelect={toggleBitwardenField}
                  options={bitwardenFieldOptions}
                  selectedIds={selectedBitwardenFieldIds}
                  title={t(props.locale, "field")}
                />

                <section
                  className="detail-section detail-section-low"
                  data-testid="bitwarden-field-fallback"
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

            <MultiPickerSection
              caption={sectionCaption(
                props.locale,
                `${selectedDotenvKeys.length} selected`,
                `已选 ${selectedDotenvKeys.length} 个`,
              )}
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
              helper={sectionCaption(
                props.locale,
                "Keys can be multi-selected. The UI still shows only key names and never renders values.",
                "支持多选 key；UI 仍然只展示 key 名，不展示 value。",
              )}
              loading={isDotenvInspecting}
              onSearchQueryChange={setDotenvKeyQuery}
              onToggleSelect={(nextKey) => {
                const option =
                  (dotenvInspection?.keys ?? []).find(
                    (entry) => dotenvKeySelectionId(entry) === nextKey,
                  ) ?? null;
                if (option) {
                  toggleDotenvKey(option);
                }
              }}
              options={dotenvKeyOptions}
              searchPlaceholder={searchPlaceholder(
                props.locale,
                t(props.locale, "key"),
              )}
              searchQuery={dotenvKeyQuery}
              selectedIds={selectedDotenvKeys}
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
        {planBlockerMessage ? (
          <p className="empty" data-testid="password-import-blocker">
            {planBlockerMessage}
          </p>
        ) : null}
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
            : isBatchMode
              ? sectionCaption(props.locale, "Import Selected", "导入所选项")
              : t(props.locale, "importSource")}
        </button>
      </div>

      {importedReceipts.length > 0 ? (
        <section
          className="detail-section detail-section-wide"
          data-testid="password-import-receipt"
        >
          <div className="detail-section-header">
            <h3>{t(props.locale, "importReceiptTitle")}</h3>
            <span>
              {sectionCaption(
                props.locale,
                `${importedReceipts.length} receipt(s)`,
                `${importedReceipts.length} 条回执`,
              )}
            </span>
          </div>
          {importedReceipts.length > 1 ? (
            <ol
              className="boundary-list"
              data-testid="password-import-receipt-list"
            >
              {importedReceipts.map((entry) => (
                <li key={entry.reference.resource}>
                  <code>{entry.reference.resource}</code>
                </li>
              ))}
            </ol>
          ) : null}
          <dl className="facts">
            <div data-testid="password-receipt-resource">
              <dt>{t(props.locale, "importedResource")}</dt>
              <dd>{importedReceipts[0].reference.resource}</dd>
            </div>
            <div data-testid="password-receipt-catalog-path">
              <dt>{t(props.locale, "catalogPath")}</dt>
              <dd>{importedReceipts[0].catalog_path}</dd>
            </div>
            <div data-testid="password-receipt-container">
              <dt>{t(props.locale, "importedContainer")}</dt>
              <dd>
                {getImportedContainerLabel(importedReceipts[0].reference) ??
                  t(props.locale, "notAvailable")}
              </dd>
            </div>
            <div data-testid="password-receipt-field">
              <dt>{t(props.locale, "importedField")}</dt>
              <dd>{getImportedFieldSelector(importedReceipts[0].reference)}</dd>
            </div>
            <div data-testid="password-receipt-imported-at">
              <dt>{t(props.locale, "importedAt")}</dt>
              <dd>
                {formatTimestamp(
                  importedReceipts[0].reference.imported_at,
                  t(props.locale, "notAvailable"),
                  props.locale,
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : null}

      <ImportedSecretCatalogPanel
        catalog={importedCatalog}
        errorMessage={catalogErrorMessage}
        isLoading={isCatalogLoading}
        locale={props.locale}
        noticeMessage={catalogNoticeMessage}
        onDelete={deleteImportedSecret}
        onReload={loadImportedCatalog}
        onSave={saveImportedSecret}
      />
    </section>
  );
}
