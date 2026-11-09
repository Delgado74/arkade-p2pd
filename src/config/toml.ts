/**
 * Minimal TOML reader for the daemon settings file.
 *
 * Supports the subset the daemon actually uses: `[section]` headers, bare or
 * quoted keys, strings, numbers, booleans and single-line arrays. Comments and
 * blank lines are ignored. Anything else throws with its line number so a typo
 * fails fast instead of silently falling back to defaults.
 */
export type TomlValue = string | number | boolean | TomlValue[];
export interface TomlTable {
  [key: string]: TomlValue | TomlTable;
}

function stripComment(line: string): string {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "#") return line.slice(0, i);
  }
  return line;
}

function parseString(raw: string, line: number): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) {
    throw new Error(`line ${line}: expected a quoted string`);
  }
  const body = raw.slice(1, -1);
  return body.replace(/\\(["\\nrt])/g, (_match, code: string) => {
    switch (code) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return code;
    }
  });
}

function splitArray(raw: string): string[] {
  const body = raw.slice(1, -1);
  const parts: string[] = [];
  let current = "";
  let inString = false;
  let escaped = false;
  for (const char of body) {
    if (inString) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      current += char;
    } else if (char === ",") {
      parts.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

function parseValue(raw: string, line: number): TomlValue {
  const value = raw.trim();
  if (value.startsWith('"')) return parseString(value, line);
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error(`line ${line}: unterminated array`);
    return splitArray(value)
      .filter((part) => part.length > 0)
      .map((part) => parseValue(part, line));
  }
  if (value === "true") return true;
  if (value === "false") return false;
  const number = Number(value);
  if (value.length > 0 && Number.isFinite(number)) return number;
  throw new Error(`line ${line}: unsupported value "${value}"`);
}

function keyName(raw: string, line: number): string {
  const key = raw.trim();
  if (key.startsWith('"') && key.endsWith('"')) return parseString(key, line);
  if (key.length === 0) throw new Error(`line ${line}: empty key`);
  return key;
}

function arrayComplete(value: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
  }
  return depth <= 0;
}

export function parseToml(input: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable = root;
  const lines = input.split(/\r?\n/);

  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const text = stripComment(lines[index]).trim();
    if (text.length === 0) continue;

    if (text.startsWith("[")) {
      if (!text.endsWith("]")) throw new Error(`line ${line}: unterminated section`);
      const name = text.slice(1, -1).trim();
      if (name.length === 0) throw new Error(`line ${line}: empty section`);
      let table = root;
      for (const part of name.split(".")) {
        const key = keyName(part, line);
        const existing = table[key];
        if (existing === undefined) {
          const child: TomlTable = {};
          table[key] = child;
          table = child;
        } else if (typeof existing === "object" && !Array.isArray(existing)) {
          table = existing;
        } else {
          throw new Error(`line ${line}: "${key}" is not a table`);
        }
      }
      current = table;
      continue;
    }

    const eq = text.indexOf("=");
    if (eq < 0) throw new Error(`line ${line}: expected key = value`);
    const key = keyName(text.slice(0, eq), line);
    let value = text.slice(eq + 1).trim();
    while (value.startsWith("[") && !arrayComplete(value)) {
      index += 1;
      if (index >= lines.length) {
        throw new Error(`line ${line}: unterminated array`);
      }
      value += ` ${stripComment(lines[index]).trim()}`;
    }
    current[key] = parseValue(value, line);
  }

  return root;
}
