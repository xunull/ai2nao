---
title: Work Recap Prompt 技术文档
category: 调度与运维
order: 30
---
# Work Recap Prompt 技术文档

本文档说明 `/work-recap` 功能用来生成自然语言摘要的 LLM Prompt 的**结构、
构造逻辑、定义位置和约束**，供后续修改 prompt 模板、调整字段或排查推断质量
问题时参考。

> 这是一份「prompt 解剖文档」，不是产品设计文档。功能本身的设计约束见
> `~/.gstack/projects/xunull-ai2nao/<user>-main-design-20260609-190620-work-recap.md`，
> 以及相邻文档 `daily-summary.md`（同款事实层 + LLM 层分离的工程模式）。

---

## 1. 一句话总览

```
事实层 (确定性逻辑)               LLM 推断层 (一次性调用)
─────────────────────             ──────────────────────
git log → WorkRecapFacts          SYSTEM_PROMPT (不变)
   │                                 +
   ▼                              SCHEMA_DESCRIPTION (JSON 字段约束)
buildPrompt()       ──────►          +
   ├─ 脱敏                        Facts 序列化（窗口/扫描状态/类型分布）
   ├─ 截断 subject                    +
   ├─ 截断 top-N project          Projects 块 (top-N 项目 × top-N commit)
   └─ 截断总字符                      +
                                  OUTPUT 指令（仅 JSON）
                                     │
                                     ▼
                                  callLlm() → WorkRecapInference
```

事实层永远是真相，LLM 只产文本字段（`summary` / `workMode` / `nextUp` 等）。
LLM 失败、超时、返回畸形都不影响事实层在 UI 上的呈现。

---

## 2. Prompt 的两段：System + User

| 段 | 来源 | 内容性质 | 何时变化 |
|---|---|---|---|
| `system` | `SYSTEM_PROMPT` 常量 | 模型角色、行为约束、语气策略 | 改风格/防越界时 |
| `user` | `buildPrompt(input).prompt` | Schema + 该次窗口的事实 + 项目 + 输出指令 | 每次调用都不同 |

实际进 OpenAI / DeepSeek / Moonshot 等 provider 的 messages 由
`callLlm()` 拼装：

```ts
// src/workRecap/llm.ts:240-249
body: JSON.stringify({
  model: args.config.model,
  temperature: 0.2,
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: args.prompt.prompt },
  ],
}),
```

- `temperature: 0.2`：低温度，倾向稳定输出
- `response_format: { type: "json_object" }`：OpenAI-compatible 的 JSON
  模式强制返回 JSON object（不是所有 provider 都支持，不支持的情况下
  靠 prompt 中的 `Output JSON only` 软约束 + 解析阶段的硬校验兜底）

---

## 3. System Prompt（不变量）

定义位置：`src/workRecap/prompt.ts:98-102`

```text
You summarize a developer's recent commits across multiple local git repositories.
You produce strict JSON only, matching the schema in the user message.
Never invent project names that are not in the provided facts.
Lean toward humble inference language ("looks like", "appears to") in summary; never assert.
If totalCommits is small or signal is sparse, set workMode to "low_signal" and write a short factual summary.
```

每一句对应一个产品约束：

| 系统提示语句 | 落地的约束 |
|---|---|
| `summarize ... commits across multiple local git repositories` | 限定主题域，杜绝跑题 |
| `strict JSON only, matching the schema` | 与 `response_format` 双保险 |
| `Never invent project names not in the provided facts` | 防止幻觉项目（事实层胜过推断层的最基础保障） |
| `humble inference language ("looks like", "appears to")` | 推断语气铁律（设计文档 P12：workMode 是「推断层」不是「事实层」） |
| `low_signal + short factual summary` when sparse | 数据稀疏日不硬写故事，主动降级 |

**改 System Prompt 的连带影响：**
- 改语气/约束类语句：通常无需改其他文件
- 改 `low_signal` 阈值描述（"small / sparse"）：要和 `facts.ts` 的
  `SPARSE_SIGNAL_COMMIT_THRESHOLD = 3` 保持语义一致
- 改 workMode 列表：**必须**同步改 `types.ts WorkRecapWorkMode`、
  `llm.ts WORK_MODES` 与 `SCHEMA_DESCRIPTION`

---

## 4. User Prompt 结构

User prompt 由 `buildPrompt()` 拼装（`src/workRecap/prompt.ts:125-242`）。
按以下五段拼接（行 207-219）：

```
Schema:
<SCHEMA_DESCRIPTION JSON>

Facts:
<factsHeader 5 行>

Projects (top by commit count):
<projectSection 多行>
<overflowNote? 1 行>

Output JSON only, no markdown fences, no commentary.
```

### 4.1 Schema 段

定义位置：`src/workRecap/prompt.ts:104-117`

序列化的 JSON Schema 描述：

```json
{
  "summary": "string (Chinese, <=400 chars, narrative)",
  "workMode": "build|debug|explore|fragmented|low_signal",
  "workModeReason": "string (<=80 chars, one-line explanation)",
  "nextUp": "array of string (1-2 short lines guiding tomorrow's pickup, [] when low signal)",
  "fragmentation": "low|med|high",
  "degraded": "boolean (set true only if you have to abandon inference)",
  "degradeReason": "null|sparse_signal|text_fact_conflict (use sparse_signal when totalCommits<3 or projects all show 1 commit; null otherwise)"
}
```

这是给 LLM 的「契约」，跟解析逻辑 `llm.ts normalizeResult()`（行 117-167）
必须保持字段、类型、枚举值三方一致。当前 4 个不变量：

- `summary` 中文，自然语言，长度由 `asNonEmptyTrimmedString(_, 400)` 截断
- `workMode` 五选一枚举：`build` / `debug` / `explore` / `fragmented` / `low_signal`
- `workModeReason` ≤80 字，由 `asNonEmptyTrimmedString(_, 80)` 截断
- `nextUp` 最多 2 条 × 120 字符（`asStringArray(_, 2, 120)`）

**改 schema 的连带改动：** 增减字段时三处必须同步：

```
prompt.ts  SCHEMA_DESCRIPTION       (LLM 看到的契约描述)
types.ts   WorkRecapInference       (后端/前端 TS 类型)
llm.ts     normalizeResult()        (解析 + 校验代码)
```

任何一处漏改都会导致：要么 LLM 输出被丢弃归到 `llm_malformed`，要么前端
渲染崩。改完 schema **必须 bump `WORK_RECAP_PROMPT_VERSION`**（见第 7 节）。

### 4.2 Facts Header 段

定义位置：`src/workRecap/prompt.ts:182-188`

5 行固定结构，每次调用都不一样：

```
Window: 7d (7 days, 2026-06-03T00:00:00Z → 2026-06-10T00:00:00Z)
Author email: you@example.com
Repos scanned: 8/10
Total commits: 12, projects: 2
Commit kinds: feat=7, fix=3, docs=1, chore=1
```

特殊情况：

- 当 `facts.scanTruncated == true`：第三行追加 `(TRUNCATED: <reason>)`，
  例如 `Repos scanned: 5/12 (TRUNCATED: scan_timeout)`
- 当某种 commit 类型计数为 0：在 `Commit kinds:` 行**省略不展示**
  （`COMMIT_TYPE_KINDS.filter(k => counts[k] > 0)`）
- 当无任何 commit：`Commit kinds:` 行显示 `(none)`

这一段是「事实骨架」，LLM 只能基于这些数字推断 workMode/fragmentation/summary，
不允许编造其他事实。

### 4.3 Projects 段

定义位置：`src/workRecap/prompt.ts:131-200`

每个项目一个块，按 `commitCount` 降序排列：

```
Project: alpha (key=/Users/me/repos/alpha, total=9)
  - feat: add login page
  - fix: handle null in auth
  - feat: oauth callback
  ...
Project: bravo (key=/Users/me/repos/bravo, total=3)
  - docs: README
  - chore: bump deps
  - feat: ...
```

- 每行 commit subject 格式：`  - <kind>: <subject>`（kind 是分类标签，
  不是 commit 原文里的 prefix——便于 LLM 在 prefix 缺失或不规范的情况下
  仍能读到分类）
- subject 进 prompt 前已过 `clipSubject()`（行 73-79）→ 脱敏 + 截断到 100 字符
- 每项目最多 `WORK_RECAP_PROMPT_BUDGET.commitsPerProject = 15` 条
- 最多 `WORK_RECAP_PROMPT_BUDGET.topProjects = 8` 个项目
- 超出 top-N 的项目以 overflowNote 形式告知 LLM 它们存在但被省略

### 4.4 Overflow Note（可选）

定义位置：`src/workRecap/prompt.ts:202-205`

```
NOTE: <N> more project(s) had commits but were omitted by prompt budget.
Treat them as long-tail; do not pretend they don't exist.
```

仅当 `facts.projectShare.length > 8` 时出现。这一行的存在防止 LLM 误判
「就这俩项目」从而在 summary 里讲反话。

### 4.5 Output 指令

```
Output JSON only, no markdown fences, no commentary.
```

跟 system prompt 里的「strict JSON only」+ provider 的 `response_format`
共同形成三重保险。即便如此，`llm.ts` 仍然兜底 `JSON.parse` try/catch
退化为 `llm_malformed`。

---

## 5. 脱敏（Secret Redaction）

定义位置：`src/workRecap/prompt.ts:22-67`

进 prompt 之前所有 commit subject 都必须过 `redactSecrets()`。规则按下表
逐个匹配并替换：

| 规则名 | 正则模式（关键部分） | 替换为 |
|---|---|---|
| `cli-arg-secret` | `--token <X>` / `--password <X>` / `--secret <X>` / `--api[-_]?key <X>` | `--token <redacted>` |
| `bearer-header` | `Authorization: Bearer <X>` / 裸 `Bearer <X>` | `Bearer <redacted>` |
| `openai-sk` | `sk-[A-Za-z0-9_-]{20,}` | `<redacted:openai-sk>` |
| `github-pat-classic` | `ghp_[A-Za-z0-9]{20,}` | `<redacted:github-pat-classic>` |
| `github-pat-fine` | `github_pat_[A-Za-z0-9_]{30,}` | `<redacted:github-pat-fine>` |
| `aws-access-key` | `AKIA[0-9A-Z]{16}` | `<redacted:aws-access-key>` |
| `jwt` | `eyJ[...].[...].[...]` 三段式 base64-ish | `<redacted:jwt>` |

实现要点：

- **顺序敏感**：`bearer-header` 必须排在 `openai-sk` / `ghp_` 之前，
  否则 `Bearer ghp_xxx` 会被先按 `ghp_` 匹配一半然后另一半漏出
- **`/g` flag 与 `lastIndex` 陷阱**：所有 pattern 以 `source + flags`
  字符串形式存储，每次调用 `redactSecrets` 都**重新构造** RegExp 对象。
  否则 `/g` regex 的 `lastIndex` 会在多次调用之间累积，导致第二次以后
  漏匹配。这条规则是被 test 抓出来的（`test/workRecap.prompt.test.ts`
  里有 dedicated 用例）。
- **返回值**：`{ redacted, hits }`。`hits` 是命中的规则名数组，**只
  暴露规则类型不暴露原值**——用于 diagnostic 与 metrics

---

## 6. 预算控制（Budget）

定义位置：`src/workRecap/types.ts:215-221`

```ts
export const WORK_RECAP_PROMPT_BUDGET = {
  topProjects: 8,
  commitsPerProject: 15,
  subjectMaxChars: 100,
  totalCharsCap: 12_000,
} as const;
```

四道闸门由内到外串联，任一道触发都会让 `buildPrompt().budgetExceeded`
返回 `true`，service 层会在事实层标 `facts.scanTruncated = true` +
`scanTruncatedReason = "prompt_budget_exceeded"`（参见 `service.ts:130-141`）。

| 闸门 | 触发条件 | 行为 |
|---|---|---|
| `topProjects` | 项目数 > 8 | 只保留 top 8，剩余进 `overflowNote` |
| `commitsPerProject` | 某项目 commit > 15 | 该项目只取前 15 条 |
| `subjectMaxChars` | 单条 subject > 100 字符 | 截断到 99 + `…` |
| `totalCharsCap` | 全 prompt > 12,000 字符 | 从项目段尾截，保留 schema + factsHeader |

最后一道是兜底：即便 top 项目和 commit 数都在限内，长 subject 累加也
可能撑爆 12k 字符上限。截断时 prompt 结尾会自动追加
`…[TRUNCATED FOR PROMPT BUDGET]\nOutput JSON only, ...`。

为什么这个预算定在 12k 字符：

- 12k 字符 ≈ 4k–6k tokens（中英文混合），留下足够空间给 LLM 输出 +
  上下文 padding
- 大多数 provider（DeepSeek / Moonshot / Alibaba / OpenAI）的 chat
  模型上下文 ≥ 16k tokens，12k 输入仍有 ~6k 输出空间
- 实测：30 日窗口 + 8 项目 + 每项目 15 commit + 100 字符 subject ≈
  9k 字符，留有 buffer

---

## 7. Prompt 版本号（Prompt Version）

定义位置：`src/workRecap/types.ts:198`

```ts
export const WORK_RECAP_PROMPT_VERSION = "work-recap@v1";
```

每条 recap 落库时 `prompt_version` 字段会记下当时使用的版本号，UI 也会
在 recap 卡片右上角显示（`生成于 ... · <model> · <promptVersion>`）。

**何时必须 bump：**

| 改动 | 是否 bump |
|---|---|
| 改 `SYSTEM_PROMPT` 文本 | ✅ |
| 改 `SCHEMA_DESCRIPTION` 字段集合 | ✅ |
| 改 `WORK_RECAP_PROMPT_BUDGET` 数字 | ✅（输出会不同） |
| 改 `redactSecrets` 规则 | ✅（影响 LLM 看到的 subject） |
| 改 `buildPrompt` 的字符串模板（factsHeader/projectSection 顺序、字段名） | ✅ |
| 改 `temperature` / `response_format` | ✅ |
| 改 `normalizeResult` 解析逻辑但不影响 prompt 输入 | ❌（同一 prompt 解读不同） |
| 只改注释/重命名变量/重构无输出差异 | ❌ |

命名规则：`work-recap@vN`，N 单调递增整数。**不要**用语义化版本号（如
`v1.2.3`）——这里只关心「输入差异」，二维变化没意义。

约定写法：

```ts
// types.ts
export const WORK_RECAP_PROMPT_VERSION = "work-recap@v2";
```

提交时附带一段 `CHANGELOG` 注释说明 v1 → v2 改了什么、为什么。历史 recap
会保留 `work-recap@v1` 标签，用户切换窗口看历史时仍能识别它们是用旧 prompt
生成的。

---

## 8. LLM 输出的解析与降级

定义位置：`src/workRecap/llm.ts:117-167`（`normalizeResult`）

LLM 返回的 raw content 走完这条管道才变成 `WorkRecapInference`：

```
raw string
  │
  ▼  JSON.parse() → 失败 → throw WorkRecapLlmError("llm_malformed")
  │
parsed object (any shape)
  │
  ▼  normalizeResult():
  │    - summary: 非空字符串 → 截 400 字 / 否则 throw llm_malformed
  │    - workMode: 必须在 5 个枚举内 / 否则 fallback "low_signal"
  │    - workModeReason: 截 80 字 / 缺失 → ""
  │    - nextUp: 数组取前 2 项 × 截 120 字 / 缺失 → []
  │    - fragmentation: 三选一 / 否则 fallback "low"
  │    - degraded + degradeReason: 互相补全
  │
WorkRecapInference (校验后)
  │
  ▼  detectTextFactConflict() ← 关键一步：事实优先铁律
  │
  ├─ 通过 → 返回原文
  └─ 冲突 → 重写为 factual fallback + degraded=true
            + degradeReason="text_fact_conflict"
```

`detectTextFactConflict()`（`llm.ts:99-113`）当前两条规则：

- LLM 声称 `workMode="debug"` 但实际 `feat / totalCommits > 0.7` → 冲突
- LLM 声称 `workMode="build"` 但实际 `fix / totalCommits > 0.6` → 冲突

这两条阈值是经验值，调整时需要重新跑 `test/workRecap.llm.test.ts` 里的
`text_fact_conflict` 用例。**冲突时丢弃 LLM 的整段 summary**，换成
`factualFallbackSummary()` 生成的 deterministic 文本——「事实优先」是
daily-summary.md 第 6.4 节定下的铁律，本功能继承。

---

## 9. 完整示例

### 9.1 一段实际的 user prompt

下面是「7d 窗口 + 2 个项目 + 4 条 commit」场景下，`buildPrompt` 输出的
真实样子：

```
Schema:
{
  "summary": "string (Chinese, <=400 chars, narrative)",
  "workMode": "build|debug|explore|fragmented|low_signal",
  "workModeReason": "string (<=80 chars, one-line explanation)",
  "nextUp": "array of string (1-2 short lines guiding tomorrow's pickup, [] when low signal)",
  "fragmentation": "low|med|high",
  "degraded": "boolean (set true only if you have to abandon inference)",
  "degradeReason": "null|sparse_signal|text_fact_conflict (use sparse_signal when totalCommits<3 or projects all show 1 commit; null otherwise)"
}

Facts:
Window: 7d (7 days, 2026-06-03T10:00:00Z → 2026-06-10T10:00:00Z)
Author email: me@example.com
Repos scanned: 8/10
Total commits: 4, projects: 2
Commit kinds: feat=2, fix=1, docs=1

Projects (top by commit count):
Project: alpha (key=/Users/me/repos/alpha, total=3)
  - feat: add work-recap page
  - feat: prompt budget enforcement
  - fix: handle null in scan timeout
Project: bravo (key=/Users/me/repos/bravo, total=1)
  - docs: README tweak

Output JSON only, no markdown fences, no commentary.
```

### 9.2 LLM 期望的返回

```json
{
  "summary": "本周主要在 alpha 推进 work-recap 页面，包含 prompt 预算的实现和扫描超时 bug 修复。bravo 只动了一行文档。",
  "workMode": "build",
  "workModeReason": "feat=2 + fix=1，集中在一个项目，明显推进而非维护",
  "nextUp": [
    "看看 work-recap 页面的 e2e 是否需要补",
    "若 alpha 这周打算 ship，bravo 可暂缓"
  ],
  "fragmentation": "low",
  "degraded": false,
  "degradeReason": null
}
```

---

## 10. 修改 Prompt 的标准流程

1. **改前先想清楚**：是改语气（System）还是改输出契约（Schema）？前者
   通常不需要联动改动；后者牵涉三处同步
2. **同步三处**（如果改 Schema）：
   - `src/workRecap/prompt.ts SCHEMA_DESCRIPTION`
   - `src/workRecap/types.ts WorkRecapInference`
   - `src/workRecap/llm.ts normalizeResult` + 枚举集合（`WORK_MODES` 等）
3. **bump `WORK_RECAP_PROMPT_VERSION`**（`types.ts`），改写注释说明变更
4. **更新测试**：
   - `test/workRecap.prompt.test.ts`：模板结构、脱敏、预算
   - `test/workRecap.llm.test.ts`：解析 + 降级（含 text_fact_conflict 阈值）
   - `test/workRecap.facts.test.ts`：如果 fact 层结构也变了
5. **跑** `npm test -- workRecap` 确认无 regression
6. **手动验证**：本地起 `ai2nao serve`，访问 `/work-recap`，按窗口生成
   一条 recap，肉眼看 summary 是否符合新约束
7. **历史 recap 兼容性**：旧的 `work-recap@v1` recap 仍能解析（schema
   字段都是 optional/有 fallback），但新 prompt 的输出 UI 上会显示
   新的版本标签，方便用户区分

---

## 11. 不在本文档里的内容

- **事实层算法**：见 `src/workRecap/facts.ts` 注释 + 设计文档
- **降级策略全表**：见 design doc 第 8 节（双层降级 reason code）
- **数据库 schema**：见 `src/store/migrations.ts` `applyV26`
- **HTTP API 契约**：见 `src/workRecap/routes.ts` + design doc Next Steps #10
- **多 provider 适配**：见 `src/workRecap/llm.ts` `chatCompletionsUrl()` +
  `resolveApiKey()`

---

## 12. 参考

- `src/workRecap/prompt.ts` —— 本文档主要描述对象
- `src/workRecap/llm.ts` —— prompt 真正被发送的地方
- `src/workRecap/types.ts` —— `WorkRecapInference` 契约 + budget 常量
- `src/dailySummary/llm.ts` —— 同款工程模式的姐妹实现（Atuin 单日视角）
- `docs/daily-summary.md` —— 第 6.4 节「事实与推断的权力边界」
- `~/.gstack/projects/xunull-ai2nao/<user>-main-design-20260609-190620-work-recap.md`
  —— 完整设计文档（含 12 条前提、降级 reason code 全表、failure modes 表）
