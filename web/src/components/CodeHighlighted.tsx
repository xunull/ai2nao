import "../prismLanguages.js";
import { Prism } from "../prismSetup.js";
import { Highlight, themes, type Token } from "prism-react-renderer";

const ALIAS: Record<string, string> = {
  ts: "typescript",
  typescript: "typescript",
  js: "javascript",
  javascript: "javascript",
  jsx: "jsx",
  tsx: "tsx",
  json: "json",
  jsonc: "json",
  sh: "bash",
  shell: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  python: "python",
  yml: "yaml",
  yaml: "yaml",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  sql: "sql",
  css: "css",
  scss: "scss",
  sass: "scss",
  html: "markup",
  xml: "markup",
  vue: "markup",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
};

function resolvePrismLanguage(tag: string): string | null {
  const raw = tag.toLowerCase().trim();
  if (!raw || raw === "text" || raw === "txt" || raw === "plain") {
    return null;
  }
  const lang = ALIAS[raw] ?? raw;
  return Prism.languages[lang] ? lang : null;
}

type Props = {
  code: string;
  /** 围栏上的语言标记，如 ts、json、bash */
  language: string;
  className?: string;
};

/** 多语言围栏高亮；未知语言退化为等宽原文块 */
export function CodeHighlighted({ code, language, className }: Props) {
  const lang = resolvePrismLanguage(language);
  if (!lang) {
    return (
      <pre
        className={[
          "m-0 whitespace-pre-wrap break-words p-3 text-sm font-mono bg-neutral-100 text-[var(--fg)] overflow-x-auto",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {code}
      </pre>
    );
  }

  return (
    <Highlight prism={Prism} theme={themes.vsLight} code={code} language={lang}>
      {({ className: prismPreClass, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={[prismPreClass, "m-0 p-3 text-sm overflow-x-auto", className]
            .filter(Boolean)
            .join(" ")}
          style={style}
        >
          {tokens.map((line: Token[], i: number) => (
            <div key={i} {...getLineProps({ line })}>
              {line.map((token: Token, key: number) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}
