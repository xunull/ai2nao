import { parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { loadPyodide } from "pyodide";
import type { CodeRunnerInputFile, CodeRunnerLimits, CodeRunnerOutputFile } from "./types.js";

type WorkerRequest = {
  code: string;
  stdin: string;
  files: CodeRunnerInputFile[];
  limits: CodeRunnerLimits;
};

type WorkerResponse =
  | {
      ok: true;
      stdout: string;
      stderr: string;
      files: CodeRunnerOutputFile[];
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
    }
  | {
      ok: false;
      stdout: string;
      stderr: string;
      files: CodeRunnerOutputFile[];
      stdoutTruncated: boolean;
      stderrTruncated: boolean;
      error: string;
    };

if (!parentPort) throw new Error("pyodideWorker must run inside a worker thread.");

parentPort.on("message", async (request: WorkerRequest) => {
  try {
    parentPort?.postMessage(await runInPyodide(request));
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      stdout: "",
      stderr: "",
      files: [],
      stdoutTruncated: false,
      stderrTruncated: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse);
  }
});

async function runInPyodide(request: WorkerRequest): Promise<WorkerResponse> {
  const stdout = new OutputBuffer(request.limits.maxOutputChars);
  const stderr = new OutputBuffer(request.limits.maxOutputChars);
  const stdin = new LineInput(request.stdin);
  const indexURL = fileURLToPath(new URL("./", import.meta.resolve("pyodide")));
  const pyodide = await loadPyodide({
    indexURL,
    jsglobals: Object.freeze(Object.create(null)),
    packages: [],
    stdout: (chunk) => stdout.push(chunk),
    stderr: (chunk) => stderr.push(chunk),
    stdin: () => stdin.next(),
  });

  pyodide.FS.mkdirTree("/workspace");
  pyodide.FS.chdir("/workspace");
  for (const file of request.files) {
    const path = `/workspace/${file.name}`;
    const dir = path.slice(0, path.lastIndexOf("/"));
    pyodide.FS.mkdirTree(dir);
    pyodide.FS.writeFile(path, file.content);
  }

  try {
    await pyodide.runPythonAsync(`${securityPrelude()}\n${request.code}`, {
      filename: "/workspace/main.py",
    });
    return {
      ok: true,
      stdout: stdout.value(),
      stderr: stderr.value(),
      files: collectOutputFiles(pyodide.FS, request.files, request.limits),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: stdout.value(),
      stderr: stderr.value(),
      files: collectOutputFiles(pyodide.FS, request.files, request.limits),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function securityPrelude(): string {
  return String.raw`
import builtins
import sys
import importlib.abc

_AI2NAO_BLOCKED_IMPORTS = {
    "js",
    "pyodide",
    "pyodide_js",
    "micropip",
    "socket",
    "ssl",
    "http",
    "urllib",
    "requests",
    "subprocess",
    "multiprocessing",
}

for _name in list(sys.modules):
    if _name in _AI2NAO_BLOCKED_IMPORTS or any(_name.startswith(_blocked + ".") for _blocked in _AI2NAO_BLOCKED_IMPORTS):
        sys.modules.pop(_name, None)

class _Ai2NaoBlockedImportFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in _AI2NAO_BLOCKED_IMPORTS or any(fullname.startswith(_blocked + ".") for _blocked in _AI2NAO_BLOCKED_IMPORTS):
            raise ImportError(f"ai2nao_run_code blocks importing {fullname!r} in the local sandbox")
        return None

sys.meta_path.insert(0, _Ai2NaoBlockedImportFinder())
_ai2nao_original_import = builtins.__import__

def _ai2nao_guarded_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if root in _AI2NAO_BLOCKED_IMPORTS:
        raise ImportError(f"ai2nao_run_code blocks importing {name!r} in the local sandbox")
    return _ai2nao_original_import(name, globals, locals, fromlist, level)

builtins.__import__ = _ai2nao_guarded_import
`;
}

function collectOutputFiles(
  fs: PyodideFileSystem,
  inputFiles: CodeRunnerInputFile[],
  limits: CodeRunnerLimits
): CodeRunnerOutputFile[] {
  const inputNames = new Set(inputFiles.map((file) => file.name));
  const found: CodeRunnerOutputFile[] = [];
  const visit = (dir: string, prefix: string) => {
    for (const entry of fs.readdir(dir)) {
      if (entry === "." || entry === "..") continue;
      const fullPath = `${dir}/${entry}`;
      const relativePath = prefix ? `${prefix}/${entry}` : entry;
      const stat = fs.stat(fullPath);
      if (fs.isDir(stat.mode)) {
        visit(fullPath, relativePath);
        continue;
      }
      if (inputNames.has(relativePath) || found.length >= limits.maxOutputFileCount) continue;
      const data = fs.readFile(fullPath);
      const sizeBytes = data.byteLength;
      if (sizeBytes > limits.maxOutputFileBytes) {
        found.push({ name: relativePath, sizeBytes });
        continue;
      }
      found.push({
        name: relativePath,
        sizeBytes,
        preview: decodePreview(data),
      });
    }
  };
  visit("/workspace", "");
  return found;
}

type PyodideFileSystem = {
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  readFile(path: string): Uint8Array;
};

function decodePreview(data: Uint8Array): string | undefined {
  const preview = new TextDecoder("utf-8", { fatal: false }).decode(data.slice(0, 4_096));
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(preview)) return undefined;
  return preview;
}

class OutputBuffer {
  truncated = false;
  #value = "";
  #maxChars: number;

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  push(chunk: string): void {
    if (this.#value.length >= this.#maxChars) {
      this.truncated = true;
      return;
    }
    const next = this.#value + chunk + "\n";
    if (next.length > this.#maxChars) {
      this.#value = next.slice(0, this.#maxChars);
      this.truncated = true;
      return;
    }
    this.#value = next;
  }

  value(): string {
    return this.#value.replace(/\n$/, "");
  }
}

class LineInput {
  #lines: string[];
  #index = 0;

  constructor(value: string) {
    this.#lines = value.split(/\r?\n/);
  }

  next(): string | null {
    if (this.#index >= this.#lines.length) return null;
    return this.#lines[this.#index++] ?? null;
  }
}
