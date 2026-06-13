import type {
  WorkRecapEmptyResponse,
  WorkRecapInflightResponse,
  WorkRecapLatestResponse,
  WorkRecapListResponse,
  WorkRecapRun,
  WorkRecapRunResponse,
} from "./types.js";

/**
 * Wire JSON shapes — Date fields serialize as ISO strings so the frontend
 * sees a stable contract. Mirrors src/workDashboard/json.ts.
 */
export type WorkRecapRunJson = Omit<WorkRecapRun, "generatedAt"> & {
  generatedAt: string;
};

export type WorkRecapRunResponseJson = Omit<
  WorkRecapRunResponse,
  "run"
> & {
  run: WorkRecapRunJson;
};

export type WorkRecapLatestResponseJson = Omit<
  WorkRecapLatestResponse,
  "run"
> & {
  run: WorkRecapRunJson | null;
};

export type WorkRecapListResponseJson = Omit<
  WorkRecapListResponse,
  "runs"
> & {
  runs: WorkRecapRunJson[];
};

function runToJson(run: WorkRecapRun): WorkRecapRunJson {
  return {
    ...run,
    generatedAt: run.generatedAt.toISOString(),
  };
}

export function runResponseToJson(
  payload: WorkRecapRunResponse
): WorkRecapRunResponseJson {
  return { ok: true, run: runToJson(payload.run) };
}

export function latestResponseToJson(
  payload: WorkRecapLatestResponse
): WorkRecapLatestResponseJson {
  return {
    ok: true,
    windowKey: payload.windowKey,
    run: payload.run ? runToJson(payload.run) : null,
  };
}

export function listResponseToJson(
  payload: WorkRecapListResponse
): WorkRecapListResponseJson {
  return {
    ok: true,
    windowKey: payload.windowKey,
    runs: payload.runs.map(runToJson),
  };
}

export function emptyResponseToJson(
  payload: WorkRecapEmptyResponse
): WorkRecapEmptyResponse {
  return payload;
}

export function inflightResponseToJson(
  payload: WorkRecapInflightResponse
): WorkRecapInflightResponse {
  return payload;
}
