# 贡献指南

## 本地防护：提交前自动拦截 PII / 密钥

本仓库用 [gitleaks](https://github.com/gitleaks/gitleaks) 在**提交那一刻**拦截把本机路径
（`/Users/<你的用户名>/…`）、私人邮箱、API key / token 等写进仓库。扫描规则与 allowlist 见
仓库根的 `.gitleaks.toml`。

一次性安装本地 pre-commit 钩子（强烈建议）：

```bash
# macOS
brew install pre-commit gitleaks
pre-commit install            # 把钩子装到 .git/hooks/pre-commit

# 其它平台：pipx install pre-commit（gitleaks 由 pre-commit 框架按 .pre-commit-config.yaml 自动拉取）
```

之后每次 `git commit` 都会自动扫 **staged** 内容，命中 PII/密钥则**拒绝提交**。手动全量扫：

```bash
gitleaks dir . --redact       # 扫当前工作树文件
pre-commit run --all-files    # 跑所有 pre-commit 钩子
```

即使没装本地钩子，CI（`.github/workflows/gitleaks.yml`）也会在 push / PR 时做一道
**不可绕过**的服务器端扫描——所以人人覆盖的硬保证来自 CI，本地钩子是给你的快反馈。

### 说明

- 这是 **going forward** 的防线，拦的是**新写入**；不清理 git 历史里已存在的内容。
- 遇到**误报**（合法的示例路径 `/Users/<you>/`、示例邮箱、测试夹具等），把对应文件路径或内容
  模式加进 `.gitleaks.toml` 的 `[[allowlists]]`，而不是用 `git commit --no-verify` 绕过。
