# RAG 双路召回设计

**状态：** Draft
**日期：** 2026-05-17
**关联现有模块：** `src/rag/*`、`src/llmChat/copilotRuntime.ts`、`web/src/pages/AiChat.tsx`

## 背景

ai2nao 当前 RAG 用于给 `/ai-chat` 提供本机资料证据。用户通过 `rag.json` 配置本地 Markdown / text 目录，`ai2nao rag ingest` 将文件切块后写入独立的 `~/.ai2nao/rag.db`。检索阶段先走 SQLite FTS5，再在开启 embedding 时对 FTS 命中的候选做向量重排。

当前链路可以概括为：

```text
用户问题
  -> FTS5 关键词召回
  -> 可选：对 FTS 候选做 embedding 相似度重排
  -> 注入 AI 对话 system prompt / 返回证据卡片
```

这个实现简单、稳定、可解释，但它不是完整的双路召回。因为向量检索只参与重排，不独立参与召回。一旦 FTS 没有命中，embedding 没有机会把语义相关但关键词不同的片段找回来。

## 什么是双路召回

双路召回是同一个查询同时走两条检索路径：

```text
用户问题
  ├─ FTS/BM25 关键词召回 -> topN
  └─ Vector 语义召回    -> topN

合并去重
融合排序
返回 topK
```

两条路径解决的问题不同：

- **FTS/BM25**：擅长精确词、代码符号、配置项、错误码、文件名、专有名词。
- **Vector**：擅长同义表达、自然语言改写、概念相似问题。

例如原文写的是：

```text
corpusRoots 用来配置本地索引目录
```

用户问：

```text
我的知识库资料路径在哪里设置？
```

FTS 可能因为缺少共同关键词而漏掉；向量检索可能根据语义相似把这段召回。反过来，如果用户直接问 `AI2NAO_RAG_DB`、`rag.json`、`corpusRoots`，FTS 通常比向量更可靠。

## 为什么 ai2nao 适合双路召回

ai2nao 的本机资料不是单一 FAQ，而是混合了项目文档、TODO、代码说明、AI 对话、命令历史和个人笔记。这类数据天然同时需要精确检索和语义检索。

典型查询包括：

- “RAG 配置文件在哪里？”
- “为什么本地资料没有被检索到？”
- “之前关于 CopilotKit 工具调用的设计在哪？”
- “哪个文档提到双路检索调试视图？”
- “`corpusRoots` 是干什么的？”

其中有些依赖精确词，有些依赖语义改写。单靠 FTS 会漏掉表达不同的内容；单靠向量会在配置项、函数名、错误码、CLI 参数上变得不够稳定。双路召回的目标不是追求架构复杂，而是让不同类型的问题都有一条合适的入口。

## 当前实现与目标实现

### 当前实现

```text
searchHybrid(query)
  -> searchFts(query, ftsLimit)
  -> 如果没有 embedding：返回 FTS topK
  -> 如果有 embedding：
       对 query 做 embedding
       只读取 FTS 命中 chunk 的 embedding
       计算 cosine
       用 RRF 融合 FTS 排名和向量重排排名
```

优点：

- 不需要额外向量数据库。
- 数据都在 SQLite，部署简单。
- FTS 命中可解释。

限制：

- 向量只重排 FTS 候选，不独立召回。
- FTS 漏掉时，向量没有补救机会。
- 无法观察 FTS、向量、融合三组结果的差异。

### 目标实现

```text
searchHybrid(query)
  -> ftsHits = searchFts(query, ftsTopN)
  -> vectorHits = vectorStore.search(queryEmbedding, vectorTopN)
  -> merged = mergeByChunkId(ftsHits, vectorHits)
  -> ranked = fuseByRrf(merged)
  -> return ranked.topK
```

目标是把现有 “FTS + 向量重排” 升级为 “FTS 召回 + 向量召回 + 融合排序”。

## 推荐架构

保留 `rag.db` 作为 chunk 元数据和 FTS 的权威存储，不把正文、路径、mtime 等基础数据迁移到向量库。向量库只负责向量索引和语义召回。

```text
rag.db
  rag_chunks
    id
    source_root
    file_path
    chunk_index
    content
    mtime_ms
    content_sha256

  rag_chunks_fts
    chunk_id
    content

vector store
  chunk_id
  embedding
  source_root
  file_path
  content_sha256
```

这样做的好处：

- 本地 SQLite 仍然是事实来源，便于备份、调试和迁移。
- FTS 和向量后端可以独立演进。
- 后续可以在 Chroma、Qdrant、sqlite-vec、LanceDB 之间切换。
- 删除或重建某个文件索引时，可以用 `source_root + file_path` 同步清理两边数据。

## VectorStore 抽象

建议新增一个很薄的后端接口，不要让业务代码直接依赖 Chroma 或 Qdrant：

```ts
export type RagVectorHit = {
  chunkId: number;
  score: number;
  sourceRoot?: string;
  filePath?: string;
  contentSha256?: string;
};

export type RagVectorStore = {
  status(): Promise<{
    ok: boolean;
    provider: string;
    indexedCount?: number;
    error?: string;
  }>;

  upsertChunks(chunks: {
    chunkId: number;
    sourceRoot: string;
    filePath: string;
    chunkIndex: number;
    content: string;
    contentSha256: string;
    embedding: Float32Array;
  }[]): Promise<void>;

  deleteFile(sourceRoot: string, filePath: string): Promise<void>;

  search(queryEmbedding: Float32Array, topK: number): Promise<RagVectorHit[]>;
};
```

第一版可以只实现一个 provider，例如 Chroma 或 Qdrant。接口先稳定下来，避免后续把具体数据库 API 泄漏到 `retrieve.ts`、`ingest.ts` 和 routes 里。

## 融合排序

第一版建议继续使用 RRF（Reciprocal Rank Fusion），因为它不要求 FTS 分数和向量分数在同一尺度内。

```text
score = 1 / (k + ftsRankPosition) + 1 / (k + vectorRankPosition)
```

其中：

- 只在 FTS 出现的结果，也可以获得 FTS 分。
- 只在向量出现的结果，也可以获得向量分。
- 两边都出现的结果通常会排得更靠前。

默认参数建议：

- `ftsTopN = 40`
- `vectorTopN = 40`
- `finalTopK = 8`
- `rrfK = 60`

后续如果有评测集，再考虑 query-aware 权重。例如包含代码符号、配置项、错误码的查询提高 FTS 权重；自然语言解释类查询提高向量权重。

## 调试视图优先级

在引入任何向量数据库之前，应该先做可观测性。否则换了数据库也很难证明效果变好。

建议新增调试接口：

```text
POST /api/rag/debug-search
```

返回结构：

```ts
type RagDebugSearchResponse = {
  query: string;
  fts: RagDebugHit[];
  vector: RagDebugHit[];
  hybrid: RagDebugHit[];
};
```

每个 hit 至少包含：

- `chunkId`
- `sourceRoot`
- `filePath`
- `content`
- `ftsRank`
- `vectorScore`
- `hybridScore`
- `matchedBy: ("fts" | "vector")[]`

前端可以在 AI 对话页或独立 RAG 调试页展示三列结果：

```text
FTS 结果 | 向量结果 | 融合结果
```

这个页面的价值很高：它能直接暴露是切块问题、关键词问题、embedding 问题、融合排序问题，还是用户问题本身不在语料里。

## 评测集

建议新增一个小型黄金检索集，先不要追求大而全。

示例格式：

```json
[
  {
    "query": "RAG 的本地资料目录在哪里配置？",
    "expected": [
      { "filePath": "README.md", "contains": "corpusRoots" },
      { "filePath": "rag.config.example.json", "contains": "corpusRoots" }
    ]
  }
]
```

评测指标先用简单可解释的：

- `Recall@8`：top8 是否包含期望文件或片段。
- `MRR`：第一个正确结果排在第几位。
- `NoHit`：完全没有命中的查询数量。

命令形态可以是：

```bash
ai2nao rag eval --cases docs/rag-eval-cases.json
```

评测集应该覆盖：

- 精确配置项查询。
- 自然语言改写查询。
- 文件名/路径查询。
- 设计文档类查询。
- 故障排查类查询。

## 向量后端选择

第一阶段不建议直接引入 RAGFlow 作为主路径。RAGFlow 更像完整知识库平台，包含文档解析、知识库 UI、Agent 工作流等能力；ai2nao 当前需要的是在现有本地索引上补一条向量召回路径。

候选方案：

| 方案 | 优点 | 风险 | 适合阶段 |
|------|------|------|----------|
| Chroma | 上手快，RAG 原型常用，开发成本低 | 需要额外服务或本地持久化管理 | PoC |
| Qdrant | 服务化稳定，payload/filter 能力强，长期更清晰 | 运行依赖更重 | 长期向量后端 |
| sqlite-vec / sqlite-vss | 本地优先，和当前 SQLite 气质一致 | Node 集成和生态需验证 | 桌面本地优先版本 |
| LanceDB | 本地向量库体验较好 | 需要确认 TS/Node 集成与部署边界 | 轻量本地后端 |
| RAGFlow | 完整 RAG 平台能力强 | 产品边界大，容易吞掉 ai2nao 自己的 RAG 架构 | 外部知识库集成 |

推荐顺序：

1. 先做调试接口和评测集。
2. 用 Chroma 或 Qdrant 做一个最小 VectorStore provider。
3. 如果本地优先和零服务依赖更重要，再评估 sqlite-vec / LanceDB。
4. RAGFlow 放到“外部知识库连接器”方向，而不是当前 RAG 检索内核。

## 分阶段落地

### Phase 1：可观测性

- 新增 `/api/rag/debug-search`。
- 展示 FTS、当前重排结果和最终结果。
- 新增小型 `rag eval` 命令。
- 先用现有 `rag.db`，不引入新数据库。

验收标准：

- 能看出每个查询为什么命中或没命中。
- 至少有 20 条黄金问题。
- 修改切块、topK、融合逻辑后能跑同一套评测。

### Phase 2：真正双路召回

- 新增 `RagVectorStore` 接口。
- ingest 时将 chunk embedding 写入向量后端。
- 检索时并行跑 FTS 和 vector。
- 用 RRF 合并去重排序。
- debug-search 返回三路结果。

验收标准：

- 向量结果可以包含 FTS 未命中的 chunk。
- hybrid topK 能解释每个结果来自哪一路。
- 评测集 Recall@8 相比当前实现有可观察提升。

### Phase 3：质量优化

- 支持 query-aware 权重。
- 增加 reranker。
- 优化 chunk 策略，例如标题路径、代码块、段落层级。
- 在证据卡片中展示“为什么命中”：关键词、向量相似度、融合分。

验收标准：

- 精确查询不被语义相似噪声淹没。
- 自然语言改写查询能稳定命中相关设计文档。
- 用户在 UI 中能判断证据是否可靠。

## 非目标

第一版双路召回不解决以下问题：

- PDF、Word、PPT、图片 OCR 的复杂解析。
- 自动知识图谱。
- 多租户权限。
- 云端同步。
- 基于 LLM 的自动问答缓存。
- 完整 RAGFlow 替代。

这些能力可以后续扩展，但不应该阻塞当前 RAG 检索质量的核心改进。

## 推荐下一步

最小可执行下一步：

1. 新建 RAG 评测集格式和 `rag eval` 命令。
2. 新建 `/api/rag/debug-search`，先返回 FTS 和当前 hybrid 结果。
3. 在文档和 UI 中明确当前 hybrid 不是双路召回，而是 FTS 候选重排。
4. 抽象 `RagVectorStore`，用 Chroma 或 Qdrant 做一个可替换 provider。
5. 将 `searchHybrid` 改为 FTS + vector 双路召回，再用同一评测集验证收益。

核心原则：先让检索质量可见，再引入新后端。否则系统会变复杂，但无法判断是否真的变好。
