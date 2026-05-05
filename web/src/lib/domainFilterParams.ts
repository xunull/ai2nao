export type DomainTimelineGrain = "day" | "week" | "month";
export type DomainUrlKind =
  | "web"
  | "all"
  | "localhost"
  | "chrome"
  | "extension"
  | "file"
  | "invalid";

export type DomainFilterState = {
  profile: string;
  domains: string[];
  scope: "all" | null;
  kind: DomainUrlKind;
  grain: DomainTimelineGrain;
  from: string | null;
  to: string | null;
  q: string | null;
};

function cloneParams(p: URLSearchParams): URLSearchParams {
  return new URLSearchParams(p);
}

function readDomains(raw: string | null): string[] {
  return raw?.trim()
    ? Array.from(
        new Set(
          raw
            .split(",")
            .map((d) => d.trim().toLowerCase())
            .filter(Boolean)
        )
      )
    : [];
}

export function readDomainFilterState(
  params: URLSearchParams
): DomainFilterState {
  const kindRaw = params.get("kind");
  const kind: DomainUrlKind =
    kindRaw === "all" ||
    kindRaw === "localhost" ||
    kindRaw === "chrome" ||
    kindRaw === "extension" ||
    kindRaw === "file" ||
    kindRaw === "invalid"
      ? kindRaw
      : "web";
  const grainRaw = params.get("grain");
  const grain: DomainTimelineGrain =
    grainRaw === "week" || grainRaw === "month" ? grainRaw : "day";
  return {
    profile: (params.get("profile") ?? "").trim() || "Default",
    domains: readDomains(params.get("domains")),
    scope: params.get("scope") === "all" ? "all" : null,
    kind,
    grain,
    from: (params.get("from") ?? "").trim() || null,
    to: (params.get("to") ?? "").trim() || null,
    q: (params.get("q") ?? "").trim() || null,
  };
}

export function toggleDomainInParams(
  params: URLSearchParams,
  domain: string
): URLSearchParams {
  const next = cloneParams(params);
  const lower = domain.trim().toLowerCase();
  if (!lower) return next;
  const cur = new Set(readDomainFilterState(next).domains);
  if (cur.has(lower)) cur.delete(lower);
  else cur.add(lower);
  if (cur.size === 0) next.delete("domains");
  else next.set("domains", Array.from(cur).join(","));
  if (cur.size > 0) next.delete("scope");
  return next;
}

export function setDomainListInParams(
  params: URLSearchParams,
  domains: string[]
): URLSearchParams {
  const next = cloneParams(params);
  const normalized = Array.from(
    new Set(domains.map((d) => d.trim().toLowerCase()).filter(Boolean))
  );
  if (normalized.length === 0) next.delete("domains");
  else next.set("domains", normalized.join(","));
  if (normalized.length > 0) next.delete("scope");
  return next;
}

export function setSingleDomainInParams(
  params: URLSearchParams,
  domain: string
): URLSearchParams {
  return setDomainListInParams(params, [domain]);
}

export function clearDomainsInParams(params: URLSearchParams): URLSearchParams {
  const next = cloneParams(params);
  next.delete("domains");
  next.delete("scope");
  return next;
}

export function setAllDomainsScopeInParams(
  params: URLSearchParams
): URLSearchParams {
  const next = cloneParams(params);
  next.delete("domains");
  next.set("scope", "all");
  return next;
}

export function setDomainParam(
  params: URLSearchParams,
  key: string,
  value: string | null
): URLSearchParams {
  const next = cloneParams(params);
  const trimmed = value?.trim() ?? "";
  if (!trimmed) next.delete(key);
  else next.set(key, trimmed);
  return next;
}

export function setDomainBucketRangeInParams(
  params: URLSearchParams,
  grain: DomainTimelineGrain,
  bucket: string
): URLSearchParams {
  const next = cloneParams(params);
  next.set("from", bucket);
  if (grain === "month") {
    const [y, m] = bucket.split("-").map(Number);
    next.set("to", localDay(new Date(y, m, 1)));
  } else if (grain === "week") {
    next.set("to", addDays(bucket, 7));
  } else {
    next.set("to", addDays(bucket, 1));
  }
  return next;
}

export function localDay(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + n));
}

export function defaultDomainFromDate(now = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - 90);
  return localDay(d);
}
