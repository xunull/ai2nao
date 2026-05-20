import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodeRunnerStatus, DockerCodeRunnerStatus } from "./types.js";

const execFile = promisify(nodeExecFile);
export const DEFAULT_DOCKER_PYTHON_IMAGE = "python:3.12-slim-bookworm";

export async function getCodeRunnerStatus(options: {
  dockerImage?: string;
  exec?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
} = {}): Promise<CodeRunnerStatus> {
  return {
    pyodide: { available: true },
    docker: await getDockerCodeRunnerStatus(options),
  };
}

export async function getDockerCodeRunnerStatus(options: {
  dockerImage?: string;
  exec?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
} = {}): Promise<DockerCodeRunnerStatus> {
  const image = options.dockerImage ?? DEFAULT_DOCKER_PYTHON_IMAGE;
  const exec = options.exec ?? execFile;
  try {
    const version = await exec("docker", ["--version"]);
    let imagePresent = false;
    try {
      await exec("docker", ["image", "inspect", image]);
      imagePresent = true;
    } catch {
      imagePresent = false;
    }
    return {
      available: imagePresent,
      dockerVersion: version.stdout.trim(),
      image,
      imagePresent,
      error: imagePresent ? null : `Docker image is not present: ${image}`,
    };
  } catch (error) {
    return {
      available: false,
      dockerVersion: null,
      image,
      imagePresent: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
