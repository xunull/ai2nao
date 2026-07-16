---
layout: home

hero:
  name: ai2nao
  text: 设计 & 架构笔记
  tagline: local-first 开发数据索引器 + AI 工作台的架构决策记录。先读设计，再读代码。
  actions:
    - theme: brand
      text: AI 对话架构
      link: /ai-chat-architecture
    - theme: alt
      text: GitHub
      link: https://github.com/xunull/ai2nao

features:
  - title: 架构与 AI 对话
    details: AI 对话边界、会话记忆、CopilotKit 用法、Activity Cosmos、MCP server。
    link: /ai-chat-architecture
  - title: RAG 与检索
    details: 双路召回、FTS+向量的取舍、Reranker、RRF、向量库对比。
    link: /rag-hybrid-retrieval-design
  - title: Token 与成本
    details: token 解析管线、分段计价、生态对照、各类计数偏差。
    link: /token-usage-pipeline
  - title: 数据源与同步
    details: GitHub 雷达、下载目录、VS Code / Cursor / LM Studio、可插拔用量同步。
    link: /github-open-source-radar
  - title: LLM 工具
    details: 受控 Bash、本地沙盒代码执行、Web Search 与安全/权限设计。
    link: /llm-bash-tool
  - title: 调度与运维
    details: Scheduler、每日摘要、工作复盘、package scripts 说明。
    link: /scheduler-design
  - title: 配置与设置
    details: 配置读取优先级——config.db vs 老 JSON 文件，谁为准、何时回落、两个 env 例外。
    link: /config-precedence
---
