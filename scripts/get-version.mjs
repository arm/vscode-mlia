import { execFileSync } from "node:child_process";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

const tag = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*");
const baseVersion = tag.replace(/^v/, "");

const distance = Number(
  git("rev-list", "--count", `${tag}..HEAD`)
);

const sha = git("rev-parse", "--short=7", "HEAD");

let version = baseVersion;

if (distance > 0) {
  const [major, minor, patch] = baseVersion.split(".").map(Number);

  const nextVersion = `${major}.${minor}.${patch + 1}`;

  version = `${nextVersion}-dev${distance}+${sha}`;
}

console.log(version);