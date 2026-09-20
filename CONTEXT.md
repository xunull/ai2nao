# ai2nao

ai2nao 把本机各家 AI 编码工具留下的会话记录、token 用量与命令历史收进一个本地索引，再按项目、时间和主题呈现出来。这份词汇表只收**跨来源统一**的说法 —— 各家工具对同一件事各有各的叫法，这里定哪个是准的。

## Language

**来源（Source）**：
产生 AI 会话记录的本机工具，例如 claude、codex、kimi、opencode、cursor、hermes。
_Avoid_: provider（那是另一件事，见下）、厂商、渠道

**服务商（Provider）**：
提供模型 API 的一方，例如 OpenAI、Anthropic、MiniMax。与「来源」正交 —— 同一个来源可以走多个服务商。
_Avoid_: 来源、平台

**会话（Session）**：
来源自己划定的一次连续对话，是所有记录的自然主键。同一场会话可以横跨多个文件（kimi 的一场会话下有多个 agent 文件）。
_Avoid_: 对话、conversation、thread

**项目（Project）**：
一场会话归属的工作目录，归一成一个跨来源的键。各家的原始字段不同（kimi 的 `workDir`/`cwd`、cursor 的 workspace、claude 编码进目录名），归一之后只认这一个说法。
_Avoid_: 工作区、workspace、仓库

**未知项目（Unknown Project）**：
确定不属于任何工作目录的会话所归入的**单一**桶。它表达的是「确定没有目录」，不是「还没查出来」—— 后者是索引缺陷，要报诊断，不能混进这个桶。
_Avoid_: 无目录记录、孤儿会话、(未分类)

**真人提问（Human message）**：
用户自己打进去的字。与之相对的是来源注入的上下文和 AI 正文 —— 两者都入库留底，但都不算提问。判据不是消息的 role：注入的上下文结构上也是 `role=user`。
_Avoid_: 用户消息（歧义）、user turn
