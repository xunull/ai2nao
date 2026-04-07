const base = "";

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`, { headers: { Accept: "application/json" } });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = (await r.json()) as { error?: { message?: string } };
      if (j.error?.message) msg = j.error.message;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}
