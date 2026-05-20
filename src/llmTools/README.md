# LLM Tools

This directory is the single entry point for AI-callable server-side tools.

It contains adapter code only:

- `registry.ts` decides which tools are available for a turn.
- `forwardedProps.ts` parses UI capability flags.
- `*Tool.ts` files wrap domain services as AI SDK `tool()` definitions.
- `evidence.ts` defines the shared evidence result envelope returned to the model.

Domain services stay outside this directory:

- Web search implementation lives in `src/webSearch/`.
- Session memory search implementation lives in `src/sessionMemory/`.
- RAG retrieval implementation lives in `src/rag/`.
- Local code execution implementation lives in `src/codeRunner/`.

Rule of thumb: if the code is about tool name, input schema, enabled flags, or
LLM evidence output, it belongs here. If the code implements a reusable capability,
keep it in that capability's domain directory and import it from an adapter here.
