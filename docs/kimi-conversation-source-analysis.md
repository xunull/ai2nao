# 调研:能否把 Kimi app 的对话同步进 ai2nao

延续 [claude.ai 导入设计](./claude-ai-import-design.md) 那条线,调研 Kimi Mac app
的对话能否在本地读取、同步进 ai2nao。

> **结论:放弃(现阶段无任何官方入口)。** 主聊天服务器端、官方无导出也无历史读取
> API;agent 模式的本地库当前为空。详见下文与「复活条件」。

---

## 1. 现场勘查:Kimi.app 的存储结构

Kimi.app(bundle id `com.moonshot.kimichat`)是一个 **Electron 壳**,包着
`www.kimi.com` 网页。本地有两个数据目录:

| 目录 | 内容 |
|---|---|
| `~/Library/Application Support/Kimi/` | 几乎空(只有 `pc-attribution.json`) |
| `~/Library/Application Support/kimi-desktop/` | 真正的 app 数据,标准 Electron 结构(Cache / IndexedDB / Local Storage / Service Worker / Cookies / blob_storage …)+ 一套 agent 运行时 |

内部有两套完全不同的对话面,必须分开看:

| 面 | 存储位置 | 本地能读么 |
|---|---|---|
| **主聊天**(www.kimi.com) | 服务器端。本地只有 `IndexedDB/https_www.kimi.com_0.indexeddb.leveldb`,约 **140K** 网页缓存 | ❌ 不能(与 Claude app 同构) |
| **Agent 模式**(daimon 守护进程) | `kimi-desktop/daimon-share/`(334M,其中约 305M 是内嵌 Python 运行时,不是对话) | ⚠️ 结构上能,但当前为空(见 §3) |

---

## 2. 主聊天:服务器端,本地不可读

主聊天与 Claude app 的模型完全一致:对话在 Moonshot 服务器上,本地只有一份约
140K 的 IndexedDB 缓存(二进制 leveldb、不完整、会被覆盖)。**拿不到完整历史。**

---

## 3. Agent 模式(daimon):本地有 SQLite,但当前是空的

Kimi app 内嵌了一个 agent/coding 守护进程(`daimon-share/daimon/`),它有一个本地
对话索引:

```
~/Library/Application Support/kimi-desktop/daimon-share/daimon/
  agents/main/sessions/hosted-logical/conversations.sqlite   (45K)
```

表结构(只读了 schema,未触碰任何对话正文)——`conversations` 表关键列:

| 列 | 含义 |
|---|---|
| `title` / `first_user_text` / `first_assistant_text` | 会话标题 + 首条 user/assistant 消息**预览** |
| `kernel_session_dir` / `kernel_records_path` | **指针**:指向完整逐轮记录文件的位置 |
| `workspace_path` / `origin` / `work_tag` | agent 工作区上下文 |
| `created_at_ms` / `updated_at_ms` | 时间戳(带 recency 索引) |

也就是说:这个 sqlite 是**会话索引**(标题 + 首条预览 + 指针),完整逐轮记录另存于
`kernel_records_path`。设计上这是一个可读的本地对话源。

**但实测三张表(`conversations` / `sessions` / `schema_metadata` 里的前两张)均为
0 行**,`kernel_records_path` 指向的记录文件一个都不存在。结论:本机上 agent 模式
的对话本地库为空——要么没用过该模式,要么该部分也托管到了服务器。

---

## 4. 附带发现:本地明文「用户画像」记忆库

Agent 在本地存了一份明文 markdown 长期记忆:

```
~/Library/Application Support/kimi-desktop/daimon-share/daimon/agents/main/memory/vault/
  about_user.md, personal_context.md, work_context.md, taste.md, this_month.md,
  entities/{people,places,projects,concepts}/ …
```

这些是 Kimi agent 对用户的**记忆笔记/画像**,本地可读的明文,但**不是对话记录**——
是「关于你」的摘要,不是逐句聊天。记录在此以备两用:①若关心"这些 AI 在本地存了我
什么",这是一处;②它不能替代对话历史,别把它当数据源。

---

## 5. 官方 API 调研:没有能读取历史的 API

区分两套系统(极易混淆):

| 能力 | 官方是否提供 | 说明 |
|---|---|---|
| **推理 API**(发消息给模型) | ✅ 有 | `api.moonshot.ai/v1/chat/completions`,OpenAI 兼容。**无状态**——官方明确要求应用自己把历史 messages 每次重发。它不存也不返回你的历史。 |
| **列会话 / 读历史 API** | ❌ 没有 | 开放平台只有 chat/completions、files、model list 等端点,**没有任何"列出/拉取我的对话"的端点**。 |
| **官方数据导出**(类似 claude.ai Export data) | ❌ 没有 | kimi.com 无原生导出、无导出 API。 |

关键点:Moonshot 开放平台 API 是给你**当 OpenAI 用**的(拿 Kimi 模型跑自己的应用),
和你在 Kimi app/网页里的**个人对话是两套系统**;后者服务器端、不对外开放读取——
如同 OpenAI 的 API 读不到你 ChatGPT 的历史。

---

## 6. 非官方路子(全部否掉)

搜索能找到的"拿到历史"的方法只有两类,均属刮取/逆向:

1. **第三方浏览器插件**(如 ChatExport AI):在 kimi.com 页面上把当前对话导成
   PDF/Markdown 等。本质是**页面刮取**,一次一条、手动、非官方。
2. **逆向 API**(如 GitHub `Kimi-Free-API`):逆向 kimi.com 私有接口、借用户 token 调用,
   作者自标"仅供测试"。属 ToS 灰区,**与我们给 claude.ai 已否掉的私有 API 路线同类**。

ai2nao 是公开仓库,这两类都不进主仓(参见 claude.ai 设计文档 §1 的同款理由)。

---

## 7. 判决:放弃 Kimi 作为 ai2nao 的对话源

- [claude.ai 导入](./claude-ai-import-design.md) 能落地,是因为它**有确认的官方 Export**,
  可照 "官方导出 → 解析 → 入库" 设计。
- Kimi **既无官方导出、也无历史读取 API**,主聊天服务器端,agent 模式本地库为空。
  **没有任何合法官方入口能把 Kimi 对话弄进 ai2nao。**
- 剩下的全是刮取/逆向,进不了公开仓库。

现阶段本地唯一可读的 Kimi 数据是那份 agent 记忆画像(markdown,非对话),无同步价值。

---

## 8. 复活条件(满足其一再回来看)

1. **你开始重度使用 Kimi 的 agent/coding 模式** → 本地 `conversations.sqlite` +
   `kernel_records_path` 记录会填充。那时它是个正经本地源,可像现有的
   Claude Code / codex / opencode agent 会话一样,吃进 `agent_user_messages`
   归一化表(注意其 schema 是 app 内部、`schema_metadata` 版本化,未文档化、会变)。
2. **Moonshot 上线官方数据导出** → 直接套用 claude.ai 的 export-importer 设计
   ("官方导出 → 解析 → 新 raw 表 / `agent_user_messages`"),该模式是通用的
   "网页 AI 对话导出导入器",一行不用重想。

---

## 附:调研方法与来源

- 本地结构:直接勘查 `~/Library/Application Support/{Kimi,kimi-desktop}/`
  (只读文件名/大小/sqlite schema,未读取任何对话正文)。
- 官方 API:
  - [Kimi API Overview — 平台文档](https://platform.kimi.ai/docs/api/overview)
  - [Kimi 多轮对话指南(确认无状态、需自行重发历史)](https://platform.moonshot.ai/docs/guide/engage-in-multi-turn-conversations-using-kimi-api)
- 非官方路子(仅记录、不采用):
  - [ChatExport AI(页面刮取插件)](https://chatexportai.com/kimi-export)
  - [Kimi-Free-API(逆向 API,非官方)](https://github.com/xiaoY233/Kimi-Free-API)
