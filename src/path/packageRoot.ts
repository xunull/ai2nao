import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where is *this* installation of ai2nao rooted?
 *
 * Two things used to answer that question by guessing, and both were wrong the
 * moment you ran from anywhere but the project directory:
 *   - `resolveWebDist()` was `join(process.cwd(), "web", "dist")` — outside the
 *     repo it found nothing and `serve` silently degraded to api-only. No error,
 *     just no UI.
 *   - the CLI version was the literal `"0.1.0"` while package.json had reached
 *     0.4.0.
 *
 * Both now resolve from this module's own location instead, which is stable in
 * every shape ai2nao actually runs in:
 *
 *   tsx      <repo>/src/path/packageRoot.ts       ──┐
 *   dist     <repo>/dist/path/packageRoot.js      ──┼──▶ <repo>
 *   npm -g   <prefix>/lib/node_modules/ai2nao/
 *              dist/path/packageRoot.js           ────▶ <prefix>/lib/node_modules/ai2nao
 *
 * Deliberately NOT handled: an Electron `.app` bundle. Under the desktop-shell
 * design (Approach A) the daemon is installed from npm and never lives inside the
 * shell's .app; the shell resolves its own resources through Electron's
 * `app.getAppPath()`. Teaching this helper about .app would bind two
 * independently-released artifacts into a runtime model that does not exist.
 */

const PACKAGE_NAME = "ai2nao";

/**
 * Walk up from `startDir` until we hit the directory whose package.json declares
 * `name === pkgName`. Returns null if we reach the filesystem root without one.
 *
 * We match on the NAME rather than taking the first package.json we see: if
 * ai2nao is ever vendored under another project, the nearest package.json going
 * up belongs to the host app, and silently returning it would resolve web/dist
 * into somebody else's tree. Failing loudly beats resolving to the wrong root.
 */
export function findPackageRoot(startDir: string, pkgName: string = PACKAGE_NAME): string | null {
  const { root: fsRoot } = parse(startDir);
  let dir = startDir;
  for (;;) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      if ((JSON.parse(raw) as { name?: unknown }).name === pkgName) return dir;
    } catch {
      // Missing, unreadable, or malformed package.json — not our root, keep walking.
    }
    if (dir === fsRoot) return null;
    const parent = dirname(dir);
    // `dirname("/")` is "/" — the fsRoot check above already covers it, but a
    // relative path with no parent would loop forever without this.
    if (parent === dir) return null;
    dir = parent;
  }
}

let cachedRoot: string | undefined;

/**
 * The root of this ai2nao installation. Computed once — it cannot change while
 * the process lives, and both the version read and the web/dist lookup call it.
 *
 * Throws rather than returning a fallback: a wrong root means "no UI, no error"
 * (the exact failure this helper exists to kill), so guessing is worse than
 * stopping.
 */
export function packageRoot(): string {
  if (cachedRoot !== undefined) return cachedRoot;
  const here = dirname(fileURLToPath(import.meta.url));
  const found = findPackageRoot(here);
  if (found === null) {
    throw new Error(
      `Unable to locate the ${PACKAGE_NAME} package root walking up from ${here}. ` +
        `This build looks incomplete — package.json should sit above dist/ or src/.`
    );
  }
  cachedRoot = found;
  return cachedRoot;
}

let cachedVersion: string | undefined;

/** The version from package.json — the single source of truth for `--version` and /api/health. */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  const raw = readFileSync(join(packageRoot(), "package.json"), "utf8");
  const version = (JSON.parse(raw) as { version?: unknown }).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${PACKAGE_NAME}/package.json has no usable "version" field.`);
  }
  cachedVersion = version;
  return cachedVersion;
}
