# Vite Browser Build and node-fetch Alias

本文说明 ai2nao 前端 Vite 构建中 `node-fetch externalized` 警告的成因、为什么可以用
浏览器 `fetch` shim 解决，以及这个方案的风险边界。

## 结论

`node-fetch` 是 Node.js 环境里的 fetch polyfill，不是浏览器优先的依赖。它内部会引用
`stream`、`http`、`https`、`url`、`zlib` 等 Node 内置模块。当前 Vite 构建目标是浏览器，
浏览器没有这些 Node 内置模块，所以 Vite 会输出类似警告：

```text
Module "stream" has been externalized for browser compatibility
Module "http" has been externalized for browser compatibility
Module "https" has been externalized for browser compatibility
Module "zlib" has been externalized for browser compatibility
```

这不表示 ai2nao 的前端业务代码直接使用了 `stream` 或 `http`，而是表示浏览器 bundle 的
依赖图中出现了 Node 专用包。Vite 为了保证浏览器构建继续完成，只能把这些 Node 内置模块
externalize，并提示这可能存在兼容风险。

ai2nao 的修复是在 `web/vite.config.ts` 中把前端构建里的 `node-fetch` 解析到浏览器 shim：

```ts
resolve: {
  alias: {
    "node-fetch": path.resolve(root, "src/shims/nodeFetch.ts"),
  },
},
```

shim 文件 `web/src/shims/nodeFetch.ts` 导出浏览器原生 Fetch API：

```ts
const browserFetch: typeof fetch = (...args) => globalThis.fetch(...args);

export default browserFetch;
export const fetch = browserFetch;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const FormData = globalThis.FormData;
export const Blob = globalThis.Blob;
export const File = globalThis.File;
```

修复后，前端依赖图从：

```text
frontend dependency -> node-fetch -> stream/http/https/zlib -> Vite externalized warnings
```

变成：

```text
frontend dependency -> web/src/shims/nodeFetch.ts -> globalThis.fetch -> browser-native API
```

因此 Vite 不再扫描到 `node-fetch` 对 Node 内置模块的引用，相关 warning 消失。

## 为什么前端会碰到 node-fetch

这次警告不是来自 ai2nao 自己的前端页面直接 import `node-fetch`。调查时确认：

- ai2nao 前端页面主要通过 `web/src/pages/AiChat.tsx` 使用 `@copilotkit/react-core/v2`。
- CopilotKit 的前端依赖树中包含 `streamdown`、`mermaid`、`shiki` 等较重的 markdown、
  diagram、code block 渲染依赖。
- 构建产物中命中 `node-fetch` 字符串的文件集中在这些 CopilotKit/streamdown/mermaid/shiki
  相关 lazy chunks 中。
- ai2nao 后端的 `src/llmChat/copilotRuntime.ts` 仍然使用 `@copilotkit/runtime/v2`，但该
  后端 runtime 没有被业务代码直接打进前端入口。

所以这次问题的性质是：前端依赖树里出现了同构或 Node 兼容包的浏览器构建噪音，而不是
ai2nao 把后端 runtime 误打进浏览器。

## 为什么 alias 是合理的

浏览器环境已经原生提供标准 Fetch API，包括：

```text
fetch
Headers
Request
Response
FormData
Blob
File
```

如果依赖包只是需要标准 fetch 行为，那么把 `node-fetch` alias 到浏览器原生 Fetch API 是
合理的。这个方案相当于明确告诉 Vite：

> 在浏览器 bundle 中，不要解析 Node 版本的 fetch polyfill，直接使用浏览器自己的 Fetch API。

这符合前端构建目标，也避免把 Node-only 模块带进浏览器依赖图。

## 风险边界

alias 不是无条件安全的。它只适用于依赖包在浏览器运行路径中使用标准 Fetch API 的情况。

如果某个运行路径真的依赖 `node-fetch` 的 Node 专属能力，shim 可能不够。例如：

```ts
import nodeFetch from "node-fetch";

nodeFetch(url, {
  agent: new http.Agent(),
});
```

或者依赖 Node stream、代理 agent、Node 压缩流、文件系统相关能力等。这些能力浏览器没有，
`web/src/shims/nodeFetch.ts` 也不会模拟。

因此这个 alias 的边界是：

- 只放在 `web/vite.config.ts`，只影响前端 Vite 构建。
- 不影响后端 TypeScript 构建和 Node runtime。
- 只覆盖浏览器应该使用原生 Fetch API 的场景。
- 如果未来前端依赖真的需要 Node-only fetch 行为，应优先避免把该依赖放入浏览器 bundle，
  而不是继续扩大 shim。

## 大 chunk 警告

同一次修复中，`web/vite.config.ts` 也设置了：

```ts
build: {
  chunkSizeWarningLimit: 2000,
}
```

原因是当前最大的 chunks 来自已 lazy-loaded 的 CopilotKit/mermaid/shiki 功能块，不是主入口
bundle。`web/src/App.tsx` 已经使用 route-level `React.lazy` 和 `Suspense` 做页面级拆分，
所以这些大 chunk 不会在首页一次性进入主入口。

这个阈值不是为了掩盖主包膨胀，而是避免 Vite 对“明确按需加载的重功能块”持续输出噪音。
阈值保留在 2000 kB，仍然能让未来更异常的增长继续暴露出来。

## 验证方法

前端构建验证：

```bash
/Users/you/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node ./node_modules/.bin/vite build --config web/vite.config.ts
```

期望结果：

- 构建成功。
- 不再出现 `node-fetch externalized` 相关警告。
- 不再出现 Vite large chunk 警告。

类型检查：

```bash
./node_modules/.bin/tsc --noEmit
```

产物检查：

```bash
find web/dist/assets -maxdepth 1 -type f -name '*.js' -print0 \
  | xargs -0 grep -l "node-fetch\|@remix-run/node-fetch-server"
```

期望没有输出。没有输出表示前端产物中没有再包含 `node-fetch` 或
`@remix-run/node-fetch-server` 字符串。

## 后续注意事项

如果以后升级 CopilotKit、streamdown、mermaid、shiki 或 Vite 后警告再次出现，优先按下面顺序
排查：

1. 先确认是否有新的 Node-only 包进入 `web` 构建依赖图。
2. 如果只是标准 Fetch API 兼容问题，可以继续使用或调整当前 shim。
3. 如果是后端 runtime 被打进前端，应修正 import 边界，而不是为更多 Node 模块加 shim。
4. 如果大 chunk 继续增长，应先判断是否仍是 lazy feature chunk；只有主入口或常用路径增长时，
   才应该优先做代码拆分或依赖替换。
