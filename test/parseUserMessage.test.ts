import { describe, expect, it } from "vitest";
import {
  parseUserMessage,
  hasCommandInjection,
} from "../web/src/util/parseUserMessage.js";

describe("parseUserMessage —— user 消息切段", () => {
  it("纯真人正文 → 单个 text 段", () => {
    expect(parseUserMessage("继续把这个功能做完")).toEqual([
      { kind: "text", text: "继续把这个功能做完" },
    ]);
  });

  it("斜杠命令三字段聚成一个 command 段", () => {
    const raw =
      "<command-message>graphify</command-message>\n" +
      "<command-name>/graphify</command-name>\n" +
      "<command-args>--full</command-args>";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "command", message: "graphify", name: "/graphify", args: "--full" },
    ]);
  });

  it("空 args 也收进 command 段(值为空串)", () => {
    const raw =
      "<command-name>/model</command-name><command-args></command-args>";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "command", name: "/model", args: "" },
    ]);
  });

  it("stdout 段:内容原样(不解析 SGR,交给渲染层)", () => {
    const raw =
      "<local-command-stdout>Set model to [1mOpus[22m</local-command-stdout>";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "stdout", raw: "Set model to [1mOpus[22m" },
    ]);
  });

  it("caveat 段", () => {
    const raw =
      "<local-command-caveat>Caveat: DO NOT respond</local-command-caveat>";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "caveat", text: "Caveat: DO NOT respond" },
    ]);
  });

  it("四形状混合按出现顺序(真实 /model 那种)", () => {
    const raw =
      "<command-name>/model</command-name>\n<command-args></command-args>\n" +
      "<local-command-stdout>Set model to [1mOpus[22m</local-command-stdout>\n" +
      "接着按计划实现";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "command", name: "/model", args: "" },
      { kind: "stdout", raw: "Set model to [1mOpus[22m" },
      { kind: "text", text: "\n接着按计划实现" },
    ]);
  });

  it("两条命令背靠背 → 两个 command 段(字段占用即另起)", () => {
    const raw =
      "<command-name>/a</command-name><command-name>/b</command-name>";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "command", name: "/a" },
      { kind: "command", name: "/b" },
    ]);
  });

  it("乱序:stdout 在 command 之前", () => {
    const raw =
      "<local-command-stdout>out</local-command-stdout><command-name>/x</command-name>";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "stdout", raw: "out" },
      { kind: "command", name: "/x" },
    ]);
  });

  it("未闭合标签 → 落进 text 段原样保留(不吃后续)", () => {
    const raw = "<command-name>/x 后面没闭合 还有正文";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "text", text: "<command-name>/x 后面没闭合 还有正文" },
    ]);
  });

  it("stdout 内部字面 <command-name> 不被当控制结构(非贪婪吞整块)", () => {
    const raw =
      "<local-command-stdout>echo <command-name> literal</local-command-stdout>";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "stdout", raw: "echo <command-name> literal" },
    ]);
  });

  it("bash 输入/输出:input 当命令名、stdout 当输出", () => {
    const raw =
      "<bash-input>ls -la</bash-input><bash-stdout>total 0</bash-stdout>";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "command", name: "ls -la" },
      { kind: "stdout", raw: "total 0" },
    ]);
  });

  it("命令字段之间的纯空白不打断聚合、不产生 text 段", () => {
    const raw =
      "<command-name>/x</command-name>   \n  <command-args>a</command-args>";
    expect(parseUserMessage(raw)).toEqual([
      { kind: "command", name: "/x", args: "a" },
    ]);
  });

  it("hasCommandInjection:有标签 true、纯正文 false", () => {
    expect(hasCommandInjection("<command-name>/x</command-name>")).toBe(true);
    expect(hasCommandInjection("就是普通一句话")).toBe(false);
  });
});
