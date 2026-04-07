import { Highlight, themes } from "prism-react-renderer";

type Props = {
  code: string;
  className?: string;
};

/** JSON 语法高亮（Prism.js + vsLight，与浅色页面一致） */
export function JsonHighlighted({ code, className }: Props) {
  return (
    <Highlight theme={themes.vsLight} code={code} language="json">
      {({ className: prismPreClass, style, tokens, getLineProps, getTokenProps }) => (
        <pre
          className={[prismPreClass, className].filter(Boolean).join(" ")}
          style={style}
        >
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })}>
              {line.map((token, key) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}
