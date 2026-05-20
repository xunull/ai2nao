import { describe, expect, it } from "vitest";
import { createCodeRunnerService } from "../src/codeRunner/index.js";

describe("Pyodide code runner", () => {
  it("runs Python code and captures stdout", async () => {
    const runner = createCodeRunnerService();

    const result = await runner.run({
      language: "python",
      code: "print(1 + 1)",
    });

    expect(result.ok).toBe(true);
    expect(result.runtime).toBe("pyodide");
    expect(result.stdout.trim()).toBe("2");
    expect(result.stderr).toBe("");
  }, 30_000);

  it("writes input files into MEMFS and returns generated file previews", async () => {
    const runner = createCodeRunnerService();

    const result = await runner.run({
      language: "python",
      code: [
        "text = open('input.txt').read().strip()",
        "print(text.upper())",
        "open('out.txt', 'w').write(text[::-1])",
      ].join("\n"),
      files: [{ name: "input.txt", content: "ai2nao" }],
    });

    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe("AI2NAO");
    expect(result.files).toEqual([{ name: "out.txt", sizeBytes: 6, preview: "oan2ia" }]);
  }, 30_000);

  it("rejects host-path input files before starting the runner", async () => {
    const runner = createCodeRunnerService();

    const result = await runner.run({
      language: "python",
      code: "print('nope')",
      files: [{ name: "../secret.txt", content: "secret" }],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not allowed");
    expect(result.stdout).toBe("");
  });

  it("blocks JavaScript bridge and network-related imports inside Python", async () => {
    const runner = createCodeRunnerService();

    const result = await runner.run({
      language: "python",
      code: [
        "for name in ['js', 'pyodide_js', 'micropip', 'socket', 'subprocess']:",
        "    try:",
        "        __import__(name)",
        "        print('ALLOWED:' + name)",
        "    except ImportError:",
        "        print('BLOCKED:' + name)",
      ].join("\n"),
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("BLOCKED:js");
    expect(result.stdout).toContain("BLOCKED:pyodide_js");
    expect(result.stdout).toContain("BLOCKED:micropip");
    expect(result.stdout).toContain("BLOCKED:socket");
    expect(result.stdout).toContain("BLOCKED:subprocess");
    expect(result.stdout).not.toContain("ALLOWED:");
  }, 30_000);

  it("terminates long-running code on timeout", async () => {
    const runner = createCodeRunnerService({ limits: { timeoutMs: 3_000, maxTimeoutMs: 3_000 } });

    const result = await runner.run({
      language: "python",
      code: "while True:\n    pass",
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timed out");
  }, 10_000);
});
