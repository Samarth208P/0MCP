import fs from "node:fs";
import path from "node:path";
import { getProjectLocation } from "./registry.js";

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

/**
 * Loads environment variables from .env.0mcp or .env.
 * If project_id is provided, it first checks the global registry to find the 
 * absolute path for that project.
 */
export function loadLocalEnv(startDir?: string, project_id?: string): void {
  // If we already loaded a global one, only re-run if we have a specific project_id
  if (loaded && !project_id) return;

  const dirsToTry = [startDir, process.env.INIT_CWD, process.cwd()].filter(Boolean) as string[];
  
  if (project_id) {
    const registeredPath = getProjectLocation(project_id);
    if (registeredPath) {
      dirsToTry.unshift(registeredPath);
    }
  }

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
    // Only warn if we weren't just doing a targeted project lookup
    if (!project_id) {
       console.error(`[0MCP] ⚠️  No .env.0mcp or .env found. Run '0mcp init' in your project.`);
    }
    return;
  }

  // Avoid logging the same path multiple times
  if (process.env._0MCP_ENV_LOADED !== envPath) {
    console.error(`[0MCP] 📝 Loading environment from: ${envPath}`);
    process.env._0MCP_ENV_LOADED = envPath;
  }
  
  loaded = true;

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    // Don't overwrite existing process.env with empty strings unless specifically needed
    if ((process.env[key] === undefined || project_id) && value) {
      process.env[key] = value;
    }
  }
}

// Initial load on import
loadLocalEnv();
