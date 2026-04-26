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

export function loadLocalEnv(startDir?: string): void {
  if (loaded) return;

  const dirsToTry = [startDir, process.env.INIT_CWD, process.cwd()].filter(Boolean) as string[];
  let envPath = "";

  const checkFile = (dir: string, filename: string) => {
    const candidate = path.resolve(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    return null;
  };

  for (const dir of dirsToTry) {
    let current = dir;
    while (current) {
      const found = checkFile(current, ".env.0mcp") || checkFile(current, ".env");
      if (found) {
        envPath = found;
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (envPath) break;
  }

  if (!envPath) {
    console.error(`[0MCP] ⚠️  No .env.0mcp or .env file found (tried INIT_CWD and cwd)`);
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
