import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal `.env` loader for the operational scripts.
 *
 * `next dev` / `next start` load `.env.local` themselves, but a plain Node
 * process does not, so the scripts that run outside Next have to read it. This
 * deliberately does NOT depend on a dotenv package and does NOT implement
 * variable interpolation; it handles the subset this repository writes.
 *
 * Values already present in `process.env` always win, so a real environment
 * variable is never overridden by the file.
 *
 * Nothing here ever prints a value. `describeEnvFile` reports names only.
 */
export function loadEnvFile(fileName = ".env.local"): boolean {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return false;

  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;

    const name = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;

    let value = withoutExport.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[name] === undefined || process.env[name] === "") {
      process.env[name] = value;
    }
  }

  return true;
}

/** Names that are set to a non-empty value, without revealing any value. */
export function presentNames(names: string[]): { set: string[]; missing: string[] } {
  const set: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value === "") missing.push(name);
    else set.push(name);
  }
  return { set, missing };
}
