import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export function syncVersion() {
  const version = execFileSync(
    "node",
    ["scripts/get-version.mjs"],
    { encoding: "utf8" }
  ).trim();

  for (const file of ["package.json", "package-lock.json"]) {
    const data = JSON.parse(readFileSync(file, "utf8"));

    data.version = version;

    if (file === "package-lock.json") {
      data.packages[""].version = version;
    }

    writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  }

  return version;
}

if (process.argv[1]?.endsWith("sync-version.mjs")) {
  console.log(`Version: ${syncVersion()}`);
}