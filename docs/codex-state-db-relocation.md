---
title: Codex State DB 迁移与 ai2nao 的 stale 路径问题
category: 调度与运维
order: 50
---
# Codex State DB 迁移与 ai2nao 的 stale 路径问题

> 本文记录一个真实排查：新版 Codex 把它的 SQLite 数据库挪到了 `~/.codex/sqlite/`
> 子目录，导致 ai2nao 读到过期的旧库，最近几天的 Codex token 用量"消失"。
>
> 排查时间：2026-06-18（/investigate）。修复：`src/codexHistory/paths.ts`。

---

## 1. 症状

`/dashboard/tokens-trend` 上,最近几天只有 Claude 的 token,**完全没有 Codex**,
即使用户一直在用 Codex。

按天分桶的查询显示:Codex 数据在 **6/14 之后断档**,而 Claude 6/15-18 都正常。

```
day         src     tokens        sessions
----------  ------  ------------  --------
2026-06-18  claude  1685529564    4
2026-06-17  claude  1202934546    2
2026-06-16  claude  2371900270    3
2026-06-15  claude  2705745055    6
2026-06-14  codex   195673        1      ← Codex 最后出现的一天
2026-06-13  codex   201522813     2
```

---

## 2. 根因

### Codex 迁移了 SQLite 存储位置

新版 Codex 把它的 SQLite 数据库从 `~/.codex/` 顶层**挪进了 `~/.codex/sqlite/`
子目录**:

```
~/.codex/
├── state_5.sqlite          ← 旧位置(冻结的 stale 快照, 残留没删)
├── sqlite/                 ← 新位置(codex 现在实时写这里)
│   ├── state_5.sqlite      ← 活的 thread 列表
│   ├── logs_2.sqlite
│   ├── memories_1.sqlite
│   ├── goals_1.sqlite
│   └── codex-dev.db
└── sessions/               ← 没动!rollout jsonl 还在这里
    └── 2026/06/.../rollout-*.jsonl
```

**关键:`sessions/` 目录没有迁移**——两个 state DB 里的 `rollout_path` 字段都
仍然指向 `~/.codex/sessions/...`。只有 SQLite 数据库挪了位置。

### ai2nao 读的是旧的 stale 库

ai2nao 通过 `codexStateDbPath()` 定位 Codex 的 thread 列表库,它**硬编码了旧
路径** `~/.codex/state_5.sqlite`。这个旧文件在迁移那一刻起就成了**冻结快照**,
不再随 Codex 使用更新。

### 为什么"token 没丢、只是日期错位"

理解这个 bug 的关键:**ai2nao 的 token 数字是从 rollout jsonl 内容解析的,不依赖
state DB**。state DB 只提供 thread 的**元数据**:`last_updated_at`、`title`、`cwd`。

ai2nao 在 `rowFromUsage` 里这样取 `last_updated_at`:

```ts
last_updated_at: isoOrNull(args.source.lastUpdatedAt) ?? ...
```

`args.source.lastUpdatedAt` 来自 state DB 的 thread 元数据。**旧库冻结在 6/13**,
所以 ai2nao 给所有续用的 session 盖了一个过期的日期戳。

### 触发条件:续用旧 session

用户的"最近几天 Codex 用量"实际上全在**一个 6/11 起始、续用到 6/18 的 session**
里(`019eb4af`)。这个 rollout 文件被不断追加:

```
文件内容最早 timestamp : 2026-06-11T03:17:13
文件内容最新 timestamp : 2026-06-18T09:22:02   ← 一直用到今天
磁盘 mtime             : 2026-06-18 17:22       ← 还在实时增长
```

但 ai2nao 从旧 state DB 拿到的 `last_updated_at` 是 6/13,于是这个 2 亿 token 的
session 被分桶到 6/13,从"最近几天"视图里消失了。

### 决定性证据

同一个 thread `019eb4af` 在两个 DB 里的 `updated_at`:

| | `updated_at` | `tokens_used` |
|---|---|---|
| 旧 `~/.codex/state_5.sqlite`(ai2nao 读的) | **2026-06-13** | 45M |
| 新 `~/.codex/sqlite/state_5.sqlite`(codex 写的) | **2026-06-18** | 199M |

> `tokens_used` 是 Codex 自己的元数据计数,ai2nao 不用它算 token(避免双重口径),
> 但它进一步印证旧库是 stale 的。

---

## 3. 修复

`src/codexHistory/paths.ts:codexStateDbPath` 改成**新路径优先、回退旧路径**:

```ts
export function codexStateDbPath(codexRoot: string): string {
  const relocated = join(codexRoot, "sqlite", "state_5.sqlite");
  if (existsSync(relocated)) return relocated;   // 新路径存在 → 用新的
  return join(codexRoot, "state_5.sqlite");        // 否则 → 回退旧路径(老版兼容)
}
```

- 只改 state DB 路径,**不动 sessions 路径**(`codexSessionsRoot` 保持 `~/.codex/sessions`,
  因为 rollout jsonl 没迁移)。
- 新 DB schema 与旧 DB 兼容:ai2nao 的 `stateDb.ts` 已经读 `updated_at_ms`、
  `created_at_ms` 等列,新旧库都有。

### 为什么是"二选一"而不是"两个都读"

修复采用**新路径存在就只读新库**,旧库完全不读。原因:

1. 新库是 Codex 现在实时写的活库,旧库是迁移残留的冻结快照——应以活库为准。
2. 实测验证:**新库是旧库的严格超集**——旧库 130 个 thread 在新库里全部存在,
   新库还多 1 个(迁移时把旧数据搬进了新库)。所以只读新库不丢任何 thread。

```
旧 DB thread 数: 130
新 DB thread 数: 131
旧有新无       : 0 个(新库是超集)
新有旧无       : 1 个(019ec6cc, 新库独有)
```

### 已知理论边界

只读新库的前提是"Codex 迁移时把旧数据完整搬进了新库"。若未来某个 Codex 版本
迁移不完全(只搬近期 thread、把很老的留在旧库),只读新库会丢掉那部分老历史。
当前机器无此问题,故保持简单方案;真碰到时可改为"两库按 thread id 合并去重
(同 id 取 `updated_at` 更新的一方)"。

---

## 4. 验证

真实库强制 full refresh(用新路径)后,Codex 立刻回到最近几天:

```
day         src     tokens        sessions
----------  ------  ------------  --------
2026-06-18  codex   203616050     1       ← 续用的 session 现在正确归位 6/18
2026-06-18  claude  4141798242    6
2026-06-15  codex   1420662       1       ← 之前冻在 6/14, 现在归位 6/15
```

回归测试 `test/codexHistory.paths.test.ts`:
- 新路径存在 → 返回 `sqlite/state_5.sqlite`
- 新路径不存在 → 回退 `state_5.sqlite`
- 旧代码下该测试 FAIL,新代码 PASS。

---

## 5. 排查复用

如果将来 Codex 数据又"消失"或日期不对,优先怀疑 **Codex 又改了存储位置/格式**。
快速判据:

```bash
# 1. 磁盘上最新的 codex session(看 codex 是否还在写标准位置)
ls -t ~/.codex/sessions/2026/*/*/rollout-*.jsonl | head -3

# 2. 对比某个 thread 在两个 state DB 里的 updated_at
sqlite3 ~/.codex/state_5.sqlite        "SELECT datetime(updated_at_ms/1000,'unixepoch','localtime') FROM threads ORDER BY created_at_ms DESC LIMIT 3;"
sqlite3 ~/.codex/sqlite/state_5.sqlite "SELECT datetime(updated_at_ms/1000,'unixepoch','localtime') FROM threads ORDER BY created_at_ms DESC LIMIT 3;"

# 3. ai2nao 入库的日期 vs jsonl 内容真实最新时间戳
sqlite3 ~/.ai2nao/index.db "SELECT substr(session_id,-12), last_updated_at FROM codex_session_token_usage ORDER BY last_updated_at DESC LIMIT 5;"
```

**核心教训:token 数字从 jsonl 解析(可信),但 session 的"日期/标题/cwd"来自
state DB 元数据。state DB 一旦 stale,token 没丢但会被错误分桶,从时间视图里
"消失"。** 排查"数据消失"类问题,先分清是"数据没采到"还是"采到了但元数据
(日期)错位"。

> **后续(2026-06-18):这个 state-DB 修复之后数据仍不对——只剩 6/18 有 Codex。**
> 那是**第二个、独立的 bug**:本修复只把"折叠点"从 6/13 挪到了 6/18,没解决
> "折叠"本身。一个从 6/11 续用到 6/18 的 session,它一周的 token 仍被整块记到
> `last_updated_at`(6/18)那一天。根因:`codex_session_token_usage` 每 session
> 一行、单个日期。修复见
> [`docs/codex-token-daily-bucketing.md`](codex-token-daily-bucketing.md):按
> `token_count` 事件时间戳逐天归属(新表 `codex_token_usage_event`)。

---

## 6. 相关文件

- `src/codexHistory/paths.ts` — `codexStateDbPath`(本次修复)
- `src/codexHistory/stateDb.ts` — 读 thread 列表 + 元数据
- `src/codexTokenUsage/refresh.ts` — `rowFromUsage` 取 `last_updated_at`
- `test/codexHistory.paths.test.ts` — 回归测试
- [`docs/session-token-fields.md`](session-token-fields.md) — Codex/Claude token 字段参考
- [`docs/token-usage-pipeline.md`](token-usage-pipeline.md) — token 计算管线
