[English](./README.md) | [中文](./README.zh-CN.md)

# Plankton

Plankton 是一个面向敏感资源访问的本地优先审批控制台。桌面 UI 是策略配置面和人工审批面，CLI 则是操作者与 LLM 列出、搜索可用资源标识并发起访问请求的入口。

Powered by OpenAquarium

## Codex Skill

这个仓库自带一份 Codex skill，路径在 `.codex/skills/secret-access`。

在仓库根目录执行下面的命令，把它安装到本地 Codex skill 目录：

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -sfn "$PWD/.codex/skills/secret-access" "${CODEX_HOME:-$HOME/.codex}/skills/secret-access"
```

安装后，Codex 在遇到 password、API key、token、credential、secret 等敏感值需求时就可以加载这份 skill。它会引导通过 Plankton 请求密钥，并避免把返回值写入持久化介质或暴露到模型可见输出里。

## 如何使用

### 1. 通过 Homebrew 安装

默认安装路径是项目自有 tap 加 desktop cask：

```bash
brew install --cask zqqqqz2000/tap/plankton
plankton
```

这是一条 tap 自有 cask 路径，不是 `homebrew-core` formula。这个 cask 会一起安装 `Plankton.app` 和 `plankton` 命令；tap 里即使仍存在内部 helper formula，它也不是面向用户的主入口。

### 2. 通过源码安装并准备本地开发环境

```bash
make install
export PLANKTON_DATABASE_URL="sqlite://$PWD/.plankton/local.db"
mkdir -p .plankton
make check
```

### 3. 启动桌面 UI

```bash
make tauri-dev
```

保持桌面窗口开启。日常使用应以 UI 为中心。

### 4. 在 UI 中选择策略模式

- `人工审批` 是 UI 中专门用于人工审批的策略模式。人工审批发生在桌面 UI 中，不是 CLI 审批流。
- `assisted` 会先向 provider 获取建议，再由桌面 UI 中的人类做最终决定。
- `auto` 会在本地护栏和 provider 建议的基础上自动得到 allow、deny 或 escalate，同时让结果在 UI 和 CLI 中都可见。

### 5. 用 CLI 列出、搜索标识并发起访问请求

先列出当前可供本地 LLM 请求的资源标识：

```bash
plankton list
```

这个命令只会输出标识和必要元信息，不会直接打印密钥值。

如果你只想在同一批标识里做模糊搜索，可以直接运行：

```bash
plankton search api-token
```

`search` 只会对 `list` 同一资源标识视图做模糊匹配，返回的仍然只是标识和必要元信息，不会输出密钥值。

再用安装后的命令请求其中一个资源：

```bash
plankton get secret/api-token \
  --reason "Need readonly dev config" \
  --requested-by alice
```

成功时，默认 text 输出只会打印一个解析出来的裸 value，不会再附带 request ID、审批摘要、provider 元信息或其他包装文本。

如果你需要给脚本或工具链消费的结构化结果，请改用 `--output json`。JSON 路径会返回一个最小专用 envelope，而不是整包 request 或 audit dump。

这个 value 会在运行时从本地 secret catalog 解析，不会从 SQLite、audit 记录或 provider payload 中读回。如果你的环境使用显式 catalog 文件，请先把它指给 Plankton（例如 `PLANKTON_SECRET_FILE=/abs/path/...`）。

如果这次请求不能自动完成，Plankton 会把流程交给桌面 UI。人工审批、建议查看和审计查看都在 UI 中完成。非成功路径保持 `stdout` 为空，状态或错误会单独输出。若一次 deny 记录里带有原因或备注，Plankton 会把该原因追加到 deny 错误里；如果没有记录原因，则继续保持简洁的 denied 提示。

如果你当前是在源码仓库里做本地开发，而不是使用 cask 安装，可以把同样的命令换成 `cargo run -p plankton -- ...`。

### 6. 只有在需要 assisted 或 auto 时才配置 provider

`人工审批` 不需要 provider。

OpenAI-compatible：

```bash
export PLANKTON_PROVIDER_KIND=openai_compatible
export PLANKTON_OPENAI_API_KEY=...
export PLANKTON_OPENAI_MODEL=...
```

ACP Codex：

```bash
export PLANKTON_PROVIDER_KIND=acp_codex
export PLANKTON_ACP_CODEX_PROGRAM=npx
export PLANKTON_ACP_CODEX_ARGS="-y @zed-industries/codex-acp@0.11.1"
```

Claude：

```bash
export PLANKTON_PROVIDER_KIND=claude
export PLANKTON_CLAUDE_API_KEY=...
export PLANKTON_CLAUDE_MODEL=...
```

## UI 与 CLI 的分工

- UI 负责策略配置和人工审批。
- CLI 负责列出、搜索资源标识和发起访问请求，不承担人工审批或审计管理职责。
- 如果仓库里仍然能看到 `approve` 或 `reject`，应把它们视为内部或遗留兼容路径，而不是面向用户的主流程。

## 延伸阅读

- [P1 Runbook](./docs/p1-runbook.md)
- [P1 Dependency Boundaries](./docs/p1-dependency-boundaries.md)
- [ADR 0001: P1 Dependency Boundaries](./docs/adr/0001-p1-dependency-boundaries.md)

## 原理

- 每一次访问都会先变成一条显式请求，而不是隐式副作用。
- 在 provider 看到上下文之前，敏感信息会先被裁剪和脱敏。
- 即使启用了 provider，本地护栏仍然是最终的安全边界。
- 每一条请求的详细审批与审计链路都由桌面 UI 承接和解释。
- 当上下文不完整、provider 返回非法结果或触发风险边界时，系统会默认 fail-closed。
