---
title: Codex State DB 路径变迁时间线（新路径 → 回切老路径）
category: 调度与运维
order: 51
---
# Codex State DB 路径变迁时间线（新路径 → 回切老路径）

> Codex 的 SQLite 状态库在两个位置之间来回横跳：先从顶层 `~/.codex/` 迁进
> `~/.codex/sqlite/` 子目录（新路径），过几天又切回顶层（老路径）。本文用真实
> 磁盘时间戳 + 线程数据，把"什么时候用了新路径、什么时候又切回老路径"钉死。
>
> 排查时间：2026-06-30（/investigate）。相关代码：`src/codexHistory/paths.ts`。
> 前篇：[`codex-state-db-relocation.md`](codex-state-db-relocation.md)（2026-06-18
> 迁入新路径那次）。

---

## 0. 结论速览

| 阶段 | 时间 | 活跃写入的库 | 证据锚点 |
|---|---|---|---|
| ① 只有老路径 | 2026-06-13 之前 | `~/.codex/state_5.sqlite` | 顶层库 birth 2026-04-08 |
| ② **切到新路径** | **2026-06-13 16:18:49 起** | `~/.codex/sqlite/state_5.sqlite` | `sqlite/` 下 4 个库文件同一刻诞生 |
| ③ **切回老路径** | **2026-06-20（约 11:57）起** | `~/.codex/state_5.sqlite` | 第一条"只进老库"的线程 2026-06-20 11:57:58 |

新路径（`~/.codex/sqlite/`）真正当家的窗口大约是 **2026-06-13 → 2026-06-19/20，
一周左右**；之后 Codex 把活跃写入又搬回了顶层老路径，至今（2026-06-30）未变。

> 关键：**`sessions/` 目录从未迁移**。两个 state DB 里的 `rollout_path` 始终指向
> `~/.codex/sessions/...`。来回横跳的只有 SQLite 状态库的存放位置。

---

## 1. ② 何时用了新路径：2026-06-13 16:18:49

`~/.codex/sqlite/` 子目录下的库文件**全部诞生于同一刻**——这就是 Codex 把
SQLite 库搬进新路径的时刻：

```
birth=2026-06-13 16:18:49  ~/.codex/sqlite/state_5.sqlite
birth=2026-06-13 16:18:49  ~/.codex/sqlite/logs_2.sqlite
birth=2026-06-13 16:18:49  ~/.codex/sqlite/goals_1.sqlite
birth=2026-06-13 16:18:49  ~/.codex/sqlite/memories_1.sqlite
```

对照顶层老库的诞生时间，老库早就存在，新库是 6-13 才被创建出来的：

```
birth=2026-04-08 10:07:17  ~/.codex/state_5.sqlite        ← 老库，4 月就有
birth=2026-06-13 16:18:49  ~/.codex/sqlite/state_5.sqlite ← 新库，6-13 才创建
```

创建时 Codex 把老库的历史一并搬进了新库（新库一上来就含 6-13 之前的全部线程），
随后开始实时写新库、冷落老库。**2026-06-18 那次排查**（见前篇）正是抓到这个状态：
顶层老库冻结、`sqlite/` 新库在涨，于是 ai2nao 当时改成"新路径优先"。

新路径当家的决定性证据——**2026-06-19 当天，唯一被更新的线程进的是新库，老库当天
零更新**：

```
日期           | 顶层老库 | sqlite 新库
-------------|--------|----------
2026-06-19   |   ·    |    1      ← 只有新库在写
```

而这条 06-19 的线程，其 id 在老库里也存在、但 `updated_at` 是 06-20 之后（说明这条
对话 06-20 才被续聊、更新写回了老库）。反向坐实：**06-19 当天活跃写入的是新路径。**

---

## 2. ③ 何时切回老路径：2026-06-20（约 11:57）

从 2026-06-20 起，所有新线程只进顶层老库，新库再没涨过。用"线程 id 只存在于哪一边"
切分两库，边界一刀切得很干净：

```
新库（sqlite/）独有线程 : 0    ← 新库没有任何老库缺的线程
老库（顶层）  独有线程 : 36   ← 全是 06-20 之后的新内容
两库共有线程          : 131
```

老库是新库的**严格超集**。那 36 条老库独有线程里，**最早一条的时间就是回切起点**：

```
2026-06-20 11:57:58   ← 第一条只进老库的线程 = 回切老路径的起点
2026-06-22 15:00:13
2026-06-23 16:21:20
...
2026-06-29 22:34:26   ← 至今仍在写老库
```

各个 `sqlite/` 新库副本的"冻结时刻"（最后一次被写）也都落在这个窗口、随后再无更新
（这些 mtime 干净，未被本次排查的只读查询污染）：

```
mtime=2026-06-17 09:56:45  ~/.codex/sqlite/memories_1.sqlite   ← 最先冻
mtime=2026-06-19 14:35:56  ~/.codex/sqlite/goals_1.sqlite
mtime=2026-06-20 11:47:14  ~/.codex/sqlite/logs_2.sqlite       ← 最后冻
（state_5 新库的最后线程 updated_at = 2026-06-19 14:16:33）
```

不同库回切的时刻略有先后（memories 06-17、goals/state_5 06-19、logs 06-20），整体
回切窗口收敛在 **2026-06-19 ～ 06-20**。state_5（ai2nao 读的线程列表库）的回切点，
卡在新库最后写入 06-19 14:16 与第一条老库独有线程 06-20 11:57 之间。

---

## 3. 当前状态（2026-06-30 实测）

```
                              线程数   最新线程              角色
~/.codex/state_5.sqlite        167     2026-06-29 22:34:26   ← live（老路径，现在当家）
~/.codex/sqlite/state_5.sqlite 131     2026-06-19 14:16:33   ← 冻结（新路径，06-19 后没动）
```

差的 36 条正是 6-19 之后这十天的会话。Codex 版本 `0.142.3`（`~/.codex/version.json`，
last_checked 2026-06-28）。

---

## 4. 对 ai2nao 的影响（两次反向打脸）

`codexStateDbPath()`（`src/codexHistory/paths.ts`）一处解析，同时供
codex-history 列表、`codexTokenUsage`、`workDuration` 三处使用。它被这次横跳来回坑了两次：

1. **2026-06-18**：老库变 stale，于是改成"`sqlite/` 存在就优先"（前篇文档）。当时对。
2. **2026-06-30**：Codex 切回老库后，"优先 `sqlite/`"反而锁死读了 06-19 冻结的新库，
   **6-19 之后的会话在 codex-history 页面全部消失**。

第二次的修复不再赌固定位置，而是**两库都在时按写入新鲜度（主文件 + `-wal` 的 mtime，
排除只读连接也会触碰的 `-shm`）选最新的那个**，对 Codex 以后再来回横跳免疫：

```ts
// src/codexHistory/paths.ts
export function codexStateDbPath(codexRoot: string): string {
  const relocated = join(codexRoot, "sqlite", "state_5.sqlite");
  const legacy = join(codexRoot, "state_5.sqlite");
  const hasRelocated = existsSync(relocated);
  const hasLegacy = existsSync(legacy);
  if (hasRelocated && hasLegacy) {
    return dbFreshnessMs(relocated) >= dbFreshnessMs(legacy) ? relocated : legacy;
  }
  if (hasRelocated) return relocated;
  return legacy;
}
```

回归测试见 `test/codexHistory.paths.test.ts`（含"两库都在、老库更新→选老库"的 06-20
回切用例，及"冻结库的 `-shm` 被读触碰也不能赢"的用例）。

---

## 5. 只读一个库为什么不丢数据：冻结库是 live 库的子集

代码只读"当下在被写"的那一个库（`codexStateDbPath` 是**二选一，不合并两库**），却不丢
数据，靠的是一个实测成立的前提：**冷的那个库永远是热库的子集**。

2026-06-30 实测，按 thread id 分叉两库：

```
代码现在读的【顶层 live 库】总线程    : 167
没读的【sqlite/ 冻结库】总线程        : 131
冻结库里【独有、live 库没有】的线程   : 0     ← 关键：冷库没有任何热库缺的线程
live 库里【独有、冻结库没有】的线程   : 36    ← 全是 06-20 之后的新内容
两库共有                              : 131
```

**冻结库的 131 条全部包含在 live 库的 167 条里**，所以只读 live 库一条不丢——"没读的另一个
库"的内容，本就一条不少地存在于我们读的这个库里，并没有被丢弃。

成因：Codex 06-13 迁移时把老库内容**整个拷进**了新库；06-20 切回顶层时，那些还在用的对话
被续聊、又写回了顶层库。一来一回，冷库的线程都"流"进了现在这个 live 库，没有留在冷库里的
孤儿线程。

### 已知理论边界

"二选一"的正确性依赖"冷库 ⊆ 热库"这个前提，它**实测成立、但非数学保证**。极端情况：某条
对话只在某库当家期间创建、之后再没被续聊，它就只存在于那个后来变冷的库里——单选热库会漏掉
它。当前机器无此孤儿线程（上面那条 `独有 = 0`），故保持简单的二选一方案；真哪天测到冷库
出现独有线程（见 §6 的分叉查询），再升级为"两库按 thread id 合并去重（同 id 取 `updated_at`
更新的一方）"不迟。

---

## 6. 复用：怎么再判一次"Codex 又换路径了"

```bash
# 1. 两个 state_5 各自的最新线程时间——谁新谁在当家
for db in ~/.codex/state_5.sqlite ~/.codex/sqlite/state_5.sqlite; do
  echo "$db"
  sqlite3 "$db" "SELECT COUNT(*), datetime(MAX(COALESCE(updated_at_ms/1000,updated_at)),'unixepoch','localtime') FROM threads;"
done

# 2. 文件诞生/冻结时间（birth=何时建的新副本，mtime=何时最后写）
stat -f 'birth=%SB  mtime=%Sm  %N' -t '%Y-%m-%d %H:%M:%S' \
  ~/.codex/state_5.sqlite ~/.codex/sqlite/state_5.sqlite

# 3. 两库线程 id 分叉：谁独有 = 谁是当下活跃写入方
sqlite3 ~/.codex/state_5.sqlite \
  "SELECT COUNT(*) FROM threads WHERE id NOT IN (SELECT id FROM aux.threads)" \
  -cmd "ATTACH '$HOME/.codex/sqlite/state_5.sqlite' AS aux"
```

**核心教训：别赌固定路径。** Codex 会把它的 SQLite 库在 `~/.codex/` 与
`~/.codex/sqlite/` 之间来回搬，任何一边都可能在某段时间变成冻结快照。判"哪个是活库"
要看**写入新鲜度**，而且只认写方会动的信号（主文件 / `-wal`），别认只读连接也会触碰的
`-shm`。

---

## 7. 相关文件

- `src/codexHistory/paths.ts` — `codexStateDbPath` / `dbFreshnessMs`（按新鲜度选库）
- `test/codexHistory.paths.test.ts` — 回归测试
- [`codex-state-db-relocation.md`](codex-state-db-relocation.md) — 前篇：2026-06-18 迁入新路径那次
- [`codex-token-daily-bucketing.md`](codex-token-daily-bucketing.md) — 同期 token 分桶问题
- [`session-token-fields.md`](session-token-fields.md) — Codex/Claude token 字段参考
