---
name: secret-access
description: Use this skill whenever a task may require a password, API key, token, credential, secret, or other sensitive value. Use Plankton to install, discover resources, request access, and consume approved values without persisting them, logging them, echoing them back to the model, or letting the model itself read the returned secret.
---

# Secret Access

Use this skill whenever the task may require a password, API key, token, credential, secret, or other sensitive value.

## Install

```bash
brew install --cask zqqqqz2000/tap/plankton
plankton
```

## Use

- If the resource identifier is already known, request it directly:

```bash
plankton get secret/api-token \
  --reason "为完成当前开发联调与只读排障，需要临时获取目标服务凭证，仅在本次命令执行时注入进程使用，不写入文件或日志" \
  --requested-by alice
```

- If the identifier is unknown, inspect first:

```bash
plankton list
plankton search api-token
```

- If `list` or `search` does not show the expected resource, tell the user to add or import the key into Plankton before retrying. Prefer importing only the source locator, for example from `.env` or a password manager, instead of asking the user to paste the secret into chat.

- If the secret lives in `.env` or a password manager, import only the source locator first:

```bash
plankton import dotenv-file \
  --resource secret/api-token \
  --file .env \
  --key API_TOKEN
```

- Every `plankton get` is an explicit access request. Approval may happen outside the CLI flow before the value is returned.
- Successful text output prints only the resolved raw value.
- The model itself must not read the returned value. It may only pass the value through to the downstream command, process, or pipeline that needs it.

## Boundaries

- Treat any value returned by `plankton get` as use-only sensitive material.
- Do not let the model itself see the returned value. Do not run `plankton get` in a way that captures the secret into model-visible command output, reasoning, summaries, or copied snippets.
- Do not paste the returned value into the chat, summaries, code comments, logs, patches, screenshots, fixtures, tests, markdown examples, or terminal transcripts quoted back to the user.
- Do not write the returned value into files, env files, SQLite, audit payloads, shell history helpers, caches, or any other persistent artifact unless the user explicitly asks for persistence.
- Do not restate, paraphrase, quote, or otherwise reveal the value back to the model. The model may only broker the value into the next command or tool invocation that requires the secret, without inspecting it.
- Prefer piping, environment injection, or direct process handoff over temporary files.
- If the next step would require showing the secret to the model, stop and explain that Plankton values must be consumed without being disclosed back into the conversation.
