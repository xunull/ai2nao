import type Database from "better-sqlite3";

export function deleteChunksForFile(
  db: Database.Database,
  sourceRoot: string,
  filePath: string
): void {
  const sel = db.prepare(
    "SELECT id FROM rag_chunks WHERE source_root = ? AND file_path = ?"
  );
  const ids = sel.all(sourceRoot, filePath) as { id: number }[];
  const delFts = db.prepare("DELETE FROM rag_chunks_fts WHERE chunk_id = ?");
  const delRow = db.prepare("DELETE FROM rag_chunks WHERE id = ?");
  const tx = db.transaction(() => {
    for (const { id } of ids) {
      delFts.run(id);
      delRow.run(id);
    }
  });
  tx();
}
