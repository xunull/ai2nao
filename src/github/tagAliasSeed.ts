/**
 * Initial alias dictionary for GitHub topics → canonical tags. This is data,
 * not schema, so it lives outside migrations v6 and is seeded on demand via
 * `ai2nao github tags alias seed`. Seeding is idempotent (INSERT OR IGNORE),
 * so running it twice is safe and running it after the user already edited
 * `gh_tag_alias` will not clobber user entries.
 *
 * Design note: entries are chosen to collapse the highest-frequency noise on
 * GitHub (js vs javascript, ml vs machine-learning, agent vs agents) without
 * over-merging. We do NOT try to normalize every possible variant — users can
 * add their own via `ai2nao github tags alias add`.
 *
 * All keys and values are already lowercase; the rebuild pass lowercases
 * incoming topics before alias lookup.
 */

export type TagAliasSeedEntry = {
  from: string;
  to: string;
  note?: string;
};

export const TAG_ALIAS_SEED: ReadonlyArray<TagAliasSeedEntry> = [
  // JavaScript / TypeScript family
  { from: "js", to: "javascript" },
  { from: "nodejs", to: "node" },
  { from: "node-js", to: "node" },
  { from: "ts", to: "typescript" },

  // Python family
  { from: "py", to: "python" },
  { from: "python3", to: "python" },

  // ML / AI family
  { from: "ml", to: "machine-learning" },
  { from: "machinelearning", to: "machine-learning" },
  { from: "dl", to: "deep-learning" },
  { from: "deeplearning", to: "deep-learning" },
  { from: "ai", to: "artificial-intelligence" },
  { from: "nlp", to: "natural-language-processing" },
  { from: "cv", to: "computer-vision" },

  // LLM / Agent family (the reason this feature exists)
  { from: "llms", to: "llm" },
  { from: "large-language-model", to: "llm" },
  { from: "large-language-models", to: "llm" },
  { from: "llm-app", to: "llm" },
  { from: "llm-apps", to: "llm" },
  { from: "llm-application", to: "llm" },
  { from: "ai-agent", to: "agent" },
  { from: "ai-agents", to: "agent" },
  { from: "agents", to: "agent" },
  { from: "autonomous-agent", to: "agent" },
  { from: "autonomous-agents", to: "agent" },
  { from: "rag", to: "retrieval-augmented-generation" },
  { from: "chatbot", to: "chatbots" },
  { from: "gpt-3", to: "gpt" },
  { from: "gpt-4", to: "gpt" },
  { from: "gpt3", to: "gpt" },
  { from: "gpt4", to: "gpt" },

  // Web / frontend family
  { from: "reactjs", to: "react" },
  { from: "react-js", to: "react" },
  { from: "vuejs", to: "vue" },
  { from: "vue-js", to: "vue" },
  { from: "nextjs", to: "next" },
  { from: "next-js", to: "next" },
  { from: "tailwind", to: "tailwindcss" },
  { from: "webdev", to: "web-development" },

  // Infra / devops family
  { from: "k8s", to: "kubernetes" },
  { from: "ci-cd", to: "cicd" },
  { from: "ci/cd", to: "cicd" },
  { from: "docker-compose", to: "docker" },

  // Database family
  { from: "postgres", to: "postgresql" },
  { from: "pg", to: "postgresql" },
  { from: "sqlite3", to: "sqlite" },

  // Tool / format
  { from: "cli-tool", to: "cli" },
  { from: "command-line-tool", to: "cli" },
  { from: "command-line", to: "cli" },
  { from: "vscode", to: "vs-code" },
  { from: "neovim", to: "nvim" },

  // Identity entries (intentional self-maps, block future auto-collapse)
  { from: "typescript", to: "typescript", note: "identity; prevents drift" },
  { from: "python", to: "python", note: "identity; prevents drift" },
  { from: "rust", to: "rust", note: "identity; prevents drift" },
  { from: "go", to: "go", note: "identity; prevents drift" },
];
