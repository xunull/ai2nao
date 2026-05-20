# ai2nao_run_code 本地沙盒代码执行

`ai2nao_run_code` 是 `/ai-chat` 的后端 AI-callable tool，用来让模型在本机执行短小 Python 代码。它的目标是确定性计算、小型文本/CSV/JSON 处理、算法验证和临时数据转换，不是终端、不是 shell，也不是本机文件访问入口。

## 技术选择

当前实现有两个并存 runtime：

- `pyodide`：默认安全模式，使用 Pyodide/WASM Python。
- `docker`：V2 高自由度模式，使用本机 Docker 运行 CPython 容器。

Pyodide/WASM Python：

- 每次 tool 调用启动一个短生命周期 Node Worker。
- Worker 内加载 Pyodide，并把 Python 工作目录固定到 `/workspace`。
- 输入文件写入 Pyodide 的内存文件系统 MEMFS。
- 运行结束后只回传 stdout、stderr、生成文件摘要和限制信息。
- 运行结束、超时或 abort 后都会 terminate Worker。

Docker Python：

- 只有用户显式选择 Docker runtime 时才可用。
- 每次运行创建一个临时 workspace，只把该临时目录挂进容器。
- 通过 `docker run` 参数禁用网络、限制 CPU/内存/PID、只读根文件系统、drop capabilities、no-new-privileges。
- 运行结束后收集 stdout、stderr 和 `/workspace/output` 下的生成文件摘要，然后清理临时目录。

没有使用 `node:vm`、`eval`、`Function` 或本机 `python3` 子进程。普通 Node/Python 本机进程不能被称为安全沙盒，因为它能接触宿主进程、环境变量、网络和真实文件系统。

## 触发方式

前端 `web/src/pages/AiChat.tsx` 只传能力开关：

```ts
{
  codeExecutionEnabled: useCodeExecution,
  codeExecutionRuntime: "pyodide" | "docker",
  codeExecutionTimeoutMs: 10_000
}
```

`src/llmTools/forwardedProps.ts` 解析该开关。`src/llmTools/registry.ts` 只有在 `codeExecutionEnabled === true` 时才注册：

```ts
tools.ai2nao_run_code = createRunCodeTool(...)
```

如果用户没有打开 Code，模型在这一轮里根本看不到 `ai2nao_run_code`。如果用户选择的是 Safe Python，模型即使传 `runtime: "docker"` 也会被后端拒绝。

## 数据流

```text
AI Chat Code toggle
  |
  v
CopilotKit properties
  |
  v
parseForwardedToolProps()
  |
  v
buildAi2NaoServerTools()
  |
  +-- ai2nao_run_code
        |
        v
createRunCodeTool()
        |
        v
CodeRunnerService.run()
        |
        +-- runtime=pyodide -> Node Worker -> Pyodide/WASM -> /workspace MEMFS
        |
        +-- runtime=docker  -> docker run -> CPython container -> temp workspace
        |
        v
stdout/stderr/files/limits -> model -> final answer
```

CopilotKit 仍然只做 transport/UI。前端没有注册业务 tools，也不能提供 client tool/page context/shared state 作为后端事实来源。

## Tool 输入

```ts
{
  runtime?: "pyodide" | "docker",
  language: "python",
  code: string,
  stdin?: string,
  files?: Array<{
    name: string,
    content: string
  }>,
  reason?: string,
  timeoutMs?: number
}
```

限制：

- `language` 只允许 `python`。
- `runtime` 默认跟随本轮 UI 选择；未选择 Docker 时只能使用 `pyodide`。
- `code` 默认最多 20,000 字符。
- `stdin` 默认最多 1,000,000 字符。
- 输入文件最多 10 个，单文件最多 1MB，总计最多 5MB。
- 文件名必须是普通相对路径，禁止绝对路径、`.` 开头、`..`、空路径和特殊字符。
- timeout 默认 10 秒，最大 30 秒。

## Tool 输出

```ts
{
  ok: boolean,
  runtime: "pyodide" | "docker",
  language: "python",
  timedOut: boolean,
  stdout: string,
  stderr: string,
  files: Array<{
    name: string,
    sizeBytes: number,
    preview?: string
  }>,
  limits: {
    timeoutMs: number,
    stdoutTruncated: boolean,
    stderrTruncated: boolean
  },
  error?: string
}
```

stdout/stderr 默认最多保留 64KB。生成文件最多回传 10 个摘要，单文件预览最多读取 1MB 内的前 4KB 文本。

## 安全边界

当前边界是多层叠加：

1. Worker 隔离：每次运行新 Worker，避免跨轮 Python 变量、文件和模块状态泄漏。
2. Pyodide MEMFS：只写入 `/workspace` 内存文件系统，不挂载宿主目录。
3. 空 `jsglobals`：Pyodide 的 `js` 模块不拿默认 `globalThis`。
4. Python import guard：阻止 `js`、`pyodide_js`、`micropip`、`socket`、`ssl`、`http`、`urllib`、`requests`、`subprocess`、`multiprocessing` 等导入。
5. 输入校验：拒绝路径穿越、绝对路径、过大代码、过大 stdin 和过大文件。
6. 资源限制：timeout terminate Worker，stdout/stderr 截断。

Docker runtime 额外边界：

1. `docker run` 不走 shell，只用固定参数数组。
2. `--network none` 禁止容器联网。
3. `--memory 512m`、`--cpus 1`、`--pids-limit 128` 控制资源。
4. `--read-only`、`--cap-drop ALL`、`--security-opt no-new-privileges` 降低容器权限。
5. 只挂载 ai2nao 创建的临时 workspace，不挂载 repo、home 或任意宿主路径。

这仍然不是完整虚拟机级隔离。Docker runtime 适合更自由的本地 Python 运行，但第一版仍然不开放 pip install、联网、宿主文件读取、长期服务或端口监听。

## Docker 状态接口

`GET /api/code-runner/status` 返回：

```ts
{
  pyodide: { available: true },
  docker: {
    available: boolean,
    dockerVersion: string | null,
    image: "python:3.12-slim-bookworm",
    imagePresent: boolean,
    error: string | null
  }
}
```

前端根据该接口决定是否允许选择 Docker Python。当前实现不会自动 `docker pull`；镜像不存在时只返回状态错误。

## 模型触发规则

`src/llmChat/copilotRuntime.ts` 的 system prompt 只允许模型在这些场景调用：

- 精确计算。
- 小型数据转换。
- Python 逻辑验证。

明确禁止：

- shell 命令。
- 包安装。
- 网络访问。
- 宿主文件系统访问。
- 长期运行服务。

tool 返回后，模型必须继续生成用户可见的最终回答，不能只停在 tool result。

## 测试覆盖

主要测试：

- `test/codeRunner.test.ts`
  - Python happy path。
  - MEMFS 输入文件和生成文件。
  - 路径穿越拒绝。
  - JS bridge / 网络 / 子进程相关 import block。
  - timeout terminate。
- `test/dockerRunner.test.ts`
  - Docker run 参数包含 network/cpu/memory/pids/cap/security 限制。
  - Docker runtime 默认禁用。
  - Docker runner 通过 `spawn("docker", args)` 执行，不走 shell 字符串。
- `test/llmChat.copilotRuntime.run.test.ts`
  - `codeExecutionEnabled` 开启时才注册 `ai2nao_run_code`。
  - 继续覆盖 CopilotKit client tools、page context、shared state 被拒绝。

手动验证过构建后的 `dist/codeRunner/index.js` 可以真实运行 Pyodide Python：

```bash
node --input-type=module -e "import { createCodeRunnerService } from './dist/codeRunner/index.js'; const r=await createCodeRunnerService().run({language:'python', code:'print(40+2)'}); console.log(JSON.stringify(r));"
```
