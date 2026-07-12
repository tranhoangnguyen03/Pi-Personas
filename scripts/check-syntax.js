import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

async function listJavaScriptFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listJavaScriptFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath);
  }
  return files;
}

const roots = process.argv.slice(2);
const files = (await Promise.all((roots.length ? roots : ["src/persona"]).map(listJavaScriptFiles)))
  .flat()
  .sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
