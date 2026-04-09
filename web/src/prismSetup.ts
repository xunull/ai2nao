import Prism from "prismjs";

const g = globalThis as unknown as { Prism?: typeof Prism };
if (!g.Prism) {
  g.Prism = Prism;
}

export { Prism };
