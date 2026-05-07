const base = "";

export async function apiGet<T>(path: string, init?: Pick<RequestInit, "signal">): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
    signal: init?.signal,
  });
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

export async function apiPost<T>(
  path: string,
  body: unknown,
  init?: Pick<RequestInit, "signal">
): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: init?.signal,
  });
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

export async function apiDelete<T>(path: string, init?: Pick<RequestInit, "signal">): Promise<T> {
  const r = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { Accept: "application/json" },
    signal: init?.signal,
  });
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
