import type { BashPermissionDecision, BashToolRisk } from "./types.js";

const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50;

const READ_ONLY_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "cat",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
  "cut",
  "grep",
  "rg",
  "sed",
  "awk",
  "stat",
  "file",
  "diff",
  "git",
  "npm",
  "node",
]);

const PROJECT_COMMANDS = new Set(["npm"]);

const BLOCKED_FIRST_WORDS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "sudo",
  "su",
  "env",
  "xargs",
  "curl",
  "wget",
  "nc",
  "netcat",
  "ssh",
  "scp",
  "rsync",
  "ftp",
  "telnet",
  "docker",
  "kubectl",
  "dd",
  "mkfs",
  "mount",
  "umount",
  "chmod",
  "chown",
  "chgrp",
  "rm",
  "rmdir",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "tee",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  ".",
]);

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\0/, reason: "命令包含 NUL 字节。" },
  { pattern: /`/, reason: "命令包含反引号命令替换。" },
  { pattern: /\$\s*\(/, reason: "命令包含 $() 命令替换。" },
  { pattern: /\$\s*\{/, reason: "命令包含 ${} 参数展开，已拒绝以避免 shell 注入绕过。" },
  { pattern: /\$\s*\[/, reason: "命令包含 $[] 算术展开，已拒绝以避免 shell 注入绕过。" },
  { pattern: /<\s*\(/, reason: "命令包含 process substitution。" },
  { pattern: />\s*\(/, reason: "命令包含 process substitution。" },
  { pattern: /<<<?\s*\w*/, reason: "命令包含 heredoc/herestring。" },
  { pattern: /(^|[^&])&($|[^&])/, reason: "命令包含后台执行操作符 &。" },
  { pattern: /(^|[^\\])>\s*[^&]/, reason: "命令包含文件输出重定向。" },
  { pattern: /(^|[^\\])>>/, reason: "命令包含追加重定向。" },
  { pattern: /(^|[^\\])<\s*[^&]/, reason: "命令包含文件输入重定向。" },
  { pattern: /\|\s*(sh|bash|zsh|python|python3|node|ruby|perl)\b/, reason: "命令管道进入二级解释器。" },
  { pattern: /\b(eval|exec|source)\b/, reason: "命令包含 eval/exec/source 类执行语义。" },
  { pattern: /\b(PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|NODE_OPTIONS|PYTHONPATH|BASH_ENV|ENV|SHELL|HOME)\s*=/, reason: "命令设置了会改变执行语义的环境变量。" },
];

const NPM_READ_ONLY_SCRIPTS = new Set([
  "test",
  "test:unit",
  "test:e2e",
  "lint",
  "typecheck",
  "check",
  "build",
  "smoke",
]);

const GIT_READ_ONLY_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "grep",
  "describe",
  "remote",
]);

const NODE_ALLOWED_FLAGS = new Set(["--version", "-v"]);

export function checkBashPermission(command: string): BashPermissionDecision {
  const normalizedCommand = command.trim();
  if (!normalizedCommand) {
    return { allow: false, reason: "命令不能为空。" };
  }

  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(normalizedCommand)) {
      return { allow: false, reason: rule.reason };
    }
  }

  const split = splitShellSubcommands(normalizedCommand);
  if (!split.ok) return { allow: false, reason: split.reason };
  if (split.subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) {
    return { allow: false, reason: "命令包含过多子命令，需要拆分后再执行。" };
  }

  let overallRisk: BashToolRisk = "read-only";
  for (const subcommand of split.subcommands) {
    const decision = classifySubcommand(subcommand);
    if (!decision.allow) return decision;
    if (decision.risk === "project-command") overallRisk = "project-command";
  }

  return {
    allow: true,
    risk: overallRisk,
    normalizedCommand,
    subcommands: split.subcommands,
  };
}

function classifySubcommand(subcommand: string): BashPermissionDecision {
  const tokens = tokenizeShellWords(subcommand);
  if (!tokens.ok) return { allow: false, reason: tokens.reason };
  if (tokens.words.length === 0) return { allow: false, reason: "命令片段为空。" };

  const first = tokens.words[0]!;
  if (BLOCKED_FIRST_WORDS.has(first)) {
    return { allow: false, reason: `命令 '${first}' 不在受控 Bash tool 的允许范围内。` };
  }

  if (first === "git") return classifyGit(tokens.words);
  if (first === "npm") return classifyNpm(tokens.words);
  if (first === "node") return classifyNode(tokens.words);
  if (first === "sed") return classifySed(tokens.words);
  if (first === "awk") return classifyAwk(tokens.words);
  if (first === "find") return classifyFind(tokens.words);

  if (!READ_ONLY_COMMANDS.has(first) && !PROJECT_COMMANDS.has(first)) {
    return {
      allow: true,
      risk: "project-command",
      normalizedCommand: subcommand,
      subcommands: [subcommand],
    };
  }

  return { allow: true, risk: "read-only", normalizedCommand: subcommand, subcommands: [subcommand] };
}

function classifyGit(words: string[]): BashPermissionDecision {
  const sub = words.find((word, index) => index > 0 && !word.startsWith("-"));
  if (!sub || !GIT_READ_ONLY_SUBCOMMANDS.has(sub)) {
    return { allow: false, reason: "只允许 git 的只读子命令。" };
  }
  return { allow: true, risk: "read-only", normalizedCommand: words.join(" "), subcommands: [words.join(" ")] };
}

function classifyNpm(words: string[]): BashPermissionDecision {
  if (words[1] !== "run") {
    return { allow: false, reason: "只允许 npm run <safe-script> 形式。" };
  }
  const script = words[2];
  if (!script || !NPM_READ_ONLY_SCRIPTS.has(script)) {
    return { allow: true, risk: "project-command", normalizedCommand: words.join(" "), subcommands: [words.join(" ")] };
  }
  return { allow: true, risk: "project-command", normalizedCommand: words.join(" "), subcommands: [words.join(" ")] };
}

function classifyNode(words: string[]): BashPermissionDecision {
  if (words.length === 2 && NODE_ALLOWED_FLAGS.has(words[1]!)) {
    return { allow: true, risk: "read-only", normalizedCommand: words.join(" "), subcommands: [words.join(" ")] };
  }
  return { allow: false, reason: "node 只允许版本查询；不要通过 Bash tool 执行任意 JS。" };
}

function classifySed(words: string[]): BashPermissionDecision {
  if (words.some((word) => word === "-i" || word.startsWith("-i"))) {
    return { allow: false, reason: "sed -i 会修改文件，已拒绝。" };
  }
  return { allow: true, risk: "read-only", normalizedCommand: words.join(" "), subcommands: [words.join(" ")] };
}

function classifyAwk(words: string[]): BashPermissionDecision {
  if (words.some((word) => /\bsystem\s*\(/.test(word))) {
    return { allow: false, reason: "awk system() 可以执行任意命令，已拒绝。" };
  }
  return { allow: true, risk: "read-only", normalizedCommand: words.join(" "), subcommands: [words.join(" ")] };
}

function classifyFind(words: string[]): BashPermissionDecision {
  if (words.some((word) => ["-exec", "-execdir", "-delete", "-ok", "-okdir"].includes(word))) {
    return { allow: false, reason: "find 的执行/删除动作已拒绝。" };
  }
  return { allow: true, risk: "read-only", normalizedCommand: words.join(" "), subcommands: [words.join(" ")] };
}

type SplitResult =
  | { ok: true; subcommands: string[] }
  | { ok: false; reason: string };

export function splitShellSubcommands(command: string): SplitResult {
  const subcommands: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      current += ch;
      quote = ch;
      continue;
    }

    const isOperator =
      ch === ";" ||
      ch === "|" ||
      (ch === "&" && next === "&") ||
      (ch === "|" && next === "|");
    if (isOperator) {
      if (current.trim()) subcommands.push(current.trim());
      current = "";
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) i++;
      continue;
    }
    current += ch;
  }

  if (quote) return { ok: false, reason: "命令包含未闭合引号。" };
  if (current.trim()) subcommands.push(current.trim());
  if (subcommands.length === 0) return { ok: false, reason: "命令没有可执行片段。" };
  return { ok: true, subcommands };
}

type TokenizeResult =
  | { ok: true; words: string[] }
  | { ok: false; reason: string };

function tokenizeShellWords(command: string): TokenizeResult {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote) return { ok: false, reason: "命令包含未闭合引号。" };
  if (escaped) current += "\\";
  if (current) words.push(current);
  return { ok: true, words };
}
