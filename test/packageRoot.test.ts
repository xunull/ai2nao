import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPackageRoot, packageRoot, packageVersion } from "../src/path/packageRoot.js";

/**
 * Why this exists: `resolveWebDist()` used to be `join(process.cwd(), "web", "dist")`
 * and the CLI version was a hardcoded string. Both broke the same way — they were
 * only correct when you happened to run from the project directory. Running
 * `ai2nao serve` from anywhere else silently degraded to api-only (no UI, no error),
 * and `ai2nao --version` printed 0.1.0 while package.json said 0.4.0.
 *
 * Both now go through packageRoot(), so this file is the single place that proves
 * the resolution works in every shape ai2nao actually runs in:
 *
 *   tsx      <repo>/src/path/packageRoot.ts      ──┐
 *   dist     <repo>/dist/path/packageRoot.js     ──┼──▶ <repo>
 *   npm -g   <prefix>/lib/node_modules/ai2nao/
 *              dist/path/packageRoot.js          ────▶ <prefix>/lib/node_modules/ai2nao
 *
 * NOT covered on purpose: an Electron `.app` bundle. Under Approach A the daemon is
 * installed from npm and never lives inside the shell's .app — the shell resolves its
 * own resources via Electron's app.getAppPath(). Teaching packageRoot() about .app
 * would bind two independently-released artifacts into a runtime model that does not
 * exist.
 */
describe("findPackageRoot — walks up to the owning package", () => {
  function freshRoot(): string {
    return mkdtempSync(join(tmpdir(), "ai2nao-pkgroot-"));
  }

  /** Write a package.json with the given name at `dir`. */
  function writePkg(dir: string, name: string, version = "9.9.9"): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version }));
  }

  it("tsx form: src/path → repo root", () => {
    const root = freshRoot();
    writePkg(root, "ai2nao");
    const start = join(root, "src", "path");
    mkdirSync(start, { recursive: true });
    expect(findPackageRoot(start)).toBe(root);
  });

  it("dist form: dist/path → repo root", () => {
    const root = freshRoot();
    writePkg(root, "ai2nao");
    const start = join(root, "dist", "path");
    mkdirSync(start, { recursive: true });
    expect(findPackageRoot(start)).toBe(root);
  });

  it("npm -g form: prefix/lib/node_modules/ai2nao/dist/path → the installed package", () => {
    const prefix = freshRoot();
    const installed = join(prefix, "lib", "node_modules", "ai2nao");
    writePkg(installed, "ai2nao");
    const start = join(installed, "dist", "path");
    mkdirSync(start, { recursive: true });
    expect(findPackageRoot(start)).toBe(installed);
  });

  it("starting AT the root itself works (not just from a subdirectory)", () => {
    const root = freshRoot();
    writePkg(root, "ai2nao");
    expect(findPackageRoot(root)).toBe(root);
  });

  it("skips a foreign package.json and keeps walking up", () => {
    // ai2nao vendored under some other project: the nearest package.json going up
    // belongs to the host app, not to us. Returning it would resolve web/dist into
    // the host's tree.
    const outer = freshRoot();
    writePkg(outer, "ai2nao");
    const inner = join(outer, "vendor", "some-other-pkg");
    writePkg(inner, "some-other-pkg");
    const start = join(inner, "dist", "path");
    mkdirSync(start, { recursive: true });
    expect(findPackageRoot(start)).toBe(outer);
  });

  it("returns null when no owning package.json exists above", () => {
    const root = freshRoot();
    const start = join(root, "a", "b");
    mkdirSync(start, { recursive: true });
    expect(findPackageRoot(start)).toBeNull();
  });

  it("ignores an unreadable / malformed package.json instead of throwing", () => {
    const root = freshRoot();
    writePkg(root, "ai2nao");
    const inner = join(root, "broken");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "package.json"), "{ this is not json");
    expect(findPackageRoot(inner)).toBe(root);
  });
});

describe("packageRoot / packageVersion — resolved against the real install", () => {
  it("packageRoot() lands on the checkout that owns this test", () => {
    const root = packageRoot();
    expect(existsSync(join(root, "package.json"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
    };
    expect(pkg.name).toBe("ai2nao");
    // The suite itself lives at <root>/test/, so that directory must be there too.
    expect(existsSync(join(root, "test", "packageRoot.test.ts"))).toBe(true);
  });

  it("packageVersion() is READ from package.json, not typed into the source", () => {
    const declared = (
      JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    expect(packageVersion()).toBe(declared);
    // Regression guard: cli.ts hardcoded "0.1.0" while package.json had moved to
    // 0.4.0, so `ai2nao --version` lied by three minor releases.
    expect(packageVersion()).not.toBe("0.1.0");
  });
});
