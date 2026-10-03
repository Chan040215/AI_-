import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const nodesDir = resolve(import.meta.dirname, "../packages/nodes");
const entries = await readdir(nodesDir, { withFileTypes: true });

for (const entry of entries) {
  if (entry.isDirectory()) {
    const dir = resolve(nodesDir, entry.name);
    await $`${process.execPath} run build`.cwd(dir);
  }
}
