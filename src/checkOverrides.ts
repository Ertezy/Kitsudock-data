// Проверка overrides.json на каждом коммите: опечатка видна красным крестиком сразу.

import { readFileSync } from "node:fs";
import { cleanErrorText } from "./issues.ts";
import { parseOverrides } from "./overrides.ts";

let json: unknown;
try {
  json = JSON.parse(readFileSync("overrides.json", "utf8"));
} catch (error) {
  console.error(`overrides.json не читается как JSON: ${cleanErrorText((error as Error).message)}`);
  process.exit(1);
}
const result = parseOverrides(json);
if (!result.ok) {
  for (const line of result.errors) console.error(`overrides.json: ${cleanErrorText(line)}`);
  process.exit(1);
}
console.log("overrides.json в порядке");
