import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";

const teamsDir = resolve(import.meta.dirname, "../packages/teams");
const entries = await readdir(teamsDir, { withFileTypes: true });

for (const entry of entries) {
  if (entry.isDirectory()) {
    const dir = resolve(teamsDir, entry.name);
    await $`${process.execPath} run build`.cwd(dir);
  }
}
