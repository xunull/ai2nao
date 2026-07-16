# 配置读取优先级（config.db vs 文件）

ai2nao 的配置正在从"手改 JSON"迁往设置页（存进 `~/.ai2nao/config.db`）。这份
文档回答一个问题：**每一项配置到底以什么为准？什么时候还会去读那些老文件？**

一句话总结：

> **config.db 是配置的唯一事实来源。老的 JSON 文件只是安全网 —— db 里有对应
> 记录时，文件一个字都不会被读；只有 db 那条记录缺失或损坏，才回落读文件。**

例外只有两个，都在下面写明：环境变量对个别凭据仍然优先，`--config <文件>` 是
显式覆盖。

---

## 存储位置

| 位置 | 权限 | 装什么 | 能否单独排除备份 |
|---|---|---|---|
| `~/.ai2nao/config.db` | 0600 | 全部配置：凭据（`credential` 表）+ 非密钥设置（`setting` 表） | 是（几十 KB） |
| `~/.ai2nao/index.db` | 0600 | 扫来的数据 + `app_config` 表（scan.roots、主题分类法） | 否（几百 MB） |
| `~/.ai2nao/*.json` | 0600 | 老配置文件，**降级为兜底**（见下） | — |

> 备注：主题分类法（taxonomy）放在 `index.db` 的 `app_config` 而不是 `config.db`。
> 它不是密钥，必须跟你的数据一起备份 —— 放进"随时可排除备份"的 config.db 反而
> 会在你排除备份时把它一起丢掉。

---

## 逐项优先级

从左到右，先命中者胜。「文件」列写明该项对应的老文件；`env` 列写明是否有环境
变量参与、以及它的位置。

| 配置项 | 优先级（先命中者胜） | 对应老文件 | 关键点 |
|---|---|---|---|
| **llm-chat** | config.db → 文件 → **env（仅 key）** | `llm-chat.json` | provider/model/baseURL 只看 db-或-文件；**key** 在下游还能回落 `DEEPSEEK_API_KEY` 等 env（`model.ts`） |
| **rag-embedding**（日常） | config.db → 文件 | `rag.json` 的 `embedding` 段 | **整块**以 db 为准：db 有凭据就 model/baseURL/key 全用 db，不按字段混 |
| **rag-embedding**（`--config`） | 指名文件 → **db（仅借 key）** | `--config <文件>` | 见下方「`--config` 例外」 |
| **rag-corpus** | config.db → 文件 | `rag.json` 的 corpusRoots 等 | 整块。`AI2NAO_RAG_CORPUS_ROOT` 会在解析完之后**追加**一个根（不是覆盖） |
| **web-search** | **env** → config.db → 文件 | `web-search.json` | `BRAVE_SEARCH_API_KEY` 优先（历来如此，保持不变） |
| **github** | **env** → config.db → 文件 | `github.json` | `GITHUB_TOKEN` 优先（历来如此，保持不变） |
| **feishu** | config.db → 文件 | `notify.json` | 传 `explicitPath` 时只读该文件、跳过 db（测试注入缝） |
| **minimax** | config.db → **index.db 旧列** | `provider_config.api_key`（index.db） | key 已迁出明文列；旧列仅作兜底 |
| **主题分类法** | app_config(index.db) → 文件 → **内置默认** | `config.json` 的 `topicStream` | db 有则用「你的分类 + 未重名的内置」；db 无则读文件；都没有则内置默认 |
| **scan.roots / 扫描设置** | 只在 app_config(index.db) | — | 从来就在 db，无文件兜底 |

---

## 三条通用规则

### 1. db 有则整块用，绝不按字段混

一项配置要么整块来自 db，要么（db 缺失时）整块来自文件。**不存在"model 从文件读、
key 从 db 读"这种半读半用** —— 那正是"到底以什么为准"说不清的根源，已在
`readRagConfig` 里改掉。

### 2. db 记录损坏 → 回落文件，而不是清空

手改坏了 db 里的 JSON，读取端把它当作"这项没配"，退回读老文件。这样一个坏行
不会把整个功能（RAG / 主题河流）弄没，只是暂时退回文件那份旧配置。

### 3. 老文件永不被改名或重写

迁移把配置**拷贝**进 db，从不删除或改名 `rag.json` / `config.json`。它们留着当
兜底：万一 config.db 出问题，你调过的东西不会凭空消失，而是退回文件那份。

---

## 两个例外

### 环境变量优先（web-search、github）

`BRAVE_SEARCH_API_KEY` 和 `GITHUB_TOKEN` 排在 config.db **之前**。这是这两个 reader
历来的行为，迁移时刻意保留 —— 设过 env 的人不该因为迁移而行为突变。

设置页里如果某项显示"由环境变量接管"，就是这个意思：表单照样能存，但 env 仍然
赢，存进去的值暂时不生效。

### `--config <文件>` 是显式覆盖（仅 rag）

`ai2nao rag ingest --config ./other.json` 里，**你指名的那个文件说了算**：它的
corpusRoots 和 embedding 的 model/baseURL 都以文件为准，db 只借 **key**（因为 key
已不允许留在文件里）。

为什么和日常路径不同：`--config` 的语义就是"用这个文件"。拿 db 的 model 去盖掉
文件指定的 model，会**静默改掉索引的向量空间**（`markVectorSync` 记录 model 但不
校验一致性，混了模型的索引是无声的垃圾）。

---

## 环境变量：改路径 vs 改值

两类环境变量，别混淆：

- **改路径**（测试 / 多环境用）：`AI2NAO_CONFIG_DB`、`AI2NAO_RAG_CONFIG`、
  `AI2NAO_CONFIG`（= config.json）、`AI2NAO_GITHUB_CONFIG`、`AI2NAO_LLM_CHAT_CONFIG`、
  `AI2NAO_WEB_SEARCH_CONFIG`、`AI2NAO_NOTIFY_CONFIG` —— 把某个 db/文件的**位置**指到
  别处。测试靠它把所有读写重定向到临时目录，绝不碰你真实的 `~/.ai2nao`。
- **改值 / 优先生效**：`GITHUB_TOKEN`、`BRAVE_SEARCH_API_KEY`（优先于 db）；
  `DEEPSEEK_API_KEY` 等 + `AI2NAO_LLM_API_KEY` / `OPENAI_API_KEY`（llm-chat 的 key
  兜底）；`AI2NAO_RAG_CORPUS_ROOT`（追加一个语料根）。

---

## 那我能删掉那些老文件吗？

**能，但删了就没安全网了。** db 正常时它们永不被读、不参与任何逻辑；一旦 config.db
损坏或被删，它们是你唯一的回落。建议留着当死备份，真想清爽就 `mv` 成 `.bak`，
**别 `rm`**。

想验证某个文件此刻是否真被读：把它临时改名，重新触发一次读取（跑对应功能或抓
`GET /api/settings`），如果行为一字不变，就说明当前完全走 db、该文件没被碰。
