---
title: ADR-0003 Cherry Studio 改读单一 SQLite，不保留旧版本回退
category: 数据源与同步
order: 92
---

# ADR-0003：Cherry Studio 改读 `Data/cherrystudio.sqlite`，不保留旧版本回退

Cherry Studio 2.0.14 在一次启动里把数据迁进了 `Data/cherrystudio.sqlite`（Drizzle 管的单库）。旧的两处——`IndexedDB/file__0.indexeddb.leveldb` 与 `Data/agents.db`——自迁移当天起一个字节都不再写。判定依据是文件时间：新库**创建于 11:53**，正好夹在 `agents.db` 最后一次写入（11:51）与 leveldb 最后一次写入（11:54）之间，此后只有新库还在变。

本仓库原来有三条读取路径，各带一个会话 id 前缀：`indexeddb:`（leveldb 解析，583 行）、`agent:`（agents.db，193 行）、`export:`（可选的 Markdown 导出目录，294 行）。现在全部删除，只读新库；会话 id 就是 topic id，不带前缀。**不再支持 2.0.14 之前的 Cherry Studio**，库不存在时给出点名版本的提示，而不是一个空列表。

## 为什么不留 leveldb 回退

留回退等于永久背着 583 行 leveldb 解析，而且此后每改一次 Cherry 相关的逻辑都要在两条路径上各验一遍。旧格式已经冻结、不会再有新数据，回退能救的只有「用户停留在老版本」这一种情况——而那种情况下提示他升级，比默默读一份不再增长的历史更有用。

`export:` 那条一并删掉：它靠 `CHERRY_STUDIO_EXPORT_ROOT` 开，从未被配置过，而导出的 Markdown 是新库同一批内容的有损副本。`agent:` 那条也删：旧 `agents.db` 的 `session_messages` 与新库的 `agent_session_message` **都是 0 行**，它贡献的是点进去什么都没有的空壳会话；等它真有数据了再接，那时才知道正文长什么样。

## 从这个库里读出来的几件事

- **消息是棵树。** `message.parent_id` 串联，每个 topic 有一条 `role='root'` 的无正文树根，`topic.active_node_id` 指向当前激活的叶子。取正文要从激活叶子沿 parent 回溯，不能按 `created_at` 平铺——重新生成会在同一个 parent 下挂第二个子节点，平铺会把新旧两个回答都列出来。（迁移后的真库当前 0 个分支，两种取法输出一致，所以这个错误在今天看不出来。）
- **正文在 `data` 的 parts 数组里**（AI SDK 形状）。`text` 进 `content`，`reasoning` 进 `thinking`（详情页用与 claude / cursor / opencode 同一个折叠块），`dynamic-tool` 丢弃。`data-error` 的值不在 `.text` 而在 `.data.message`，真库里唯一的一条是用户点停止产生的「Request was aborted」——留下它，否则那场对话会出现「连问两次、中间没有回答」的断层，措辞照抄 Cherry 自己填进 `searchable_text` 的那句。
- **`message_fts` 是 FTS5 trigram，中文三个字起。** 实测「如何查看」17 条、「哪些端口」2 条、「端口」0 条。所以搜索在查询不足三字时回退 `LIKE '%q%'`——真库 2184 行，全表扫是亚毫秒级。

## 后果

- 会话记忆工具（`sessionMemory`）原来每次检索都要把全部会话载入再在 JS 里逐条 `indexOf`，现在是一条 SQL。接口形状不变。
- 前端去掉了「Markdown 导出目录」输入框与 `?exportRoot=` 参数；状态栏从「IndexedDB N topics」改成话题数。
- 旧的 `indexeddb:xxx` 会话链接失效。
