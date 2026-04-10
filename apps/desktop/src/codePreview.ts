import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import dos from "highlight.js/lib/languages/dos";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";

import { escapeHtml } from "./dashboardModel";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("dos", dos);
hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("python", python);

const EXTENSION_LANGUAGE_MAP = {
  bash: {
    language: "bash",
    label: "bash",
  },
  bat: {
    language: "dos",
    label: "bat",
  },
  cmd: {
    language: "dos",
    label: "cmd",
  },
  fish: {
    language: "bash",
    label: "fish",
  },
  ps1: {
    language: "powershell",
    label: "ps1",
  },
  py: {
    language: "python",
    label: "py",
  },
  sh: {
    language: "bash",
    label: "sh",
  },
  zsh: {
    language: "bash",
    label: "zsh",
  },
} as const;

type SupportedExtension = keyof typeof EXTENSION_LANGUAGE_MAP;

export type PreviewHighlightResult = {
  highlighted: boolean;
  html: string;
  label: string;
};

export function getSupportedPreviewExtensions(): string[] {
  return Object.keys(EXTENSION_LANGUAGE_MAP).sort();
}

function getPathExtension(path: string | null): string | null {
  if (!path) {
    return null;
  }

  const normalizedPath = path.trim().toLowerCase();
  if (!normalizedPath) {
    return null;
  }

  const basename = normalizedPath.split(/[\\/]/).at(-1) ?? normalizedPath;
  const extension = basename.split(".").at(-1);

  if (!extension || extension === basename) {
    return null;
  }

  return extension;
}

export function getPreviewHighlightResult(
  path: string | null,
  previewText: string,
): PreviewHighlightResult {
  const extension = getPathExtension(path);
  const mapping =
    extension && extension in EXTENSION_LANGUAGE_MAP
      ? EXTENSION_LANGUAGE_MAP[extension as SupportedExtension]
      : null;

  if (!mapping) {
    return {
      highlighted: false,
      html: escapeHtml(previewText),
      label: "plain text",
    };
  }

  try {
    return {
      highlighted: true,
      html: hljs.highlight(previewText, {
        language: mapping.language,
        ignoreIllegals: true,
      }).value,
      label: mapping.label,
    };
  } catch {
    return {
      highlighted: false,
      html: escapeHtml(previewText),
      label: "plain text",
    };
  }
}
