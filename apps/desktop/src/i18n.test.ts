import { describe, expect, it } from "vitest";

import { t, translateCode } from "./i18n";

describe("i18n", () => {
  it("keeps default UI copy in English", () => {
    expect(t("en", "toolbarTitle")).toBe("Approvals");
  });

  it("renders interpolated UI strings", () => {
    expect(t("zh-CN", "openCount", { count: 3 })).toBe("3 个待处理");
  });

  it("productizes manual_only for external UI labels", () => {
    expect(translateCode("en", "manual_only")).toBe("Human Review");
    expect(translateCode("zh-CN", "manual_only")).toBe("人工审批");
  });
});
