# Work Token Refresh Tasks

本文说明定时任务页面中两个 token 刷新任务的区别：

```text
Codex token 统计刷新
工作项目 token 统计刷新
```

## 结论

`Codex token 统计刷新` 是单源任务，只刷新 Codex 的项目级 token 索引。

`工作项目 token 统计刷新` 是组合任务，会先刷新 Codex，再刷新 Claude Code。`Token 排行`
页面应该依赖这个组合任务，因为它需要同时展示 Claude + Codex。

推荐启用：

```text
工作项目 token 统计刷新
```

`Codex token 统计刷新` 可以保留给只想单独重建 Codex 索引的调试场景。

## 任务对比

```text
任务 key: codex.tokens.refresh
显示名: Codex token 统计刷新
刷新范围: Codex only
写入表:
  codex_session_token_usage
  codex_token_usage_state
```

```text
任务 key: work.tokens.refresh
显示名: 工作项目 token 统计刷新
刷新范围: Codex + Claude Code
写入表:
  codex_session_token_usage
  codex_token_usage_state
  claude_session_token_usage
  claude_session_token_usage_state
```

## Codex token 统计刷新

实现入口：

```text
src/scheduler/taskDefinitions.ts
  -> refreshCodexTokenUsage()

src/codexTokenUsage/refresh.ts
```

扫描的数据源：

```text
~/.codex/state_5.sqlite
  -> threads 表
  -> 读取 id、rollout_path、cwd、title、model、git_branch、created_at、updated_at

~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
  -> transcript JSONL
  -> 从 token_count 事件读取真实 token
```

正常路径：

```text
1. 打开 ~/.codex/state_5.sqlite
2. 读取 threads 全表，默认 archived=false
3. 用每条 thread.rollout_path 找到 rollout JSONL
4. 校验真实路径仍在 ~/.codex/sessions 内
5. 解析 JSONL
6. 提取 event_msg + payload.type === "token_count"
7. 归一化 project_key
8. upsert 到 codex_session_token_usage
```

fallback 路径：

```text
如果 state_5.sqlite 不可用：
  扫描 ~/.codex/sessions/**/rollout-*.jsonl
  从 transcript 中尽量提取 cwd、title、createdAt、lastUpdatedAt
```

增量判断：

```text
session_id
rollout_path
rollout_mtime_ms
rollout_size_bytes
```

这些值没变，并且不是 full rebuild，就跳过重新解析，只更新 `source_seen_at`。

## 工作项目 token 统计刷新

实现入口：

```text
src/scheduler/taskDefinitions.ts
  -> refreshCodexTokenUsage()
  -> refreshClaudeTokenUsage()

src/codexTokenUsage/refresh.ts
src/claudeTokenUsage/refresh.ts
```

这个任务不是一个全新 token 计算器，而是一个编排任务：

```text
work.tokens.refresh
  ├── refreshCodexTokenUsage()
  └── refreshClaudeTokenUsage()
```

状态合并规则：

```text
任一来源 failed  -> 任务 failed
任一来源 partial -> 任务 partial
两个来源 success -> 任务 success
```

错误摘要优先取 Codex 的第一条错误；没有 Codex 错误时取 Claude 的第一条错误。

## Claude Code 刷新扫描什么

实现入口：

```text
src/claudeTokenUsage/refresh.ts
```

扫描的数据源：

```text
~/.claude/projects/<project-id>/*.jsonl
  -> Claude Code session transcript
  -> 从 assistant message.usage.input_tokens/output_tokens 读取真实 token
```

正常路径：

```text
1. 扫描 ~/.claude/projects 下所有 project directory
2. 扫描每个 project directory 中的 *.jsonl
3. 解析 JSONL
4. 只读取 assistant record 的 message.usage
5. 汇总 input_tokens / output_tokens
6. 归一化 project_key
7. upsert 到 claude_session_token_usage
```

Claude 的项目身份来源：

```text
优先:
  project directory slug 解码出的真实 workspace path

fallback:
  transcript record.cwd

最后兜底:
  project_id
```

增量判断：

```text
session_id
file_path
file_mtime_ms
file_size_bytes
```

这些值没变，并且不是 full rebuild，就跳过重新解析，只更新 `source_seen_at`。

## Token 排行页面依赖哪个任务

`/dashboard/tokens` 页面对应 API：

```text
GET /api/work-dashboard/token-projects
```

这个 API 只读派生索引表：

```text
claude_session_token_usage
codex_session_token_usage
```

它不会在请求里扫描 `~/.claude/projects`，也不会在请求里扫描
`~/.codex/sessions`。这样页面打开时只做 SQLite 聚合：

```text
SELECT project_key, SUM(total_tokens)
FROM *_session_token_usage
WHERE missing_since IS NULL
  AND last_updated_at >= range_start
GROUP BY project_key
ORDER BY SUM(total_tokens) DESC
```

因此，如果 Token 排行页面缺数据，正确处理方式是运行：

```text
工作项目 token 统计刷新
```

而不是让页面 API 临时慢扫历史 session。

## full=true 的含义

两个任务都支持 config 中的 `full=true`。

默认增量刷新：

```text
path + mtime + size 没变 -> 跳过解析
path + mtime + size 变化 -> 重新解析
```

full rebuild：

```text
忽略已有 row 的 mtime/size
重新解析所有当前可发现的 session JSONL
```

适合在以下情况使用：

```text
token 解析规则升级
project_key 归一化规则升级
怀疑历史索引污染
首次导入后想强制重算
```

## 删除和缺失 session 的处理

刷新任务不会直接删除旧 row。

如果某个 session 之前存在，但本轮 source 中不再出现：

```text
missing_since = 当前刷新时间
```

排行聚合默认排除：

```text
missing_since IS NOT NULL
```

这样可以避免历史文件被移动、清理、权限短暂异常时直接丢失索引记录，同时不会把已经确认缺失的 session 继续计入当前排行。

## 什么时候用哪个

推荐日常启用：

```text
工作项目 token 统计刷新
```

只在这些场景单独运行 `Codex token 统计刷新`：

```text
只调试 Codex token 解析
只重建 Codex 索引
Claude Code 数据源暂时不可用，但不想让组合任务显示 partial/failed
```

如果两个任务都启用，结果不会重复计数。原因是：

```text
Codex token 统计刷新
  -> 只 upsert Codex 表

工作项目 token 统计刷新
  -> upsert Codex 表 + Claude 表

Token 排行
  -> 按当前索引表聚合，不按任务运行次数累加
```

但同时启用会重复刷新 Codex，浪费一些扫描时间。因此更干净的配置是只启用 `工作项目 token 统计刷新`。
