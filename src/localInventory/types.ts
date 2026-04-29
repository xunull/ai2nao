export type LocalInventorySource = "mac_apps" | "brew" | "huggingface";

export type SyncRunStatus = "running" | "success" | "partial" | "failed";

export type InventoryWarning = {
  code: string;
  message: string;
  path?: string;
};

export type SyncCounts = {
  inserted: number;
  updated: number;
  markedMissing: number;
};
