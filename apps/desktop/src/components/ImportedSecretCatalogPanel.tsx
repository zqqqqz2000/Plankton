import { useEffect, useMemo, useState, type JSX } from "react";

import { formatTimestamp } from "../formatters";
import { t, translateCode, type Locale } from "../i18n";
import type {
  ImportedSecretCatalog,
  ImportedSecretReference,
  ImportedSecretReferenceUpdate,
} from "../types";

type ImportedSecretCatalogPanelProps = {
  catalog: ImportedSecretCatalog | null;
  errorMessage: string | null;
  isLoading: boolean;
  locale: Locale;
  noticeMessage: string | null;
  onDelete: (resource: string) => Promise<void>;
  onReload: (options?: { silent?: boolean }) => Promise<void>;
  onSave: (update: ImportedSecretReferenceUpdate) => Promise<void>;
};

type ImportedSecretTreeNode = {
  id: string;
  label: string;
  resource: string | null;
  reference: ImportedSecretReference | null;
  leafCount: number;
  children: ImportedSecretTreeNode[];
};

type EditorDraft = {
  displayName: string;
  description: string;
  tags: string;
  metadata: string;
};

const EMPTY_EDITOR_DRAFT: EditorDraft = {
  displayName: "",
  description: "",
  tags: "",
  metadata: "",
};

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

function formatMetadataDraft(
  metadata: Record<string, string> | undefined,
): string {
  return Object.entries(metadata ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function buildEditorDraft(reference: ImportedSecretReference): EditorDraft {
  return {
    displayName: reference.display_name,
    description: reference.description ?? "",
    tags: reference.tags.join(", "),
    metadata: formatMetadataDraft(reference.metadata),
  };
}

function buildImportedSecretTree(
  imports: ImportedSecretReference[],
): ImportedSecretTreeNode[] {
  type MutableNode = {
    id: string;
    label: string;
    resource: string | null;
    reference: ImportedSecretReference | null;
    leafCount: number;
    children: Map<string, MutableNode>;
  };

  const root = new Map<string, MutableNode>();

  for (const reference of imports) {
    const segments = reference.resource.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";

    for (const [index, segment] of segments.entries()) {
      currentPath =
        currentPath.length > 0 ? `${currentPath}/${segment}` : segment;
      let node = current.get(segment);
      if (!node) {
        node = {
          id: currentPath,
          label: segment,
          resource: null,
          reference: null,
          leafCount: 0,
          children: new Map(),
        };
        current.set(segment, node);
      }

      node.leafCount += 1;
      if (index === segments.length - 1) {
        node.resource = reference.resource;
        node.reference = reference;
      } else {
        current = node.children;
      }
    }
  }

  function materialize(
    nodes: Map<string, MutableNode>,
  ): ImportedSecretTreeNode[] {
    return Array.from(nodes.values())
      .sort((left, right) => left.label.localeCompare(right.label))
      .map((node) => ({
        id: node.id,
        label: node.label,
        resource: node.reference?.resource ?? node.resource,
        reference: node.reference,
        leafCount: node.leafCount,
        children: materialize(node.children),
      }));
  }

  return materialize(root);
}

function getSearchText(reference: ImportedSecretReference): string {
  const parts = [
    reference.resource,
    reference.display_name,
    reference.description ?? "",
    ...(reference.tags ?? []),
    ...Object.entries(reference.metadata ?? {}).flatMap(([key, value]) => [
      key,
      value,
      `${key}=${value}`,
    ]),
  ];

  if (reference.provider_kind === "1password_cli") {
    parts.push(
      reference.account,
      reference.vault,
      reference.item,
      reference.field,
      reference.account_id ?? "",
      reference.vault_id ?? "",
      reference.item_id ?? "",
      reference.field_id ?? "",
    );
  } else if (reference.provider_kind === "bitwarden_cli") {
    parts.push(
      reference.account,
      reference.organization ?? "",
      reference.collection ?? "",
      reference.folder ?? "",
      reference.item,
      reference.field,
      reference.item_id ?? "",
    );
  } else {
    parts.push(
      reference.file_path,
      reference.namespace ?? "",
      reference.prefix ?? "",
      reference.key,
    );
  }

  return parts.join("\n").toLowerCase();
}

function matchesSearch(
  reference: ImportedSecretReference,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return true;
  }

  return getSearchText(reference).includes(normalizedQuery);
}

function getLocatorEntries(
  locale: Locale,
  reference: ImportedSecretReference,
): Array<{ label: string; value: string }> {
  if (reference.provider_kind === "1password_cli") {
    return [
      { label: t(locale, "account"), value: reference.account },
      { label: t(locale, "vault"), value: reference.vault },
      { label: t(locale, "item"), value: reference.item },
      { label: t(locale, "field"), value: reference.field },
      ...(reference.account_id
        ? [{ label: t(locale, "accountId"), value: reference.account_id }]
        : []),
      ...(reference.vault_id
        ? [{ label: t(locale, "vaultId"), value: reference.vault_id }]
        : []),
      ...(reference.item_id
        ? [{ label: t(locale, "itemId"), value: reference.item_id }]
        : []),
      ...(reference.field_id
        ? [{ label: t(locale, "fieldId"), value: reference.field_id }]
        : []),
    ];
  }

  if (reference.provider_kind === "bitwarden_cli") {
    return [
      { label: t(locale, "account"), value: reference.account },
      ...(reference.organization
        ? [{ label: t(locale, "organization"), value: reference.organization }]
        : []),
      ...(reference.collection
        ? [{ label: t(locale, "collection"), value: reference.collection }]
        : []),
      ...(reference.folder
        ? [{ label: t(locale, "folder"), value: reference.folder }]
        : []),
      { label: t(locale, "item"), value: reference.item },
      { label: t(locale, "field"), value: reference.field },
      ...(reference.item_id
        ? [{ label: t(locale, "itemId"), value: reference.item_id }]
        : []),
    ];
  }

  return [
    { label: t(locale, "filePath"), value: reference.file_path },
    ...(reference.namespace
      ? [{ label: t(locale, "namespace"), value: reference.namespace }]
      : []),
    ...(reference.prefix
      ? [{ label: t(locale, "prefix"), value: reference.prefix }]
      : []),
    { label: t(locale, "key"), value: reference.key },
  ];
}

function hasDraftChanges(
  reference: ImportedSecretReference,
  draft: EditorDraft,
  metadata: Record<string, string>,
): boolean {
  const normalizedTags = parseTags(draft.tags);
  const currentTags = reference.tags ?? [];
  const currentMetadata = reference.metadata ?? {};

  if (reference.display_name !== draft.displayName.trim()) {
    return true;
  }

  if ((reference.description ?? "") !== draft.description.trim()) {
    return true;
  }

  if (normalizedTags.join("\n") !== currentTags.join("\n")) {
    return true;
  }

  const leftMetadata = JSON.stringify(
    Object.entries(metadata).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const rightMetadata = JSON.stringify(
    Object.entries(currentMetadata).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );

  return leftMetadata !== rightMetadata;
}

function TreeBranch(props: {
  locale: Locale;
  nodes: ImportedSecretTreeNode[];
  selectedResource: string | null;
  onSelect: (resource: string) => void;
}): JSX.Element {
  return (
    <ol className="imported-tree-list">
      {props.nodes.map((node) => (
        <li className="imported-tree-node" key={node.id}>
          {node.reference ? (
            <button
              className={`queue-item imported-tree-leaf ${
                props.selectedResource === node.reference.resource
                  ? "active"
                  : ""
              }`}
              data-resource={node.reference.resource}
              data-testid="imported-secret-tree-leaf"
              onClick={() => {
                props.onSelect(node.reference!.resource);
              }}
              type="button"
            >
              <div className="queue-item-header">
                <strong>{node.label}</strong>
                <span>
                  {translateCode(props.locale, node.reference.provider_kind)}
                </span>
              </div>
              <div className="queue-item-meta">
                <span>{node.reference.display_name}</span>
                <span>{node.reference.tags.length} tag(s)</span>
              </div>
            </button>
          ) : (
            <>
              <div className="imported-tree-branch">
                <strong>{node.label}</strong>
                <span>{node.leafCount}</span>
              </div>
              {node.children.length > 0 ? (
                <TreeBranch
                  locale={props.locale}
                  nodes={node.children}
                  onSelect={props.onSelect}
                  selectedResource={props.selectedResource}
                />
              ) : null}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

export function ImportedSecretCatalogPanel(
  props: ImportedSecretCatalogPanelProps,
): JSX.Element {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditorDraft>(EMPTY_EDITOR_DRAFT);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const imports = props.catalog?.imports ?? [];
  const filteredImports = useMemo(
    () => imports.filter((reference) => matchesSearch(reference, searchQuery)),
    [imports, searchQuery],
  );
  const tree = useMemo(
    () => buildImportedSecretTree(filteredImports),
    [filteredImports],
  );
  const selectedReference =
    imports.find((reference) => reference.resource === selectedResource) ??
    null;
  const metadataDraft = parseMetadataDraft(draft.metadata);

  useEffect(() => {
    if (
      selectedResource &&
      imports.some((reference) => reference.resource === selectedResource)
    ) {
      return;
    }

    setSelectedResource(imports[0]?.resource ?? null);
  }, [imports, selectedResource]);

  useEffect(() => {
    if (!selectedReference) {
      setDraft(EMPTY_EDITOR_DRAFT);
      return;
    }

    setDraft(buildEditorDraft(selectedReference));
  }, [selectedReference]);

  async function handleSave(): Promise<void> {
    if (!selectedReference || metadataDraft.invalidLines.length > 0) {
      return;
    }

    setIsSaving(true);
    try {
      await props.onSave({
        resource: selectedReference.resource,
        display_name: draft.displayName.trim(),
        description: draft.description.trim(),
        tags: parseTags(draft.tags),
        metadata: metadataDraft.metadata,
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!selectedReference) {
      return;
    }

    const confirmed = window.confirm(
      t(props.locale, "deleteImportConfirm", {
        resource: selectedReference.resource,
      }),
    );
    if (!confirmed) {
      return;
    }

    setIsDeleting(true);
    try {
      await props.onDelete(selectedReference.resource);
    } finally {
      setIsDeleting(false);
    }
  }

  const canSave =
    Boolean(selectedReference) &&
    metadataDraft.invalidLines.length === 0 &&
    hasDraftChanges(selectedReference!, draft, metadataDraft.metadata) &&
    !isSaving &&
    !isDeleting;

  return (
    <section
      className="detail-section detail-section-wide"
      data-testid="imported-secret-catalog-panel"
    >
      <div className="detail-section-header">
        <h3>{t(props.locale, "importedCatalogTitle")}</h3>
        <span>
          {props.catalog?.catalog_path ?? t(props.locale, "notAvailable")}
        </span>
      </div>
      <p className="section-copy">{t(props.locale, "importedCatalogHelp")}</p>

      {props.errorMessage ? (
        <section
          className="alert"
          data-testid="imported-secret-catalog-error"
          role="alert"
        >
          <p>{props.errorMessage}</p>
        </section>
      ) : null}

      {props.noticeMessage ? (
        <section className="alert" data-testid="imported-secret-catalog-notice">
          <p>{props.noticeMessage}</p>
        </section>
      ) : null}

      <div className="password-actions">
        <input
          className="settings-input imported-search-input"
          data-testid="imported-secret-search"
          onChange={(event) => {
            setSearchQuery(event.currentTarget.value);
          }}
          placeholder={t(props.locale, "importedCatalogSearchPlaceholder")}
          type="search"
          value={searchQuery}
        />
        <button
          className="ghost"
          disabled={props.isLoading}
          onClick={() => {
            void props.onReload();
          }}
          type="button"
        >
          {t(props.locale, "refresh")}
        </button>
      </div>

      <div className="imported-catalog-layout">
        <section
          className="detail-section"
          data-testid="imported-secret-tree-panel"
        >
          <div className="detail-section-header">
            <h3>{t(props.locale, "importedCatalogTreeTitle")}</h3>
            <span>
              {props.isLoading
                ? t(props.locale, "loadingQueue")
                : `${filteredImports.length}/${imports.length}`}
            </span>
          </div>

          {props.isLoading ? (
            <p className="empty" data-testid="imported-secret-tree-loading">
              {t(props.locale, "loadingQueue")}
            </p>
          ) : tree.length === 0 ? (
            <p className="empty" data-testid="imported-secret-tree-empty">
              {searchQuery.trim().length > 0
                ? t(props.locale, "importedCatalogSearchEmpty")
                : t(props.locale, "importedCatalogEmpty")}
            </p>
          ) : (
            <TreeBranch
              locale={props.locale}
              nodes={tree}
              onSelect={setSelectedResource}
              selectedResource={selectedResource}
            />
          )}
        </section>

        <section
          className="detail-section"
          data-testid="imported-secret-detail-panel"
        >
          <div className="detail-section-header">
            <h3>{t(props.locale, "importedCatalogDetailsTitle")}</h3>
            <span>
              {selectedReference
                ? translateCode(props.locale, selectedReference.provider_kind)
                : t(props.locale, "notAvailable")}
            </span>
          </div>

          {!selectedReference ? (
            <p className="empty">
              {t(props.locale, "importedCatalogSelectHint")}
            </p>
          ) : (
            <div className="panel-stack">
              <dl className="facts">
                <div>
                  <dt>{t(props.locale, "resourceId")}</dt>
                  <dd>{selectedReference.resource}</dd>
                </div>
                <div>
                  <dt>{t(props.locale, "displayName")}</dt>
                  <dd>{selectedReference.display_name}</dd>
                </div>
                <div>
                  <dt>{t(props.locale, "importedAt")}</dt>
                  <dd>
                    {formatTimestamp(
                      selectedReference.imported_at,
                      t(props.locale, "notAvailable"),
                      props.locale,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{t(props.locale, "lastVerifiedAt")}</dt>
                  <dd>
                    {formatTimestamp(
                      selectedReference.last_verified_at ?? null,
                      t(props.locale, "notAvailable"),
                      props.locale,
                    )}
                  </dd>
                </div>
              </dl>

              <div className="detail-section detail-section-low">
                <div className="detail-section-header">
                  <h3>{t(props.locale, "sourceLocatorValues")}</h3>
                  <span>
                    {translateCode(
                      props.locale,
                      selectedReference.provider_kind,
                    )}
                  </span>
                </div>
                <p className="section-copy">
                  {t(props.locale, "sourceLocatorReadonlyHelp")}
                </p>
                <dl className="facts">
                  {getLocatorEntries(props.locale, selectedReference).map(
                    (entry) => (
                      <div key={entry.label}>
                        <dt>{entry.label}</dt>
                        <dd>{entry.value}</dd>
                      </div>
                    ),
                  )}
                </dl>
              </div>

              <div className="settings-form-grid">
                <label
                  className="settings-field"
                  data-testid="imported-secret-display-name"
                >
                  <span className="field-label">
                    {t(props.locale, "displayName")}
                  </span>
                  <input
                    className="settings-input"
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        displayName: event.currentTarget.value,
                      }));
                    }}
                    type="text"
                    value={draft.displayName}
                  />
                </label>

                <label
                  className="settings-field"
                  data-testid="imported-secret-description"
                >
                  <span className="field-label">
                    {t(props.locale, "description")}
                  </span>
                  <input
                    className="settings-input"
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        description: event.currentTarget.value,
                      }));
                    }}
                    type="text"
                    value={draft.description}
                  />
                </label>

                <label
                  className="settings-field"
                  data-testid="imported-secret-tags"
                >
                  <span className="field-label">{t(props.locale, "tags")}</span>
                  <input
                    className="settings-input"
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        tags: event.currentTarget.value,
                      }));
                    }}
                    type="text"
                    value={draft.tags}
                  />
                </label>

                <label
                  className="settings-field settings-field-wide"
                  data-testid="imported-secret-metadata"
                >
                  <span className="field-label">
                    {t(props.locale, "metadata")}
                  </span>
                  <textarea
                    className="settings-input note-field"
                    onChange={(event) => {
                      setDraft((current) => ({
                        ...current,
                        metadata: event.currentTarget.value,
                      }));
                    }}
                    value={draft.metadata}
                  />
                  <span className="field-hint">
                    {metadataDraft.invalidLines.length > 0
                      ? `${t(props.locale, "metadataFormatHelp")} (${metadataDraft.invalidLines.join(", ")})`
                      : t(props.locale, "metadataFormatHelp")}
                  </span>
                </label>
              </div>

              {selectedReference.tags.length > 0 ? (
                <div className="imported-tag-list">
                  {selectedReference.tags.map((tag) => (
                    <span className="id-pill" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="actions">
                <button
                  className="primary"
                  data-testid="imported-secret-save"
                  disabled={!canSave}
                  onClick={() => {
                    void handleSave();
                  }}
                  type="button"
                >
                  {isSaving
                    ? t(props.locale, "saving")
                    : t(props.locale, "save")}
                </button>
                <button
                  className="danger"
                  data-testid="imported-secret-delete"
                  disabled={isSaving || isDeleting}
                  onClick={() => {
                    void handleDelete();
                  }}
                  type="button"
                >
                  {isDeleting
                    ? t(props.locale, "deletingImport")
                    : t(props.locale, "deleteImport")}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
