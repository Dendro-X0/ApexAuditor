import { access, readFile } from "node:fs/promises";

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
