export type SoftwareSource = "mac_apps" | "brew";

export type SyncRunStatus = "running" | "success" | "partial" | "failed";

export type SoftwareWarning = {
  code: string;
  message: string;
  path?: string;
};

export type SyncCounts = {
  inserted: number;
  updated: number;
  markedMissing: number;
};

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
