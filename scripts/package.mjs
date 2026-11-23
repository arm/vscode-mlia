import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { syncVersion } from "./sync-version.mjs";

const files = ["package.json", "package-lock.json"];
const originals = files.map((file) => readFileSync(file, "utf8"));

try {
  const version = syncVersion();

  console.log(`Packaging version: ${version}`);

  execFileSync(
    "npx",
    ["vsce", "package", "--no-dependencies"],
    { stdio: "inherit" }
  );
} finally {
  files.forEach((file, index) => {
    writeFileSync(file, originals[index]);
  });
}