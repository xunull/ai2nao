import { build } from "esbuild";

/**
 * Bundle the Electron main process into one self-contained CJS file.
 *
 * ## Why bundle at all
 *
 * The shell imports `probeDaemon` and the notification rules from the daemon's
 * compiled output at `../../dist/`. That is a path that reaches *outside this
 * package*, which is fine while everything sits in one checkout and fatal the
 * moment the app is packaged: an `.app` bundle has no `../../dist` above it.
 *
 * Bundling resolves those imports at build time, so the packaged app carries the
 * code it needs instead of a relative path into a directory that will not exist.
 * `tsc` alone cannot do this — it rewrites nothing and emits the import as-is.
 *
 * ## Why ESM and not CJS
 *
 * Electron has supported ESM main processes since v28, and going through CJS
 * here is actively unsafe: the bundle pulls in `src/path/packageRoot.ts`, which
 * resolves the install root from `import.meta.url`. esbuild cannot express that
 * in CJS — it warns and emits something that breaks the moment the code path is
 * taken. Today the shell happens not to call it; "happens not to" is not a
 * property worth shipping.
 *
 * `electron` itself stays external: the runtime provides it and it must never be
 * pulled into the bundle.
 */
await build({
  entryPoints: ["src/main.ts"],
  outfile: "out/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
