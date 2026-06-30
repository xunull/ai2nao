# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## Project UI Constraints

- 本项目只在 PC 桌面端使用，完全不考虑移动端访问的可能性。页面布局、信息密度、交互尺寸和响应式策略只需要面向 PC 展示效果优化。
- 页面设计禁止垂直上限滚动太多 严谨竖着排布很多超过屏幕
- 原则上讲，禁止浏览器横线滚动条，如非必要 不要出现横向的滚动条

## Project Architecture Iron Laws

- CopilotKit 在本项目中默认只能作为前端 AI 对话 UI 显示库使用。唯一允许的后端例外是：CopilotKit runtime 可以作为最薄 transport adapter，用于兼容 CopilotKit / AG-UI 的 HTTP/SSE 路由、agent discovery、run/connect/stop 生命周期和传输协议。
- 即使使用 CopilotKit runtime transport adapter，也禁止让 CopilotKit 接管 tool calling、frontend/backend actions、state/context 注入、LLM 调用编排、AI SDK stream conversion、MCP/A2UI/generative UI、tool result 后是否继续回答、消息修复或持久化语义。
- AI 对话的后端逻辑必须由 ai2nao 自己掌控：模型调用、server-side tools、RAG、Web Search、tool result 回传、多步推理、消息持久化和可见输出都必须在 ai2nao 后端实现。
- 前端可以通过 CopilotKit 组件渲染聊天界面，但不得注册业务 tools，不得把 CopilotKit client-provided tools/page context 作为后端事实来源，不得让 CopilotKit 决定 tool 调用后模型是否继续回答。
- 如果未来引入或重构 CopilotKit runtime adapter，必须先抽出 ai2nao 自己的 turn runner，并补齐 parity/regression tests，证明 tools/context/state 被拒绝或忽略，Web Search/RAG tool result 会在同一轮综合成最终可见回答。

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming -> invoke office-hours
- Bugs, errors, "why is this broken", 500 errors -> invoke investigate
- Ship, deploy, push, create PR -> invoke ship
- QA, test the site, find bugs -> invoke qa
- Code review, check my diff -> invoke review
- Update docs after shipping -> invoke document-release
- Weekly retro -> invoke retro
- Design system, brand -> invoke design-consultation
- Visual audit, design polish -> invoke design-review
- Architecture review -> invoke plan-eng-review
- Save progress, checkpoint, resume -> invoke checkpoint
- Code quality, health check -> invoke health

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
