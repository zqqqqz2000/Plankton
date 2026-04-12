import { describe, expect, it } from "vitest";

import {
  ACP_DEFAULT_ARGS,
  ACP_DEFAULT_PROGRAM,
  buildAcpProgramSummary,
} from "./acpSettings";

describe("acpSettings", () => {
  it("reports the default Codex starter when ACP settings match defaults", () => {
    const summary = buildAcpProgramSummary({
      acp_codex_program: ACP_DEFAULT_PROGRAM,
      acp_codex_args: ACP_DEFAULT_ARGS,
    });

    expect(summary.usesDefaultStarter).toBe(true);
    expect(summary.currentCommand).toBe(
      "npx -y @zed-industries/codex-acp@0.11.1",
    );
  });

  it("reports a custom ACP client when the program or args differ", () => {
    const summary = buildAcpProgramSummary({
      acp_codex_program: "uvx",
      acp_codex_args: "my-acp-client --stdio",
    });

    expect(summary.usesDefaultStarter).toBe(false);
    expect(summary.currentProgram).toBe("uvx");
    expect(summary.currentArgs).toBe("my-acp-client --stdio");
    expect(summary.currentCommand).toBe("uvx my-acp-client --stdio");
  });

  it("falls back to the default starter when settings are blank", () => {
    const summary = buildAcpProgramSummary({
      acp_codex_program: "   ",
      acp_codex_args: "",
    });

    expect(summary.usesDefaultStarter).toBe(true);
    expect(summary.currentProgram).toBe(ACP_DEFAULT_PROGRAM);
    expect(summary.currentArgs).toBe(ACP_DEFAULT_ARGS);
  });
});
