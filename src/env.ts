import fs from "node:fs";
import path from "node:path";

let loaded = false;

function parseLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const separator = trimmed.indexOf("=");
  if (separator === -1) return null;

  const key = trimmed.slice(0, separator).trim();
  let value = trimmed.slice(separator + 1).trim();

  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return key ? [key, value] : null;
}

export function loadLocalEnv(startDir: string = process.cwd()): void {
  if (loaded) return;

  let current = startDir;
  let envPath = "";

  // Helper to check for a specific filename
  const checkFile = (dir: string, filename: string) => {
    const candidate = path.resolve(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    return null;
  };

  while (current) {
    // Prefer .env.0mcp over .env
    const found = checkFile(current, ".env.0mcp") || checkFile(current, ".env");
    if (found) {
      envPath = found;
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (!envPath) {
    console.error(`[0MCP] ⚠️  No .env.0mcp or .env file found searching upwards from ${startDir}`);
    return;
  }

  console.error(`[0MCP] 📝 Loading environment from: ${envPath}`);
  loaded = true;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadLocalEnv();
