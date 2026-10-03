import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const toolsDir = resolve(import.meta.dirname, "../packages/tools");
const entries = await readdir(toolsDir, { withFileTypes: true });

for (const entry of entries) {
  if (entry.isDirectory()) {
    const dir = resolve(toolsDir, entry.name);
    await $`${process.execPath} run build`.cwd(dir);
  }
}
