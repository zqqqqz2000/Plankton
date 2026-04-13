import { invoke } from "@tauri-apps/api/core";
import { useState, type JSX } from "react";

import { formatTimestamp } from "../formatters";
import { t, translateCode, type Locale } from "../i18n";
import type {
  BitwardenCliLocator,
  DotenvFileLocator,
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

type LocatorFieldProps = {
  dataTestId: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  optionalLabel: string;
  optional?: boolean;
  type?: "text";
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
        type={props.type ?? "text"}
        value={props.value}
      />
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const selectedProvider = PROVIDER_OPTIONS.find(
    (option) => option.kind === providerKind,
  );
  const canSubmit = canSubmitImport(
    providerKind,
    commonDraft,
    onePasswordDraft,
    bitwardenDraft,
    dotenvDraft,
  );

  async function submitImport(): Promise<void> {
    setIsSubmitting(true);
    setErrorMessage(null);
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
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

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

      {errorMessage ? (
        <section
          className="alert"
          data-testid="password-import-error-banner"
          role="alert"
        >
          <p data-testid="password-import-error-message">{errorMessage}</p>
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
                  setProviderKind(option.kind);
                  setErrorMessage(null);
                  setNoticeMessage(null);
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

        <section
          className="detail-section"
          data-testid="password-locator-section"
        >
          <div className="detail-section-header">
            <h3>{t(props.locale, "importProviderConfigTitle")}</h3>
            <span>{translateCode(props.locale, providerKind)}</span>
          </div>
          <p className="section-copy">
            {t(props.locale, "importProviderConfigHelp")}
          </p>
          <div className="settings-form-grid">
            {providerKind === "1password_cli" ? (
              <>
                <LocatorField
                  dataTestId="password-field-1password-account"
                  label={t(props.locale, "account")}
                  onChange={(value) => {
                    setOnePasswordDraft((current) => ({
                      ...current,
                      account: value,
                    }));
                  }}
                  optionalLabel={t(props.locale, "optional")}
                  value={onePasswordDraft.account}
                />
                <LocatorField
                  dataTestId="password-field-1password-vault"
                  label={t(props.locale, "vault")}
                  onChange={(value) => {
                    setOnePasswordDraft((current) => ({
                      ...current,
                      vault: value,
                    }));
                  }}
                  optionalLabel={t(props.locale, "optional")}
                  value={onePasswordDraft.vault}
                />
                <LocatorField
                  dataTestId="password-field-1password-item"
                  label={t(props.locale, "item")}
                  onChange={(value) => {
                    setOnePasswordDraft((current) => ({
                      ...current,
                      item: value,
                    }));
                  }}
                  optionalLabel={t(props.locale, "optional")}
                  value={onePasswordDraft.item}
                />
                <LocatorField
                  dataTestId="password-field-1password-field"
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
                <LocatorField
                  dataTestId="password-field-1password-vault-id"
                  label={t(props.locale, "vaultId")}
                  onChange={(value) => {
                    setOnePasswordDraft((current) => ({
                      ...current,
                      vaultId: value,
                    }));
                  }}
                  optional
                  optionalLabel={t(props.locale, "optional")}
                  value={onePasswordDraft.vaultId}
                />
                <LocatorField
                  dataTestId="password-field-1password-item-id"
                  label={t(props.locale, "itemId")}
                  onChange={(value) => {
                    setOnePasswordDraft((current) => ({
                      ...current,
                      itemId: value,
                    }));
                  }}
                  optional
                  optionalLabel={t(props.locale, "optional")}
                  value={onePasswordDraft.itemId}
                />
                <LocatorField
                  dataTestId="password-field-1password-field-id"
                  label={t(props.locale, "fieldId")}
                  onChange={(value) => {
                    setOnePasswordDraft((current) => ({
                      ...current,
                      fieldId: value,
                    }));
                  }}
                  optional
                  optionalLabel={t(props.locale, "optional")}
                  value={onePasswordDraft.fieldId}
                />
              </>
            ) : null}

            {providerKind === "bitwarden_cli" ? (
              <>
                <LocatorField
                  dataTestId="password-field-bitwarden-account"
                  label={t(props.locale, "account")}
                  onChange={(value) => {
                    setBitwardenDraft((current) => ({
                      ...current,
                      account: value,
                    }));
                  }}
                  optionalLabel={t(props.locale, "optional")}
                  value={bitwardenDraft.account}
                />
                <LocatorField
                  dataTestId="password-field-bitwarden-organization"
                  label={t(props.locale, "organization")}
                  onChange={(value) => {
                    setBitwardenDraft((current) => ({
                      ...current,
                      organization: value,
                    }));
                  }}
                  optional
                  optionalLabel={t(props.locale, "optional")}
                  value={bitwardenDraft.organization}
                />
                <LocatorField
                  dataTestId="password-field-bitwarden-collection"
                  label={t(props.locale, "collection")}
                  onChange={(value) => {
                    setBitwardenDraft((current) => ({
                      ...current,
                      collection: value,
                    }));
                  }}
                  optional
                  optionalLabel={t(props.locale, "optional")}
                  value={bitwardenDraft.collection}
                />
                <LocatorField
                  dataTestId="password-field-bitwarden-folder"
                  label={t(props.locale, "folder")}
                  onChange={(value) => {
                    setBitwardenDraft((current) => ({
                      ...current,
                      folder: value,
                    }));
                  }}
                  optional
                  optionalLabel={t(props.locale, "optional")}
                  value={bitwardenDraft.folder}
                />
                <LocatorField
                  dataTestId="password-field-bitwarden-item"
                  label={t(props.locale, "item")}
                  onChange={(value) => {
                    setBitwardenDraft((current) => ({
                      ...current,
                      item: value,
                    }));
                  }}
                  optionalLabel={t(props.locale, "optional")}
                  value={bitwardenDraft.item}
                />
                <LocatorField
                  dataTestId="password-field-bitwarden-field"
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
                <LocatorField
                  dataTestId="password-field-bitwarden-item-id"
                  label={t(props.locale, "itemId")}
                  onChange={(value) => {
                    setBitwardenDraft((current) => ({
                      ...current,
                      itemId: value,
                    }));
                  }}
                  optional
                  optionalLabel={t(props.locale, "optional")}
                  value={bitwardenDraft.itemId}
                />
              </>
            ) : null}

            {providerKind === "dotenv_file" ? (
              <>
                <LocatorField
                  dataTestId="password-field-dotenv-file"
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
                <LocatorField
                  dataTestId="password-field-dotenv-namespace"
                  label={t(props.locale, "namespace")}
                  onChange={(value) => {
                    setDotenvDraft((current) => ({
                      ...current,
                      namespace: value,
                    }));
                  }}
                  optional
                  optionalLabel={t(props.locale, "optional")}
                  value={dotenvDraft.namespace}
                />
                <LocatorField
                  dataTestId="password-field-dotenv-prefix"
                  label={t(props.locale, "prefix")}
                  onChange={(value) => {
                    setDotenvDraft((current) => ({
                      ...current,
                      prefix: value,
                    }));
                  }}
                  optional
                  optionalLabel={t(props.locale, "optional")}
                  value={dotenvDraft.prefix}
                />
                <LocatorField
                  dataTestId="password-field-dotenv-key"
                  label={t(props.locale, "key")}
                  onChange={(value) => {
                    setDotenvDraft((current) => ({
                      ...current,
                      key: value,
                    }));
                  }}
                  optionalLabel={t(props.locale, "optional")}
                  value={dotenvDraft.key}
                />
              </>
            ) : null}
          </div>
        </section>

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
