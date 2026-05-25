# ai2nao_run_shell 受控 Bash 工具

`ai2nao_run_shell` 是 `/ai-chat` 的后端 AI-callable tool，用来执行经过校验的本机 Bash 命令。它借鉴 Claude Code BashTool 的分层思路：模型只提出命令请求，真正执行前必须经过权限校验、复合命令拆分、危险语义拦截、受限环境、超时和输出裁剪。

它不是通用终端，也不是任意 shell 字符串执行入口。

## 开启方式

前端 `Shell` 开关关闭时，后端不会注册 `ai2nao_run_shell`，模型在本轮对话中看不到这个 tool。

开启后，前端通过 CopilotKit properties 传递：

```ts
{
  shellExecutionEnabled: true,
  shellExecutionTimeoutMs: 10_000,
  shellPermissionMode: "default"
}
```

后端仍然只使用 server-side tools。CopilotKit 不参与 tool calling 策略、权限判断或执行语义。

## 输入

```ts
type BashToolRequest = {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  description?: string;
};
```

- `command`：待执行 Bash 命令。
- `cwd`：相对当前服务进程项目根目录的工作目录；绝对路径也必须落在项目根目录内。
- `timeoutMs`：请求超时，后端会裁剪到安全上限。
- `description`：模型说明为什么需要执行。

## 权限模型

命令执行前会调用 `checkBashPermission()`：

1. 拒绝命令替换、process substitution、heredoc、文件重定向。
2. 拆分 `&&`、`||`、`;`、`|` 等复合命令，并逐段检查。
3. 拒绝二级 shell、sudo、网络工具、破坏性文件命令、包安装、任意解释器。
4. 对 `git`、`npm`、`node`、`sed`、`awk`、`find` 做更细的子命令/flag 校验。
5. 命令过长或子命令过多时直接拒绝。
6. 结构上没有命中硬拒绝规则、但不属于明确只读命令的普通命令，会标记为 `project-command` 并进入交互式审批。

允许范围以只读检查为主：

- `pwd`
- `ls`
- `find`，但拒绝 `-exec`、`-delete`
- `cat`、`head`、`tail`、`wc`
- `grep`、`rg`
- `sed`，但拒绝 `-i`
- `awk`，但拒绝 `system()`
- `git status/diff/log/show/branch/rev-parse/ls-files/grep/describe/remote`
- `node --version`

这些命令会直接通过静态检查，并按风险进入后续规则或审批判断。

常见项目验证命令包括：

- `npm run test`
- `npm run test:unit`
- `npm run test:e2e`
- `npm run lint`
- `npm run typecheck`
- `npm run check`
- `npm run build`
- `npm run smoke`

这些命令标记为 `project-command`，因为它们可能写入构建产物或缓存。其他没有命中硬拒绝规则的普通命令也会作为 `project-command` 进入审批，而不是因为不在静态 allowlist 中直接拒绝。

## 交互式审批

`project-command` 不会直接执行。后端会创建一个待审批请求：

```ts
type BashApprovalRequest = {
  id: string;
  sessionId: string | null;
  command: string;
  cwd: string;
  risk: "read-only" | "project-command";
  description: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  suggestedRules: BashPermissionRuleSuggestion[];
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
};
```

审批 API：

- `GET /api/bash-approvals?sessionId=<threadId>`
- `POST /api/bash-approvals/:id/approve`
- `POST /api/bash-approvals/:id/deny`
- `GET /api/bash-permission-rules`
- `POST /api/bash-permission-rules`
- `PATCH /api/bash-permission-rules/:id`
- `DELETE /api/bash-permission-rules/:id`
- `GET /api/bash-sandbox/status`
- `POST /api/bash-sandbox/config`

AI Chat 页面在 `Shell` 开启且当前会话存在时轮询待审批项。用户点击“本次执行”后，后端才继续运行命令；用户点击“拒绝”或审批超时后，tool 返回结构化拒绝结果。

当前审批状态存储在服务进程内存中，适合本机单进程开发工作台。进程重启会丢失 pending approval；如果未来要支持长期后台任务或多进程部署，需要把审批状态迁移到 SQLite。

用户点击“执行并记住”时，后端会把规则保存到 SQLite 的 `bash_permission_rules` 表。默认保存为目录级规则：

- `scope_type = 'directory'`
- `scope_value = <本次审批命令的 cwd>`

后续只有当命令执行目录位于该目录树下时，规则才会命中。直接通过规则管理 API 创建规则时仍支持 `scope_type = 'global'`，但交互式审批默认不会生成全局规则。

## 执行模型

执行层默认使用本地 Bash runner：

```ts
spawn("bash", ["--noprofile", "--norc", "-lc", command])
```

关键约束：

- 不加载用户 shell rc 文件。
- 使用精简环境变量。
- 设置 `CI=1`、`NO_COLOR=1`、`AI2NAO_BASH_TOOL=1`。
- `cwd` 必须位于服务进程项目根目录内。
- stdout/stderr 分流捕获。
- 输出最多返回 30,000 字符。
- 超时后杀掉进程组。

### 可选 OS sandbox adapter

执行层已经预留 `SandboxRunner` adapter，并提供 `@anthropic-ai/sandbox-runtime` 后端 spike。该后端默认关闭，只有创建 Bash tool service 时显式配置 `sandbox.mode` 才会参与执行。

当前模式：

- `off`：默认值，不包装命令，返回 `sandboxDebug.applied = false`。
- `best-effort`：尝试用 `@anthropic-ai/sandbox-runtime` 包装命令；平台或依赖不可用时继续本地执行，并在 `sandboxDebug.unavailableReason` 里说明原因。
- `required`：必须成功进入 sandbox；平台或依赖不可用时 fail closed，不启动子进程。

adapter 的默认策略：

- 使用 macOS Seatbelt 或 Linux / WSL2 bubblewrap，取决于 `@anthropic-ai/sandbox-runtime` 当前平台支持。
- 默认无网络：`allowedDomains = []`。
- 默认只允许写当前 `cwd` 和系统临时目录。
- 默认拒绝读取常见凭证目录，例如 `~/.ssh`、`~/.aws`、`~/.kube`、`~/.docker`、浏览器 profile。
- 默认拒绝写 `.env`、`.git/config`、`.git/hooks` 等高风险项目元数据。

注意：这是可选 adapter，不替代前面的静态安全检查、审批、allow/ask/deny 规则和目录级持久化规则。`allow` 规则的含义仍然是“允许在当前 runner/sandbox policy 下执行”，不是允许裸跑宿主机。

## 返回值

```ts
type BashToolResult = {
  ok: boolean;
  command: string;
  cwd: string;
  risk: "read-only" | "project-command";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  approval?: BashToolApproval;
  deniedReason?: string;
  permissionDebug?: BashPermissionDebug;
  sandboxDebug?: BashSandboxDebug;
};
```

被拒绝的命令不会启动子进程，`exitCode` 为 `null`，并返回 `deniedReason`。

## 与 Claude Code BashTool 的对应关系

本实现借鉴了这些机制：

- Bash tool 不是直接执行模型字符串，而是先经过权限 gateway。
- 复合命令必须拆分后逐段检查。
- deny 优先，危险结构直接拒绝。
- 避免保存或生成过宽权限，如 `bash:*`、`sh:*`、`env:*`。
- wrapper/env 不能随意剥离，危险环境变量会改变执行语义。
- read-only 命令需要细到子命令和 flag。
- 对有副作用风险的命令走人类审批，而不是让模型自己决定。
- 支持 “Yes, and don’t ask again for …” 风格的目录级持久规则。
- 支持可选 `@anthropic-ai/sandbox-runtime` adapter，作为真实 OS sandbox 的第一版 spike。
- 执行器必须有 timeout、输出上限、进程树清理。
- tool result 要包含可审计字段，而不是只返回一段 stdout。

暂未实现 Claude Code 的后台任务恢复、命令分类器和 shell 级 AST parser。OS sandbox 目前是可选 adapter spike，尚未默认启用，也不能作为任意 Bash 的默认前提。
