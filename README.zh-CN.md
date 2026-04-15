[English](./README.md) | [中文](./README.zh-CN.md)

# Plankton

Plankton 是一个面向敏感资源访问的本地优先审批控制台。桌面 UI 是策略配置面和人工审批面，CLI 则是操作者与 LLM 发起访问尝试、查询状态和读取审计信息的入口。

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

默认安装路径是项目自有 tap 加 CLI formula：

```bash
brew install zqqqqz2000/tap/plankton-cli
plankton-cli
```

这不是 `homebrew-core` formula，也不是 desktop cask。仓库已经按这条安装路径准备好了，但第一次对外发布仍受外部前提阻塞：必须先具备 tap 仓库和 GitHub 凭据，这条安装方式才能真正对所有人可用。

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

### 5. 用 CLI 发起访问尝试并做只读查询

发起一次访问尝试：

```bash
cargo run -p plankton-cli -- get secret/api-token \
  --reason "Need readonly dev config" \
  --requested-by alice
```

在 CLI 中查询同一条请求：

```bash
cargo run -p plankton-cli -- queue
cargo run -p plankton-cli -- status <request-id>
cargo run -p plankton-cli -- suggestion <request-id>
cargo run -p plankton-cli -- audit --limit 20
```

`queue` 是当前的列表式查询入口。人工审批不在这里完成，而是在桌面 UI 中完成。

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
- CLI 负责发起访问尝试和读取状态，不承担常规的人类审批职责。
- 如果仓库里仍然能看到 `approve` 或 `reject`，应把它们视为内部或遗留兼容路径，而不是面向用户的主流程。

## 延伸阅读

- [P1 Runbook](./docs/p1-runbook.md)
- [P1 Dependency Boundaries](./docs/p1-dependency-boundaries.md)
- [ADR 0001: P1 Dependency Boundaries](./docs/adr/0001-p1-dependency-boundaries.md)

## 原理

- 每一次访问都会先变成一条显式请求，而不是隐式副作用。
- 在 provider 看到上下文之前，敏感信息会先被裁剪和脱敏。
- 即使启用了 provider，本地护栏仍然是最终的安全边界。
- 同一条请求会同时出现在桌面 UI 和 CLI 的共享审计链路中，因此可以被复盘和解释。
- 当上下文不完整、provider 返回非法结果或触发风险边界时，系统会默认 fail-closed。
