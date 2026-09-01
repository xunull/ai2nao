---
title: 五个 Agent 的会话记录本地保留期横向调查
category: 数据源与同步
order: 84
---
# 五个 Agent 的会话记录本地保留期横向调查

调查日期 2026-08-31。对象是 ai2nao 已接入或已装在本机的五个编码 agent：
**Claude Code / Codex CLI / Kimi Code / opencode / Hermes Agent**。

问的问题只有一个：**它们会不会自己把旧的会话记录删掉？多久删？**

这件事对 ai2nao 是地基性的 —— ai2nao 的全部数据都来自读这些 agent 留在本地的
文件或库。**上游删了，我们没抓到，那段历史就永久没有了**，不是「以后再补采」
能解决的。

## 结论

| Agent | 版本 | 存储形态 | 自动删除 | 期限 | 判据强度 |
|---|---|---|---|---|---|
| **Claude Code** | 2.1.251 | 每会话一个 `.jsonl` | **会** | **30 天**（`cleanupPeriodDays`） | 强：官方文案 + 实测零重叠 |
| Codex CLI | 0.144.4 | 每会话一个 `.jsonl` | 不会 | — | 强：129 天前的文件仍在 |
| opencode | 1.18.25 | 单个 SQLite 库 | 不会 | — | 强：127 天前的会话仍在 |
| Hermes Agent | 0.20.6 | 单个 SQLite 库 | 不会 | — | 强：可读源码，无按龄清理 |
| Kimi Code | 0.39.1 | 每会话一个 `.jsonl` | 无证据 | — | **弱：观察窗口只有 33 天** |

**五个里只有 Claude Code 会自动删。** 其余四个在本机的观察范围内一条都没少。

Kimi 那一行要特别小心：本机 kimi 数据最老只有 33 天，**比任何一个常见的保留期
都短**，所以「没观察到删除」并不能推出「不删除」。见下文。

## Claude Code：30 天，但删的是「文件」不是「消息」

### 机制

设置项是 `cleanupPeriodDays`。以下是从本机安装的 2.1.251 二进制里直接提取的原文：

```
`cleanupPeriodDays`: Days to keep transcripts before automatic cleanup
                     (default: 30; minimum 1)

cleanupPeriodDays must be at least 1. To keep transcripts for a long time,
set a large number (e.g. 3650 for ~10 years). To disable transcript writes
entirely, remove this setting and use the --no-session-persistence CLI flag
or the SDK persistSession:false option.
```

该字符串在二进制里出现 25 次。另有一个独立的 `desktopSessionCleanupPeriodDays`
（桌面端会话，本文未展开）。

未在 `~/.claude/settings.json` 里设置时走默认 **30 天**。

### 实测：一刀切，零重叠

拿 ai2nao 的 `claude_session_token_usage`，按 `missing_since` 分组，
看**文件 mtime** 距今的天数：

```
状态     会话数   mtime 最年轻   mtime 最老
在         93        0 天          29 天
没了      143       30 天         113 天
```

边界逐日展开是 07-30 全没、08-01 全没、08-02 全在，**没有一条越界**。
`missing_since` 的检测日期也是每天 2–14 条的持续滴漏，
正是滚动窗口的形状，不是某一次批量清理。

### 关键细节一：期限算的是文件 mtime，不是消息时间

同一批数据换成按**消息时间**（`ended_at`）看，「存活」组里有 92 天前结束的会话：

```
按 ended_at（消息时间）看存活的会话：
  开始        结束        距今    文件 mtime
  2026-05-30  2026-05-31   92 天  2026-08-27   ← 文件是新的
  2026-06-02  2026-06-02   90 天  2026-08-27
  2026-05-31  2026-06-12   80 天  2026-08-27
```

这不矛盾：**清理看的是文件有多久没被写过。** 一个反复 `--resume` 的长会话，
文件 mtime 一直是新的，于是它里面 92 天前的消息也跟着活下来。

所以「保留 30 天」的准确说法是 **「会话文件闲置满 30 天就删」**，
不是「消息超过 30 天就删」。

### 关键细节二：只清顶层，不清 subagent 产物

`~/.claude/projects/` 下有两种 `.jsonl`，清理只覆盖第一种：

```
                                              总数   超30天   最老
顶层会话记录  <project>/<uuid>.jsonl            93      0     29 天
嵌套产物      <project>/<uuid>/subagents/...   652    235     92 天
```

嵌套那层是 subagent 与 workflow 的 journal
（`subagents/workflows/wf_*/journal.jsonl`、`subagents/agent-*.jsonl`）。
**它们的父会话记录早已被删，自己却留着** —— 本机 235 个、19.8 MB，最老 92 天。

这是上游的一个泄漏：会话正文被清掉后，属于它的 subagent 产物变成没有主人的孤儿，
且不再受任何清理约束。量不大（19.8 MB vs 整个 projects 目录 637 MB），
但会随 workflow 用量单向增长。

### 已删的是真删了，不是移走了

抽 5 个 ai2nao 标记为消失的会话，拿其 UUID 在整个 `projects` 树里全盘搜索，
**5 个全部 0 命中**。排除了「目录改名导致误判」这种可能。

## Codex CLI：不自动删，只有手动命令

- 二进制里搜 `cleanup / retention / expire / prune / max_age` 等关键词，
  命中的全是连接清理、TLS、sudo 超时之类，**没有任何会话保留期设置**。
- 有一个**手动**子命令：

  ```
  codex delete <SESSION>
      Permanently delete a saved session by id or session name
  ```

- 实测：`~/.codex/sessions` 下 362 个 `.jsonl`，其中 **80 个超过 100 天没动过**，
  最老 129 天，全部健在。`~/.codex` 目录 **29 GB**。
- ai2nao 侧 362 场在 / 4 场消失。那 4 场的原因未查
  —— 手动 `codex delete` 是一种可能，但没有证据，不作断言。

## opencode：不自动删

- 存储是单个 SQLite（`~/.local/share/opencode/opencode.db`，**3.2 GB**），
  不是每会话一个文件。
- 二进制里搜 `cleanupPeriod / retentionDays / sessionRetention / autoDelete /
  pruneSessions / deleteOlderThan`，**零命中**。
- 实测：ai2nao 侧 **964 场全部在，0 场消失**，最老 127 天。

> 注意判据的性质不同：opencode 是「库里的行还在」，
> 不是「文件还在」。如果上游做的是行级删除，ai2nao 一样看得见 —— 但目前没有。

## Hermes Agent：不自动删（源码可读，判据最硬）

Hermes 是 Python，装在本机后源码直接可读，所以这一条的证据质量高于其余四个。

- 存储是单个 SQLite（`~/.hermes/state.db`，17 MB），
  带 FTS5 全文索引，表是 `sessions` / `messages`。
- 全仓搜 `DELETE FROM messages|sessions`，命中的删除只有三类：
  1. **空会话清理** —— 无消息、无标题、无子会话的会话在退出时删掉，
     避免 `/resume` 列表被「开了就退」的空壳刷屏（注释注明借鉴自 gemini-cli）
  2. **delegate 子会话级联** —— 删父会话时连带删子 agent 的记录
  3. **用户显式删除**
- **没有任何按年龄/天数的清理。**
- 实测：120 场会话 / 1537 条消息，最早 2026-04-27，**126 天前的消息仍在库里**。

## Kimi Code：无证据，但也无法断言「不删」

- 存储是 `~/.kimi-code/sessions/<wd_*>/<session_*>/agents/<main|agent-N>/wire.jsonl`，
  共 155 MB。
- 二进制（172 MB）里搜保留期关键词，只命中 `autoCleanup` /
  `autoCleanupIncoming` —— 读上下文是 **HTTP 请求流的清理**，与会话记录无关。
- 实测：68 个 `wire.jsonl`，**最老只有 33 天**；ai2nao 侧 32 场全在，最老 40 天。

**这就是问题所在。** 本机最早的 kimi 数据是 2026-07-22
（对应 kimi 从桌面版切到 CLI 的时间点），到今天只有 40 天。
一个 30 天的保留期会在这个窗口里露出马脚，但 **60 天、90 天的保留期不会**。

所以正确的结论是「**在 33 天的窗口内没有观察到删除**」，
而不是「kimi 不删」。要定论，得等数据自然长到 90 天以上再复测。

## 对 ai2nao 的影响

1. **只有 claude 这一路存在「上游先删、我们没抓到」的风险**，
   其余四个可以按「历史随时可回溯」来设计。

2. **claude 的采集必须假定源文件会消失。** 目前 61%（143/236）的 claude 会话
   源文件已不存在，且这个比例每天上涨 —— 分子每天进新的，分母基本不动。

3. **会话详情页直读源文件的做法，对 claude 是有寿命的。**
   `src/claudeCodeHistory/load.ts` 是 `readFile(filePath)`，文件一删页面就打不开，
   哪怕 `agent_user_messages` 里还有内容。

4. **AI 正文入库的时间点决定了历史的下限。** 正文入库（`role` 列）2026-08-17 上线，
   而 claude 的 30 天窗口意味着那天最早只够得到 ~07-18。因此本机
   **2026-05、06 两个月的 claude AI 回答永久缺失** —— 不是没同步，是同步不到。

5. **用户侧的止血是一行配置**：在 `~/.claude/settings.json` 里设
   `"cleanupPeriodDays": 3650`。这不影响 ai2nao 的实现，但会直接改变
   数据可得性，值得在 README / 首次运行提示里告诉用户。

## 本文没有查证的

- `desktopSessionCleanupPeriodDays` 的行为与默认值
- Claude Code 的清理是在什么时机触发（启动时？定时？）—— 只观察到结果
- codex 那 4 场消失会话的真实原因
- kimi 是否存在 > 40 天的保留期（需等数据变老后复测）
- Cursor / Cherry Studio —— 这两个源尚未进 `index.db`，本文未覆盖
- 各 agent 是否有**服务端**保留期（本文只谈本地磁盘）

## 复现命令

```bash
# 1. Claude Code：从二进制读官方文案
strings -n 8 "$(readlink -f "$(which claude)")" | grep -i cleanupPeriod

# 2. Claude Code：顶层会话记录 vs 嵌套 subagent 产物的年龄
P="$HOME/.claude/projects"
echo "顶层 $(find "$P" -mindepth 2 -maxdepth 2 -name '*.jsonl' | wc -l) 个，\
超30天 $(find "$P" -mindepth 2 -maxdepth 2 -name '*.jsonl' -mtime +30 | wc -l) 个"
echo "嵌套 $(find "$P" -mindepth 3 -name '*.jsonl' | wc -l) 个，\
超30天 $(find "$P" -mindepth 3 -name '*.jsonl' -mtime +30 | wc -l) 个"

# 3. Claude Code：存活与否 vs 文件 mtime（应当零重叠）
sqlite3 -header -column ~/.ai2nao/index.db "
SELECT CASE WHEN missing_since IS NULL THEN '在' ELSE '没了' END 状态, COUNT(*) 会话数,
  MIN(CAST(julianday('now')-julianday(datetime(transcript_mtime_ms/1000,'unixepoch')) AS INT)) mtime最年轻,
  MAX(CAST(julianday('now')-julianday(datetime(transcript_mtime_ms/1000,'unixepoch')) AS INT)) mtime最老
FROM work_session_duration WHERE source='claude-code' GROUP BY 1;"

# 4. 四源横向：谁的会话在消失
sqlite3 -header -column ~/.ai2nao/index.db "
SELECT source, SUM(missing_since IS NULL) 在, SUM(missing_since IS NOT NULL) 没了,
  MAX(CASE WHEN missing_since IS NULL
      THEN CAST(julianday('now')-julianday(ended_at) AS INT) END) 存活的最老天数
FROM work_session_duration GROUP BY 1 ORDER BY 1;"

# 5. Codex：有没有超过 100 天还活着的文件
find ~/.codex/sessions -name '*.jsonl' -mtime +100 | wc -l

# 6. Hermes：源码里所有删除点（应当只有空会话/级联/显式删除）
grep -rnE "DELETE FROM (messages|sessions)" ~/.hermes/hermes-agent --include="*.py" \
  | grep -viE "/tests?/|test_"

# 7. Hermes：库里最老的消息
sqlite3 ~/.hermes/state.db "SELECT date(MIN(timestamp),'unixepoch') FROM messages;"
```

> 所有绝对数字都会随时间漂移：claude 的消失比例每天上涨，
> kimi 的观察窗口每天变长。复测时以当次输出为准。
