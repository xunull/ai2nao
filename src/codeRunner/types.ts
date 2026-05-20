export type CodeRunnerLanguage = "python";
export type CodeRunnerRuntime = "pyodide" | "docker";

export type CodeRunnerInputFile = {
  name: string;
  content: string;
};

export type CodeRunnerRequest = {
  runtime?: CodeRunnerRuntime;
  language: CodeRunnerLanguage;
  code: string;
  stdin?: string;
  files?: CodeRunnerInputFile[];
  reason?: string;
  timeoutMs?: number;
};

export type CodeRunnerOutputFile = {
  name: string;
  sizeBytes: number;
  preview?: string;
};

export type CodeRunnerLimits = {
  timeoutMs: number;
  maxTimeoutMs: number;
  maxCodeChars: number;
  maxStdinChars: number;
  maxFileCount: number;
  maxInputFileBytes: number;
  maxTotalInputFileBytes: number;
  maxOutputChars: number;
  maxOutputFileCount: number;
  maxOutputFileBytes: number;
};

export type CodeRunnerResult = {
  ok: boolean;
  runtime: CodeRunnerRuntime;
  language: CodeRunnerLanguage;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  files: CodeRunnerOutputFile[];
  limits: {
    timeoutMs: number;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
  };
  error?: string;
};

export type CodeRunnerService = {
  run(request: CodeRunnerRequest, options?: { signal?: AbortSignal }): Promise<CodeRunnerResult>;
};

export type DockerCodeRunnerStatus = {
  available: boolean;
  dockerVersion: string | null;
  image: string;
  imagePresent: boolean;
  error: string | null;
};

export type CodeRunnerStatus = {
  pyodide: { available: true };
  docker: DockerCodeRunnerStatus;
};
