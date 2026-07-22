# AI 工具检测:支持清单与机制

「AI 工具清单」功能扫描本机装了哪些 AI 工具。这份文档说明**当前能认出哪些工具**
(指纹库),以及**检测是怎么做的**。

> 本文档只列「能认出哪些」。每个工具的**版本号 / 安装路径**是每次扫描从本机实时读出的,
> 属于个人机器状态,不写进这里。

---

## 检测机制

两条路(设计 §4:不重扫磁盘,吃现有清点结果):

- **桌面 app / brew 包**:读 ai2nao 已经扫好的 `mac_apps` / `brew_packages` 表,逐行对
  指纹库匹配 —— **不重开 /Applications、不重跑 brew**。
- **命令行 CLI**:主动去 `$PATH`(+ `~/.bun/bin`、`~/.local/bin` 等)探二进制文件在不在 ——
  因为 npm 全局/裸装的 CLI 根本不进 mac_apps/brew 表。

展示时**按工具折叠**:一个工具被多源检测到(如 Cursor 既是 app 又在 PATH),合成一行、
标出多个来源。卸载后**软删除**(标记 missing,不硬删,保留历史)。

匹配键(指纹库 `src/aiTools/registry.ts`,每条指纹可用其一或多个):

| 匹配键 | 含义 |
|---|---|
| `macBundleId` / `macBundleIdPrefix` | 按 bundle id 认(最稳,与安装路径无关) |
| `macNameExact` | 按 app 名认(未核实 bundle id 时兜底) |
| `brewFormula` / `brewCask` | 按 Homebrew 包名认 |
| `binaries` | 按 `$PATH` 上的二进制名认 |

---

## 当前支持的工具(16 条)

### 桌面 app

| 工具 | 厂商 | 匹配 |
|---|---|---|
| Claude | Anthropic | bundle `com.anthropic.claudefordesktop` |
| Kimi | Moonshot | bundle `com.moonshot.kimichat` |
| ChatGPT | OpenAI | app 名 `ChatGPT` |
| Cursor | Anysphere | app 名 `Cursor` + PATH `cursor` |
| CC Switch | ccswitch.io | bundle `com.ccswitch.desktop` |
| Warp | Warp | bundle `dev.warp.Warp-Stable` |
| Cherry Studio | Cherry Studio | bundle `com.kangfenmao.CherryStudio` |
| ima.copilot | 腾讯 | bundle `com.tencent.imamac` |

### 命令行 CLI(探 `$PATH` 二进制)

| 工具 | 厂商 | 二进制 |
|---|---|---|
| Claude Code | Anthropic | `claude` |
| Codex CLI | OpenAI | `codex` |
| Gemini CLI | Google | `gemini` |
| opencode | — | `opencode` |
| Aider | — | `aider` |
| Hermes Agent | Nous Research | `hermes` |

### 本地运行时

| 工具 | 厂商 | 匹配 |
|---|---|---|
| LM Studio | Element Labs | app 名 `LM Studio` + brew cask `lm-studio` |
| Ollama | Ollama | brew `ollama` + PATH `ollama` |

---

## 注意 / 局限

- **`hermes` 二进制歧义**:React Native 的 JS 引擎二进制也叫 `hermes`。若某台机器上的 `hermes`
  是 RN 引擎而非 Nous Research 的 Hermes Agent,会误判为后者。
- **app/brew 检测依赖对应清点表已扫过**(`mac_apps.sync` / `brew.sync`)。`ai_tools.scan` 是
  派生任务,应排在它们之后(设计 F4);源表为空时只是少认出桌面 app,PATH 探测仍独立工作。
- **bundle id 只在 macOS 有意义**;当前检测面向 macOS。

---

## 怎么扩充

编辑 `src/aiTools/registry.ts` 加一条指纹即可。原则:

1. 桌面 app 的 **bundle id 优先从本机 `mac_apps` 表取真实值**(装了就
   `SELECT bundle_id, name FROM mac_apps WHERE name LIKE '%…%'`),**绝不瞎编**;
   没装的用 `macNameExact`(app 名)兜底。
2. CLI 用 `binaries`(PATH 二进制名)。
3. `toolKey` 全局唯一。

加完 `test/aiTools.registry.test.ts` 会自动校验:`toolKey` 唯一、每条至少有一个匹配键、
`kind` 合法。
