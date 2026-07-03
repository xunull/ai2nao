# Agent 用户消息统一库（agent_user_messages）设计文档

> 状态：**已实现并验证**（office-hours → plan-eng-review 2026-07-03 → 实现 2026-07-03）。
> v1（opencode）+ v1.1（claude/codex adapter + analytics）全部落地,三源真实数据验证:
> opencode 1050 行、claude 21078 行、codex 2281 行入库可搜;980 测试全绿、web 出包。
> **口径统一(option C)**:claude/codex 的「我说的」清洗从前端 `web/src/lib/*` 迁到后端
> (`src/{claudeCodeHistory,codexHistory}/myMessages.ts`),抽屉改调后端 my-messages 端点、
> 前端清洗器已删,ingest 与抽屉共用同一份后端 cleaner。schema/口径以下列**最终决策**为准。

## 1. 背景与目标

把所有 AI agent 会话里**用户自己发送的消息**抽出来，汇到一张可查询的表，标明来源与时间。两个并列主用途（用户拍板）：

1. **全文搜索** —— 跨所有 agent 搜「我两周前问过的那句」。
2. **输入分析/统计** —— 我最常问什么、每天/每周输入量、跨工具对比（v1.1）。

一个反直觉但重要的前提：这些日志里 `role=user` 的轮**大部分不是人打的**（`<system-reminder>`、IDE `editor_context` 注入、斜杠命令展开、后台任务通知；opencode 实测这类占「user 文本」约 71%）。所以「提取用户消息」的真正难点是**口径**，不是建表。

## 2. 现状盘点（为什么这是「汇聚」而非「从零造」）

| 来源 | 现在怎么存 | 「我说的」口径逻辑 |
|---|---|---|
| Claude Code | 读时扫 `~/.claude` jsonl（`claudeCodeHistory`），**不进 index.db** | `normalize.ts` + 抽屉「只看我说的」 |
| Codex | 读时读 Codex 自己的 sqlite/jsonl（`codexHistory`），**不进 index.db** | `normalize.ts` + 抽屉 |
| OpenCode | 读时读 opencode 自己的 sqlite（`opencodeHistory`），**不进 index.db** | `myMessages.ts` 的 `cleanOpencodeUserMessageParts()`（best-effort 注入清洗） |
| Cursor | **已镜像进 index.db**（`cursorHistory/storage.ts`） | — |
| Cherry Studio | 读时读 indexedDB | — |
| ai2nao 内置 AI Studio | `llm_chat_messages`（已在 index.db） | 原生干净 |

三大 agent 目前都是**读时**、且互不相通。本功能 = 为它们建一份**持久、可搜、可统计**的镜像。Cursor 已开「镜像外部源进库」的先例。

## 3. 最终决策（已锁）

| # | 决策 | 说明 | 来源 |
|---|---|---|---|
| D1 | **物化 + FTS5** | 读时 union 出局。 | office-hours |
| D2/D5 | **三轨 + 可重清洗** | 每行 `raw_text` + `raw_payload_json`（**完整原始 part**，用于重清洗）+ `cleaned_text` + `is_human` + `cleaner_version` + `parser_version`。 | office-hours |
| D3 | **FTS = 独立 fts5** | `USING fts5(cleaned_text, source/event_at UNINDEXED, tokenize='trigram')` + 手动同步 + `AFTER DELETE` 触发器。匹配 `manifest_fts`/`rag_chunks_fts`，**非** external-content。 | eng-review |
| D4 | **分词 = trigram + LIKE 兜底** | 查询长度按**码点** `[...q].length`；<3 码点走 `LIKE` 兜底（2 字中文词）。混合查询按 run 分段。`unicode61` 排除（对中文失效）。 | eng-review |
| D5 | **共享 extractor** | `extractOpencodeUserMessage(rawMsg, rawParts)` 收**原始** part、**内含 `role==='user'` 门**，产出 `{rawText, rawPayloadJson, cleanedText, isHuman}`；抽屉（`load.ts`）改用它，不再预解析。 | eng-review |
| D6 | **payload 不设 per-part 上限** | 按真内容存（个人工具 SQLite 存几 MB TEXT 无压力）。上限会让 `cleaner(payload)≠cleaned_text`、砸掉可重清洗。 | 外部声音#4 |
| D7 | **孤儿留底 = 从不删** | 源消失的行**保留**。v1 **不设 `missing_since`**（增量 watermark 看不到水位之下的删除，检测形同虚设；周期性 id 对账留 TODO）。 | 外部声音#3 |
| D8 | **只存 `event_at_utc`** | **不存 `local_day`**（bucket.ts 是查询时机器 localtime，存日串会多一个真相源、TZ 漂移）。分桶留 v1.1 用 `bucketExpr` 查询时算。 | 外部声音#8 |
| D9 | **watermark = `>=` on 列** | `message.time_created` 列、`>=`（幂等 upsert 下重处理并列免费，避免边界丢）。**分批提交 + 逐批推水位**，绝不单个大事务。 | 外部声音#1/#7 |
| D10 | **重清洗回填 = 逐行 DELETE+INSERT fts** | 独立 fts5 下 `'rebuild'` 只重 tokenize 影子副本、捡不到新 `cleaned_text`；改逐行 `DELETE FROM fts WHERE rowid=?; INSERT…`。 | 外部声音#2 |
| — | **新 `applyV42`** | `CURRENT_VERSION 41→42`，前向、不改旧 applyVNN。 | office-hours |
| — | **v1 范围** | 只 opencode，全切片。claude/codex + analytics = v1.1。 | office-hours |

## 4. 数据模型

```sql
-- 主表
CREATE TABLE agent_user_messages (
  id                 INTEGER PRIMARY KEY,
  source             TEXT NOT NULL CHECK (source IN ('claude','codex','opencode')),
  source_session_id  TEXT NOT NULL,      -- opencode: message.session_id
  source_message_key TEXT NOT NULL,      -- opencode: message.id
  project            TEXT,               -- opencode: session.project_id / directory
  event_at_utc       TEXT NOT NULL,      -- ISO8601 UTC，消息自身时间（见 D8：不存 local_day）
  raw_text           TEXT NOT NULL,      -- 逐字拼接的 text part（不截断，见 D6）
  raw_payload_json   TEXT NOT NULL,      -- 完整原始 part 记录 JSON（无 per-part 上限，D6）
  cleaned_text       TEXT NOT NULL,      -- 清洗后；纯注入时为 ''
  is_human           INTEGER NOT NULL,   -- cleaned_text 非空 => 1
  char_len           INTEGER NOT NULL,   -- length(cleaned_text)，统计用
  cleaner_version    INTEGER NOT NULL,   -- bump => 从 payload 重算 cleaned/is_human（D10 回填）
  parser_version     INTEGER NOT NULL,   -- bump => 源仍在则从源重解析
  source_path        TEXT,               -- 溯源（opencode.db 路径等）
  source_seen_at     TEXT NOT NULL,      -- 最近一次 ingest 在源里见到本行
  ingested_at        TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (source, source_session_id, source_message_key)
);
CREATE INDEX idx_aum_source_event ON agent_user_messages(source, event_at_utc);

-- 全文索引（独立 fts5，D3；trigram，D4）
CREATE VIRTUAL TABLE agent_user_messages_fts USING fts5(
  cleaned_text,
  source UNINDEXED,
  event_at_utc UNINDEXED,
  tokenize = 'trigram'
);
-- 同步：ingest/回填时手动 INSERT（rowid = 主表 id）；主表删除时触发器清 fts。
CREATE TRIGGER agent_user_messages_ad_fts AFTER DELETE ON agent_user_messages BEGIN
  DELETE FROM agent_user_messages_fts WHERE rowid = old.id;
END;

-- 增量水位
CREATE TABLE agent_user_messages_sync_state (
  source        TEXT PRIMARY KEY,
  watermark_ms  INTEGER,        -- opencode: 已 ingest 的 max message.time_created（D9：>= 过滤）
  last_run_at   TEXT,
  last_status   TEXT,
  last_error    TEXT
);
```

FTS 与主表**同事务**同步（手动 `INSERT`/`DELETE` by rowid）。`cleaner_version` 回填走 **逐行 DELETE+INSERT**（D10），不用 `'rebuild'`。

### 4.1 每源自然 key
- **OpenCode（v1）**：`source_session_id = message.session_id`；`source_message_key = message.id`；`event_at_utc` 来自 `message.time_created` **列**（ms→ISO；D9：watermark 也用此列，别跨 `data.time.created` 时钟）。
- **Claude（v1.1）**：`source_message_key = record.uuid`（落地确认）；无 uuid 退 `L<line>:sha256`。
- **Codex（v1.1）**：`source_message_key = response_item:user:L<line>` + `sha256(body)`。

## 5. 口径（cleaner）

- 单一真相：`extractOpencodeUserMessage(rawMsg: OpencodeRawMessage, rawParts: OpencodeRawPart[])`（D5）——收**原始** part（不是抽屉现在传的 `ParsedPart[]`）、**内含 `role==='user'` 门**、内部解析 + 清洗 + 组装，产出 `{rawText, rawPayloadJson, cleanedText, isHuman}`。
- 内部清洗复用 `cleanOpencodeUserMessageParts`（`myMessages.ts`），原则「**误删 > 漏删**」。
- 抽屉（`opencodeHistory/load.ts:182–202`）**改调** `extractOpencodeUserMessage`、停止预解析——口径与组装、role 门全一份。
- 模块级 `CLEANER_VERSION` 常量；改清洗必 bump（有 pin 测试逼出有意识版本升）。
- `is_human = cleaned_text.trim().length > 0`。纯注入行照样入库（raw 留底、可重清洗恢复），`is_human=0`、`cleaned_text=''`，不进 FTS、不计入「我的输入量」。

## 6. 摄取（ingestion）

1. scheduler 任务 `agent_user_messages.opencode.sync`（仿 `taskDefinitions.ts` 的 local 扫描任务，本地源常开、无 key/opt-in）。
2. 读 `watermark_ms`，取 `message.time_created >= watermark` 的会话/消息（D9）。
3. 每条 user message：`extractOpencodeUserMessage` → raw/payload/cleaned/is_human；算 keys + `event_at_utc`。
4. **分批**幂等 upsert（`ON CONFLICT DO UPDATE`）+ 同事务 FTS 同步；**每批 commit 后推进 `watermark_ms`**（D9：绝不把 3.46GB 首轮塞进单事务）。
5. 更新 `source_seen_at`。**不做 missing_since 删除检测**（D7）。
6. 部分失败：该批不推 watermark、无半写；下轮重扫（幂等安全）。

## 7. 风险与开放问题（评审后）

1. **中文分词落地细节（已定 D4）**：`trigram` + `LIKE` 兜底,查询长度按**码点** `[...q].length`（`登录`=2 码点但 6 UTF-8 字节,按字节判会误走 trigram → 0 命中）。混合查询「登录 bug」按 run 分段（CJK run <3 码点走 LIKE,其余 trigram）。LIKE 兜底是 `cleaned_text` 全表扫,v1 opencode 量级 OK,claude/codex/analytics 放大行数前复审。
2. **首次全量回填（已定 D9）**：分批提交 + 逐批推水位,不锁库。
3. **claude/codex 共享 cleaner（v1.1）**：它们的「只看我说的」现埋在各自 `normalize.ts`,要先抽成共享 cleaner（opencode 已抽好,故先行）。
4. **源删除检测（推 TODO）**：v1 去 `missing_since`；周期性全 id 对账 sweep 记 TODOS（P3）。

## 8. API + UI（v1）

- `GET /api/agent-user-messages/search?q=&source=&from=&to=&limit=` → 按 D4 路由（trigram / LIKE 兜底），返回 `{id, source, session_id, event_at_utc, snippet}`。
- `GET /api/agent-user-messages/:id/raw` → 审计：`raw_text` + `raw_payload_json`。
- 极简搜索页：搜索框 + 来源筛选 + 时间范围 + 结果列表（片段 + 「查看原文」）。PC 端、**无横向滚动条**（项目硬规 + prior learning `grid-flex-minwidth-auto-hscroll`：长 font-mono 路径加 `min-w-0`）。
- **analytics（v1.1）**：同表按 `event_at_utc` 查询时 `bucketExpr` 分桶（D8）+ `char_len`/`is_human` 聚合。

## 9. 落地里程碑（方案 A：OpenCode 先行全切片）

| # | 任务 | 验证 |
|---|---|---|
| T0 | 分词器手测:3 个真实中文查询在 opencode.db 上验 trigram+LIKE 命中 | 命中质量达标再铺后面 |
| T1 | `applyV42`:主表+FTS(trigram)+触发器+sync_state。`41→42`,fresh+incremental,**不改旧 applyVNN** | 全新库 v42、老库自愈到 v42 |
| T2 | `extractOpencodeUserMessage(rawMsg, rawParts)`(收原始 part、含 role 门);`CLEANER_VERSION`;抽屉 `load.ts` 改调它 | 抽屉 cleaned === extractor cleaned(同函数) |
| T3 | `src/agentUserMessages/opencode.ts` ingest:分批幂等 upsert + 同事务 FTS + `>=` watermark 逐批推进 | 幂等、迟到回填、watermark 边界、事务中断安全 |
| T4 | scheduler `agent_user_messages.opencode.sync`(常开、无 key) | 拉真实 opencode 数据;db 缺失/锁 → 干净跳过 |
| T5 | search 查询(D4 路由)+ route + raw 审计 route | 中文≥3字 trigram、2字 LIKE 兜底、来源/时间过滤、is_human=0 不浮现 |
| T6 | 极简搜索页 | 搜真实中文、查看原文、无横向滚动条 |
| T7 | `cleaner_version` 回填:落后行从 payload 重算 + **逐行 DELETE+INSERT fts**(D10) | bump 后重算 + FTS 一致 |
| T8 | 测试补齐 | 见 §测试(下) |
| ✅ | **v1.1(已完成)**:claude adapter、codex adapter(event_msg 双重门)、analytics(跨源计数 + 本地日 bucketExpr 分桶)、清洗器统一到后端(option C) | 三源真实数据入库可搜、980 测试绿 |
| — | **v2(可选)**:cleaned 喂 rag/workCosmos 混合检索,加语义搜 | — |

### 测试要点（比初版 T8 多出的必加项）
- **重清洗往返**:payload 能重现 `cleanOpencodeUserMessageParts`(证明 D5/D6;无上限后大消息也成立)。
- **CLEANER_VERSION pin**:改清洗不 bump 版本 → 测试挂。
- **中文 2 字 LIKE 兜底**(按码点)、**幂等**、**watermark `>=` 边界**、**missing→留而不删**、**applyV42 自愈**、**抽屉/ingest parity**、**db 锁/缺失干净跳过**、**搜索页无横向滚动条**。

## 10. 非目标 / 推后
- claude/codex 源、analytics(v1.1);Cursor、Cherry、内置 llm_chat;语义/向量搜索(v2);成本/token(N/A)。
- **周期性全 id 对账 sweep(源删除检测)** —— TODOS P3(外部声音#3 推后)。
- 分发/CI:N/A(应用内特性)。

## The Assignment（写代码前的一个真实动作）
T0 分词器手测:拿最近真想搜的 **3 个中文查询**,在 opencode.db 真实历史文本上手建临时 trigram FTS + LIKE 兜底,验命中质量,再写 `applyV42`。

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | clean | 12 issues (3 arch + 1 code-quality + 8 outside-voice), all folded; test 覆盖图 ~30 路径(greenfield) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** 外部声音 codex 5 分钟超时 → 回退 Claude 独立子代理,8 findings 全部对代码核实成立、全折入 plan。
**CROSS-MODEL:** office-hours codex 冷读(raw_payload 结构化)+ eng-review Claude 复审(8 findings)两轮都硬化了设计;无遗留 tension —— 每条外部声音要么采纳、要么有意识地缩范围(missing_since/payload cap/local_day)。
**VERDICT:** ENG CLEARED —— 可实现(v1 opencode 切片)。

NO UNRESOLVED DECISIONS
