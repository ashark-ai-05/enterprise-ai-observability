/**
 * Field-level redaction applied before anything is written to the archive.
 *
 * The capture policy is metadata-only (`docs/DECISIONS.md` D3), but two Amp responses carry
 * user-authored or personal content: thread `title` and the `email` on daily-usage users.
 * Thread titles in particular are free text and routinely contain ticket keys, customer names,
 * or worse. Holding the `threads.contents:view` scope must not silently reclassify what the
 * archive stores, so redaction happens at ingest and the removal is recorded.
 *
 * Redaction runs *before* hashing, so `contentHash` always identifies the bytes actually stored.
 */

/** JSON pointers stripped by default, keyed by the endpoint that returns them. */
const SENSITIVE_FIELDS: Array<{ match: (endpoint: string) => boolean; paths: string[] }> = [
  { match: (e) => e === "/api/v2/threads", paths: ["threads[].title"] },
  {
    match: (e) => e.endsWith("/analytics/daily-usage"),
    paths: ["data[].users[].user.email"],
  },
];

export interface RedactionResult {
  body: unknown;
  /** Field paths actually removed, for the observation log. Empty when nothing matched. */
  removed: string[];
}

/**
 * Strips sensitive fields from a response body.
 *
 * Returns the original reference untouched when nothing matches, so the common case allocates
 * nothing. `allowSensitive` bypasses redaction entirely — reserve it for an approved, separately
 * protected store, never the default filesystem archive.
 */
export function redactResponse(
  endpoint: string,
  body: unknown,
  allowSensitive = false,
): RedactionResult {
  if (allowSensitive) return { body, removed: [] };

  const rule = SENSITIVE_FIELDS.find((candidate) => candidate.match(endpoint));
  if (!rule) return { body, removed: [] };

  const removed: string[] = [];
  const cloned = structuredClone(body);
  for (const path of rule.paths) {
    if (stripPath(cloned, path.split("."), path, removed)) {
      // recorded inside stripPath
    }
  }
  return { body: removed.length > 0 ? cloned : body, removed };
}

/**
 * Walks a dotted path where a `[]` suffix means "iterate this array".
 * Returns true if at least one value was deleted.
 */
function stripPath(node: unknown, segments: string[], fullPath: string, removed: string[]): boolean {
  const [head, ...rest] = segments;
  if (head === undefined || node === null || typeof node !== "object") return false;

  if (head.endsWith("[]")) {
    const key = head.slice(0, -2);
    const array = (node as Record<string, unknown>)[key];
    if (!Array.isArray(array)) return false;
    let any = false;
    for (const item of array) {
      if (stripPath(item, rest, fullPath, removed)) any = true;
    }
    return any;
  }

  const record = node as Record<string, unknown>;
  if (rest.length === 0) {
    if (!(head in record)) return false;
    delete record[head];
    if (!removed.includes(fullPath)) removed.push(fullPath);
    return true;
  }
  return stripPath(record[head], rest, fullPath, removed);
}
