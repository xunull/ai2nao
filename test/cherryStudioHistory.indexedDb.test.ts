import { describe, expect, it } from "vitest";
import {
  sessionFromCherryIndexedDbRecords,
  sessionsFromCherryIndexedDbRecords,
} from "../src/cherryStudioHistory/indexedDb.js";

describe("cherryStudioHistory IndexedDB records", () => {
  it("normalizes Dexie topics and message blocks into Cherry Studio sessions", () => {
    const topics = [
      {
        id: "topic-1",
        messages: [
          {
            id: "m1",
            role: "user",
            topicId: "topic-1",
            createdAt: "2026-05-01T00:00:00.000Z",
            blocks: ["b1"],
          },
          {
            id: "m2",
            role: "assistant",
            topicId: "topic-1",
            createdAt: "2026-05-01T00:01:00.000Z",
            model: { id: "model-a", name: "Model A" },
            usage: { promptTokens: 10, completionTokens: 20 },
            blocks: ["b2"],
          },
        ],
      },
    ];
    const messageBlocks = [
      { id: "b1", messageId: "m1", type: "main_text", content: "帮我读取 Cherry Studio 普通聊天" },
      { id: "b2", messageId: "m2", type: "main_text", content: "普通聊天位于 IndexedDB topics/message_blocks。" },
    ];
    const topicMetadata = [
      {
        id: "topic-1",
        name: "Cherry 自动命名的话题",
        assistantId: "default",
        assistantName: "默认助手",
        createdAt: "2026-05-01T00:00:10.000Z",
        updatedAt: "2026-05-01T00:02:00.000Z",
        isNameManuallyEdited: false,
      },
    ];

    const listed = sessionsFromCherryIndexedDbRecords({ topics, topicMetadata, messageBlocks, indexedDbPath: "/Cherry/IndexedDB/file__0.indexeddb.leveldb" });
    expect(listed.topicCount).toBe(1);
    expect(listed.sessions[0]).toMatchObject({
      id: "indexeddb:topic-1",
      title: "Cherry 自动命名的话题",
      messageCount: 2,
      source: "cherry-studio",
    });
    expect(listed.sessions[0]?.lastUpdatedAt.toISOString()).toBe("2026-05-01T00:02:00.000Z");
    expect(listed.sessions[0]?.metadata?.cherryStudio).toMatchObject({
      topicName: "Cherry 自动命名的话题",
      assistantName: "默认助手",
    });

    const loaded = sessionFromCherryIndexedDbRecords({ topics, topicMetadata, messageBlocks }, "indexeddb:topic-1");
    expect(loaded.session?.messages.map((m) => m.content)).toEqual([
      "帮我读取 Cherry Studio 普通聊天",
      "普通聊天位于 IndexedDB topics/message_blocks。",
    ]);
    expect(loaded.session?.messages[1].model).toBe("Model A");
    expect(loaded.session?.messages[1].tokenUsage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("falls back to the first message when a topic has no Cherry Studio name", () => {
    const listed = sessionsFromCherryIndexedDbRecords({
      topics: [
        {
          id: "topic-without-name",
          messages: [
            {
              id: "m1",
              role: "user",
              topicId: "topic-without-name",
              createdAt: "2026-05-01T00:00:00.000Z",
              blocks: ["b1"],
            },
          ],
        },
      ],
      messageBlocks: [
        { id: "b1", messageId: "m1", type: "main_text", content: "没有 topic.name 时才用首条消息" },
      ],
    });

    expect(listed.sessions[0]?.title).toBe("没有 topic.name 时才用首条消息");
  });

  it("keeps a session readable when a topic has missing or malformed blocks", () => {
    const loaded = sessionFromCherryIndexedDbRecords(
      {
        topics: [
          {
            id: "topic-2",
            messages: [
              {
                id: "m1",
                role: "assistant",
                createdAt: "bad-date",
                blocks: ["missing-block"],
              },
            ],
          },
        ],
        messageBlocks: [],
      },
      "indexeddb:topic-2"
    );

    expect(loaded.session?.title).toBe("Cherry topic topic-2");
    expect(loaded.session?.messages).toHaveLength(1);
    expect(loaded.session?.messages[0].content).toBe("");
    expect(loaded.session?.messages[0].metadata?.cherryMessageMetadata?.missingBlocks).toBe(1);
  });
});
