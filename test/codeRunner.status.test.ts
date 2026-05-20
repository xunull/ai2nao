import { describe, expect, it } from "vitest";
import { getCodeRunnerStatus } from "../src/codeRunner/status.js";

describe("Code runner status", () => {
  it("reports Docker Python available when Docker and the image are present", async () => {
    const status = await getCodeRunnerStatus({
      exec: async (file, args) => {
        if (file === "docker" && args.join(" ") === "--version") {
          return { stdout: "Docker version 29.4.3\n", stderr: "" };
        }
        if (file === "docker" && args.join(" ") === "image inspect python:3.12-slim-bookworm") {
          return { stdout: "[]", stderr: "" };
        }
        throw new Error(`unexpected command: ${file} ${args.join(" ")}`);
      },
    });

    expect(status.pyodide.available).toBe(true);
    expect(status.docker.available).toBe(true);
    expect(status.docker.dockerVersion).toBe("Docker version 29.4.3");
    expect(status.docker.imagePresent).toBe(true);
    expect(status.docker.error).toBeNull();
  });

  it("keeps Docker disabled when the expected Python image is missing", async () => {
    const status = await getCodeRunnerStatus({
      exec: async (file, args) => {
        if (file === "docker" && args.join(" ") === "--version") {
          return { stdout: "Docker version 29.4.3\n", stderr: "" };
        }
        throw new Error(`missing image from ${file} ${args.join(" ")}`);
      },
    });

    expect(status.docker.available).toBe(false);
    expect(status.docker.dockerVersion).toBe("Docker version 29.4.3");
    expect(status.docker.imagePresent).toBe(false);
    expect(status.docker.error).toContain("Docker image is not present");
  });
});
