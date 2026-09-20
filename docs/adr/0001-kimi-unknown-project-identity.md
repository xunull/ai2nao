---
title: ADR-0001 kimi 无目录会话的项目身份
category: 数据源与同步
order: 90
---

# ADR-0001：kimi 无目录会话归入单一「未知项目」，并靠规则版本触发重刷

kimi 桌面版沙箱里用默认工作目录开的会话没有项目归属，`kimiHistory/scan.ts` 把它映射成 null，免得界面上凭空多出一个叫 workspace 的假项目；但 `normalizeWorkProjectIdentity` 的通用兜底紧接着给**每一场**这样的会话造了一个 `kimi:<sessionId>` 的假项目键，而这个键是工作看板的成组依据，于是 8 场随手提问在看板上变成了 8 行项目。现在改成：kimi 无目录时写固定键 `kimi:unknown`、路径写空串，这类会话并成一个「(未知项目)」桶；空串表示「确定不属于任何目录」，与 codex 的同名约定一致。

已入库的行不会因为代码改了就跟着变（重刷的跳过判据只比文件 mtime 与大小），所以同时把 `KIMI_TOKEN_USAGE_RULE_VERSION` 提到 2，并让 `refreshKimiTokenUsage` 在开头发现 state 表里的版本与常量不符时，把这一轮强制当全量跑。这条顺带补上了一个一直是空的机制：在此之前 bump 规则版本只会让读取侧报 `rule_version_mismatch`，数据永远不会重建。

## 考虑过的方案

- **只在 Kimi 页前端合并**：库里的假键原样留着，工作看板和会话详情页照旧显示 `kimi:conv-...`。否决 —— 等于把已知的脏数据在一个页面上盖住，下一个做相关页面的人还会再踩一次。
- **所有来源统一改兜底键**：会改写 claude / codex / opencode 已入库的 `project_key`，那三家的看板项目行会跟着重排。否决 —— 波及面超出这次改动。
- **一次性 SQL 改数据，或让用户手动把调度任务的 `full` 开一次**：都能把当前这台机器修好，但换台机器装上这版又会得到不一致的库。

## 后果

- `normalizeWorkProjectIdentity` 不再是对所有来源一视同仁的纯函数，多了一个 kimi 分支。
- `project_path` 允许为空串，消费方必须自己判空：工作看板的 `projectLabel()`、Kimi 列表左栏、Kimi 详情页副标题都要显示「(未知项目)」而不是留白。
- 升到这版之后，kimi 的 token 索引会自动全量重刷一次（本地读盘，无 API 成本）。
