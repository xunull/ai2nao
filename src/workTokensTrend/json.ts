import type { WorkTokensTrendResponse } from "./types.js";

/**
 * Wire JSON shape — currently identical to WorkTokensTrendResponse because
 * every Date field already lives as an ISO string in the DTO. This file
 * exists for two reasons:
 *
 *   1. Future-proof: if we add Date-typed fields later, the explicit
 *      serializer keeps the JSON contract stable.
 *   2. Convention parity with src/workDashboard/json.ts and
 *      src/workRecap/json.ts so readers find the same surface.
 */
export type WorkTokensTrendResponseJson = WorkTokensTrendResponse;

export function responseToJson(
  payload: WorkTokensTrendResponse
): WorkTokensTrendResponseJson {
  return payload;
}
