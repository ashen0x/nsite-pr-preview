import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
// Stamping the ref is the whole point: two PRs must be distinguishable by their
// previews, not by trusting the url. A string replacement here would expand $&.
const html = readFileSync("src/index.html", "utf8").replaceAll("{{branch}}", () => branch);

// Cleared, not just created: a leftover file from an earlier build would be published too.
rmSync("out", { recursive: true, force: true });
mkdirSync("out");
writeFileSync("out/index.html", html);
// nsyte is invoked with --fallback 404.html, so that file has to exist.
writeFileSync("out/404.html", html);
