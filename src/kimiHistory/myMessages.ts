import { readFileSync, statSync } from "node:fs";
import { parseKimiWire } from "./normalize.js";
import { kimiProjectPath, readKimiSessionMeta } from "./scan.js";
import type { KimiWireFile } from "./types.js";

export { KIMI_CLEANER_VERSION, KIMI_PARSER_VERSION } from "./normalize.js";

/**
 * 单文件上限。实测最大的 wire.jsonl 是 5.9 MB;留 10 倍余量,超了当解析失败处理
 * (由调用方钳住水位,而不是静默跳过 —— 那正是 7de68d1 修的那个坑)。
 */
const MAX_WIRE_BYTES = 64 * 1024 * 1024;

/** 供 ingest 直接落库的一行。 */
export type KimiExtracted = {
  messageKey: string;
  role: "user" | "assistant";
  eventAtMs: number;
  rawText: string;
  rawPayloadJson: string;
  cleanedText: string;
  isHuman: boolean;
  answeringUserKey: string | null;
};

export type KimiFileExtraction = {
  sessionId: string;
  /** state.json 的 workDir,沙箱默认值已归成 null。 */
  projectPath: string | null;
  messages: KimiExtracted[];
  multiPartTurns: number;
};

/**
 * **唯一的抽取口径。** 以后做 kimi 的会话详情页 / 阅读模式抽屉时也走这里,
 * 不要在别处再写一份判据(claude 那边的 parity 测试就是为这件事存在的)。
 *
 * kimi 不需要像 claude 那样剥控制标签:它的 user 正文是干净的 text part,
 * 注入内容走 origin.kind 区分而不是混在正文里。所以 cleanedText === rawText。
 */
export function extractKimiMessages(file: KimiWireFile): KimiFileExtraction {
  const st = statSync(file.filePath);
  if (st.size > MAX_WIRE_BYTES) {
    throw new Error(`wire.jsonl 过大(${st.size} 字节): ${file.filePath}`);
  }
  const meta = readKimiSessionMeta(file.filePath);
  const { messages, multiPartTurns } = parseKimiWire(
    readFileSync(file.filePath, "utf-8").split(String.fromCharCode(10)),
    { agent: file.agent }
  );

  return {
    sessionId: file.sessionId,
    projectPath: kimiProjectPath(meta),
    multiPartTurns,
    messages: messages.map((m) => ({
      messageKey: m.messageKey,
      role: m.role,
      eventAtMs: m.eventAtMs,
      rawText: m.text,
      rawPayloadJson: m.rawPayloadJson,
      cleanedText: m.cleanedText,
      isHuman: m.isHuman,
      answeringUserKey: m.answeringUserKey,
    })),
  };
}
