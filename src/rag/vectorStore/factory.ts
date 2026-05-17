import { defaultRagVectorDbPath } from "../../config.js";
import { expandUserPath } from "../../path/expandUserPath.js";
import type { RagConfigV1 } from "../types.js";
import { LanceDbVectorStore } from "./lancedbStore.js";
import { NullVectorStore } from "./nullStore.js";
import type { RagVectorStore } from "./types.js";

export function createVectorStore(cfg: RagConfigV1 | null): RagVectorStore {
  const store = cfg?.vectorStore;
  if (store?.provider !== "lancedb") {
    return new NullVectorStore();
  }
  return new LanceDbVectorStore(expandUserPath(store.path ?? defaultRagVectorDbPath()));
}
