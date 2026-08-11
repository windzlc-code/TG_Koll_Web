import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const built = resolve(here, "../../../../webapp/static/assets/crm/index.html");
const target = resolve(here, "../../../../webapp/static/crm.html");
await mkdir(dirname(target), { recursive: true });
await copyFile(built, target);
console.log(`CRM shell generated: ${target}`);
