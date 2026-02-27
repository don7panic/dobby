const BLOCKED_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export type PathSegment = string;

/**
 * Returns true when a path segment represents an array index.
 */
function isIndexSegment(raw: string): boolean {
  return /^[0-9]+$/.test(raw);
}

/**
 * Rejects dangerous object keys that could enable prototype pollution.
 */
function validatePathSegments(path: PathSegment[]): void {
  for (const segment of path) {
    if (!isIndexSegment(segment) && BLOCKED_OBJECT_KEYS.has(segment)) {
      throw new Error(`Invalid path segment: ${segment}`);
    }
  }
}

/**
 * Parses dot/bracket path syntax into normalized path segments.
 */
export function parsePath(rawPath: string): PathSegment[] {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return [];
  }

  const segments: string[] = [];
  let current = "";
  let index = 0;

  while (index < trimmed.length) {
    const char = trimmed[index];

    if (char === "\\") {
      const next = trimmed[index + 1];
      if (next) {
        current += next;
      }
      index += 2;
      continue;
    }

    if (char === ".") {
      if (current) {
        segments.push(current);
      }
      current = "";
      index += 1;
      continue;
    }

    if (char === "[") {
      if (current) {
        segments.push(current);
      }
      current = "";

      const closeIndex = trimmed.indexOf("]", index);
      if (closeIndex === -1) {
        throw new Error(`Invalid path (missing ']'): ${rawPath}`);
      }

      const inside = trimmed.slice(index + 1, closeIndex).trim();
      if (!inside) {
        throw new Error(`Invalid path (empty '[]'): ${rawPath}`);
      }

      segments.push(inside);
      index = closeIndex + 1;
      continue;
    }

    current += char;
    index += 1;
  }

  if (current) {
    segments.push(current);
  }

  const normalized = segments.map((segment) => segment.trim()).filter(Boolean);
  validatePathSegments(normalized);
  return normalized;
}

/**
 * Safe own-property check wrapper.
 */
function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Reads a value from object/array structures by parsed path segments.
 */
export function getAtPath(root: unknown, path: PathSegment[]): { found: boolean; value?: unknown } {
  let current: unknown = root;

  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return { found: false };
    }

    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        return { found: false };
      }

      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return { found: false };
      }

      current = current[index];
      continue;
    }

    const record = current as Record<string, unknown>;
    if (!hasOwnKey(record, segment)) {
      return { found: false };
    }

    current = record[segment];
  }

  return { found: true, value: current };
}

/**
 * Sets a value at path, creating intermediate objects/arrays as needed.
 */
export function setAtPath(root: Record<string, unknown>, path: PathSegment[], value: unknown): void {
  if (path.length === 0) {
    throw new Error("Path is empty.");
  }

  let current: unknown = root;

  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i]!;
    const next = path[i + 1];
    const nextIsIndex = Boolean(next && isIndexSegment(next));

    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        throw new Error(`Expected numeric index for array segment '${segment}'`);
      }

      const index = Number.parseInt(segment, 10);
      const existing = current[index];
      if (!existing || typeof existing !== "object") {
        current[index] = nextIsIndex ? [] : {};
      }
      current = current[index];
      continue;
    }

    if (!current || typeof current !== "object") {
      throw new Error(`Cannot traverse into '${segment}' (not an object)`);
    }

    const record = current as Record<string, unknown>;
    const existing = hasOwnKey(record, segment) ? record[segment] : undefined;
    if (!existing || typeof existing !== "object") {
      record[segment] = nextIsIndex ? [] : {};
    }
    current = record[segment];
  }

  const tail = path[path.length - 1]!;
  if (Array.isArray(current)) {
    if (!isIndexSegment(tail)) {
      throw new Error(`Expected numeric index for array segment '${tail}'`);
    }

    const index = Number.parseInt(tail, 10);
    current[index] = value;
    return;
  }

  if (!current || typeof current !== "object") {
    throw new Error(`Cannot set '${tail}' (parent is not an object)`);
  }

  (current as Record<string, unknown>)[tail] = value;
}

/**
 * Removes a value at path and returns whether the target existed.
 */
export function unsetAtPath(root: Record<string, unknown>, path: PathSegment[]): boolean {
  if (path.length === 0) {
    return false;
  }

  let current: unknown = root;

  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i]!;

    if (!current || typeof current !== "object") {
      return false;
    }

    if (Array.isArray(current)) {
      if (!isIndexSegment(segment)) {
        return false;
      }
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) {
        return false;
      }
      current = current[index];
      continue;
    }

    const record = current as Record<string, unknown>;
    if (!hasOwnKey(record, segment)) {
      return false;
    }
    current = record[segment];
  }

  const tail = path[path.length - 1]!;
  if (Array.isArray(current)) {
    if (!isIndexSegment(tail)) {
      return false;
    }
    const index = Number.parseInt(tail, 10);
    if (!Number.isFinite(index) || index < 0 || index >= current.length) {
      return false;
    }
    current.splice(index, 1);
    return true;
  }

  if (!current || typeof current !== "object") {
    return false;
  }

  const record = current as Record<string, unknown>;
  if (!hasOwnKey(record, tail)) {
    return false;
  }

  delete record[tail];
  return true;
}
