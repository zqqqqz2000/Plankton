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

type HighlightMapping = {
  language: string;
  label: string;
};

export type PreviewHighlightResult = {
  highlighted: boolean;
  html: string;
  label: string;
};

export function getSupportedPreviewExtensions(): string[] {
  return Object.keys(EXTENSION_LANGUAGE_MAP).sort();
}

function getInterpreterToken(candidate: string): string | null {
  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const basename = trimmed.split(/[\\/]/).at(-1) ?? trimmed;
  return basename || null;
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

function getMappingFromExtension(path: string | null): HighlightMapping | null {
  const extension = getPathExtension(path);
  if (!extension || !(extension in EXTENSION_LANGUAGE_MAP)) {
    return null;
  }

  return EXTENSION_LANGUAGE_MAP[extension as SupportedExtension];
}

function getMappingFromShebang(previewText: string): HighlightMapping | null {
  const firstLine = previewText.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine.startsWith("#!")) {
    return null;
  }

  const tokens = firstLine
    .slice(2)
    .trim()
    .split(/\s+/)
    .map(getInterpreterToken)
    .filter((value): value is string => Boolean(value));

  if (tokens.length === 0) {
    return null;
  }

  const envIndex = tokens.findIndex((token) => token === "env");
  const interpreter =
    envIndex >= 0
      ? tokens.slice(envIndex + 1).find((token) => token !== "-s")
      : tokens[0];

  switch (interpreter) {
    case "bash":
    case "sh":
    case "zsh":
    case "fish":
      return {
        language: "bash",
        label: interpreter,
      };
    case "python":
    case "python3":
    case "pythonw":
      return {
        language: "python",
        label: "python",
      };
    case "pwsh":
    case "powershell":
    case "powershell.exe":
    case "pwsh.exe":
      return {
        language: "powershell",
        label: "powershell",
      };
    case "cmd":
    case "cmd.exe":
      return {
        language: "dos",
        label: "cmd",
      };
    default:
      return null;
  }
}

export function getPreviewHighlightResult(
  path: string | null,
  previewText: string,
): PreviewHighlightResult {
  const mapping =
    getMappingFromExtension(path) ?? getMappingFromShebang(previewText);

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
