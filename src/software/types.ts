import type {
  InventoryWarning,
  LocalInventorySource,
  SyncCounts,
  SyncRunStatus,
} from "../localInventory/types.js";

export type SoftwareSource = Extract<LocalInventorySource, "mac_apps" | "brew">;

export type SoftwareWarning = InventoryWarning;

export type { SyncCounts, SyncRunStatus };

export type ListOptions = {
  q?: string;
  includeMissing?: boolean;
  limit: number;
  offset: number;
};

export type PageResult<T> = {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
};
