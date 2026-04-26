import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REGISTRY_PATH = path.join(os.homedir(), ".0mcp_projects.json");

export interface ProjectRegistry {
  [project_id: string]: {
    path: string;
    updated_at: number;
  };
}

export function loadRegistry(): ProjectRegistry {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
    }
  } catch (err) {
    console.error(`[0MCP] Failed to load registry: ${err}`);
  }
  return {};
}

export function saveProjectLocation(project_id: string, project_path: string): void {
  try {
    const registry = loadRegistry();
    registry[project_id] = {
      path: path.resolve(project_path),
      updated_at: Date.now(),
    };
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
    console.error(`[0MCP] Registry: Linked project '${project_id}' to ${project_path}`);
  } catch (err) {
    console.error(`[0MCP] Failed to save project location: ${err}`);
  }
}

export function getProjectLocation(project_id: string): string | null {
  const registry = loadRegistry();
  return registry[project_id]?.path || null;
}
