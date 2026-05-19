export type ForwardedToolProps = {
  useRag: boolean;
  ragTopK: number;
  webSearchEnabled: boolean;
  sessionMemoryEnabled: boolean;
  sessionMemoryTopK: number;
};

export function parseForwardedToolProps(input: unknown): ForwardedToolProps {
  const props = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const rawRagTopK = parseInt(String(props.ragTopK ?? 8), 10);
  const rawSessionMemoryTopK = parseInt(String(props.sessionMemoryTopK ?? 8), 10);
  return {
    useRag: props.useRag === true,
    ragTopK: Math.min(20, Math.max(1, rawRagTopK || 8)),
    webSearchEnabled: props.webSearchEnabled === true,
    sessionMemoryEnabled: props.sessionMemoryEnabled === true,
    sessionMemoryTopK: Math.min(12, Math.max(1, rawSessionMemoryTopK || 8)),
  };
}
