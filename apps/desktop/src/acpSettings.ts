import type { DesktopSettings } from "./types";

export const ACP_DEFAULT_PROGRAM = "npx";
export const ACP_DEFAULT_ARGS = "-y @zed-industries/codex-acp@0.11.1";

type AcpSettingsInput = Pick<
  DesktopSettings,
  "acp_codex_program" | "acp_codex_args"
>;

export type AcpProgramSummary = {
  defaultCommand: string;
  currentProgram: string;
  currentArgs: string;
  currentCommand: string;
  usesDefaultStarter: boolean;
};

function formatCommand(program: string, args: string): string {
  return `${program}${args ? ` ${args}` : ""}`;
}

export function buildAcpProgramSummary(
  settings: AcpSettingsInput | null,
): AcpProgramSummary {
  const currentProgram =
    settings?.acp_codex_program.trim() || ACP_DEFAULT_PROGRAM;
  const currentArgs = settings?.acp_codex_args.trim() || ACP_DEFAULT_ARGS;

  return {
    defaultCommand: formatCommand(ACP_DEFAULT_PROGRAM, ACP_DEFAULT_ARGS),
    currentProgram,
    currentArgs,
    currentCommand: formatCommand(currentProgram, currentArgs),
    usesDefaultStarter:
      currentProgram === ACP_DEFAULT_PROGRAM &&
      currentArgs === ACP_DEFAULT_ARGS,
  };
}
