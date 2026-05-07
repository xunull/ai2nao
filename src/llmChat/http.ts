import type { Context } from "hono";

export function jsonErr(status: number, message: string) {
  return Response.json({ error: { message } }, { status });
}

export async function safeJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}
