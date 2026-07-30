#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";

const NAME = "nsite-pr-preview";
const RELAYS = "wss://relay.nsite.lol,wss://relay.damus.io,wss://nos.lol";
const SERVERS = "https://cdn.hzrd149.com,https://blossom.primal.net,https://blossom.ditto.pub";

const DIRS = ["out", "dist", "build"];
// Checked in this order because repos often carry more than one lockfile.
const MANAGERS = [
  ["pnpm", "pnpm-lock.yaml", ["install", "--frozen-lockfile", "--prefer-offline"]],
  ["yarn", "yarn.lock", ["install", "--frozen-lockfile"]],
  ["bun", "bun.lock", ["install", "--frozen-lockfile"]],
  ["npm", "package-lock.json", ["ci"]],
];
const BODY = /<\/body\s*>(?![\s\S]*<\/body\s*>)/i;
const OLD_BADGE = /<div id="__preview"[\s\S]*?<\/div>/i;

let root = process.cwd();
let secret = "";

const scrub = (s) => (secret ? String(s).replaceAll(secret, "***redacted***") : String(s));
const say = (m) => console.error(`[preview] ${scrub(m)}`);
const die = (msg, code = 2) => { say(msg); process.exit(code); };
// Relay-supplied text is untrusted, and a control byte would rewrite the terminal.
const plain = (s) => [...String(s ?? "")].filter((c) => c.codePointAt(0) > 31 && c.codePointAt(0) !== 127).join("");
const readable = (s) => scrub(String(s).replace(/\x1b\[[0-9;]*m/g, ""));

let flags = {};
const bool = { type: "boolean" }, str = { type: "string" };
try {
  ({ values: flags } = parseArgs({ strict: true, allowPositionals: false, options: {
    help: { ...bool, short: "h" }, live: bool, undeploy: bool, "allow-dirty": bool, "no-comment": bool, pr: str, dir: str, build: str,
  } }));
} catch (e) { die(`${e.message}\nrun with --help for the flag list`); }
const has = (f) => flags[f] === true;
const val = (f) => (f in flags ? flags[f].trim() || die(`--${f} needs a value`) : "");

if (has("help")) {
  console.log(`${NAME}  publish an nsite preview of this PR and link it on the PR

  ${NAME}          build and report without publishing or commenting
  ${NAME} --live   publish the preview and comment the link on the PR

  --pr <nevent|event-id>  pick the PR explicitly instead of matching the branch name
  --dir <folder>          publish this folder instead of autodetecting out, dist or build
  --build "<command>"     run this instead of the detected package manager's build script
  --allow-dirty           publish even when the tree does not match the pushed commit
  --no-comment            publish without commenting on the PR
  --undeploy              ask the relays and storage servers to drop this PR's preview

  Open the PR first, ngit turns a pr/ branch push into one:
    git push -o 'title=Short title' -o 'description=What and why' -u origin pr/<name>

  Publishing needs a signing key for nsyte, once per machine:
    nsyte ci                                       prints an nbunksec
    git config --global preview.nbunksec <value>    stores it`);
  process.exit(0);
}

const live = has("live");
const undeploy = has("undeploy");
const writes = live || undeploy;

if (live && undeploy) die("--live and --undeploy do opposite things, pass one");

const win = process.platform === "win32";
// Package managers and nsyte are .cmd shims needing a shell, and cmd.exe re-parses the line.
const q = (a) => (win && /[\s&|<>^()]/.test(a) ? `"${a}"` : a);
const exec = (cmd, args, { shim = false, ...opts } = {}) =>
  String(execFileSync(cmd, shim ? args.map(q) : args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: shim && win, ...opts,
  }) ?? "").trim();
const git = (...a) => { try { return exec("git", a); } catch { return ""; } };
const cfg = (key) => git("config", "--get", key);
const stream = (cmd, args, env) => exec(cmd, args, { shim: true, stdio: ["ignore", 2, 2], env });

root = git("rev-parse", "--show-toplevel") || die("not inside a git repository");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
const wanted = val("pr");
const wantDir = val("dir");
const custom = val("build");
if (!wanted && !branch.startsWith("pr/")) {
  die(`${branch === "HEAD" ? "detached HEAD" : `branch ${branch}`} is not a pr/ branch so it has no PR. open one (see: ngit pr --help) or point at one with --pr`);
}

// ngit prints status chatter such as "no updates" on stdout ahead of the json.
const json = (out, open) => { const i = out.indexOf(open); return i === -1 ? null : JSON.parse(out.slice(i)); };
const bare = (b) => String(b).replace(/\([0-9a-f]{8}\)$/, "");

const ngitFailed = (e, msg) => die(e.code === "ENOENT"
  ? "ngit is not on PATH. install it from https://gitworkshop.dev/ngit"
  : `${msg}\n${e.message}`);

say("reading PRs from the relays");
let pr;
if (wanted) {
  // ngit resolves nevents, full ids and the 8 character prefix in a PR branch name, and filters by no status.
  try { pr = json(exec("ngit", ["pr", "view", wanted, "--json", "-d"]), "{"); }
  catch (e) { ngitFailed(e, `no PR matches --pr ${wanted}. list them with: ngit pr list --status open,draft,closed,applied`); }
  if (!pr) die(`ngit returned no PR for --pr ${wanted}`);
} else {
  let listed = "";
  // ngit defaults to open,draft, and a merged PR is exactly the one you want to undeploy.
  try { listed = exec("ngit", ["pr", "list", "--status", "open,draft,closed,applied", "--json", "-d"]); }
  catch (e) { ngitFailed(e, "ngit could not list this repo's PRs. is this an ngit repo?"); }
  const named = (json(listed, "[") ?? []).filter((p) => bare(p.branch) === branch);
  // One branch name can carry a closed PR and its replacement, so a single live one settles it.
  const current = named.filter((p) => p.status === "open" || p.status === "draft");
  const hits = current.length === 1 ? current : named;
  if (!hits.length) die(`no PR for ${branch}. push it first (see: ngit pr --help), or retry in a moment if you just did and the relays are lagging`);
  if (hits.length > 1) die(`${hits.length} PRs match ${branch}, rerun with --pr:\n${hits.map((p) => `  ${p.id}  ${p.status}  ${plain(p.subject)}`).join("\n")}`);
  pr = hits[0];
}
const short = /\(([0-9a-f]{8})\)$/.exec(pr.branch)?.[1];
if (!short) die(`no event id in the PR branch name "${plain(pr.branch)}", pass --pr <nevent>`);
const dTag = `pr-${short}`;
say(`${dTag}  ${plain(pr.subject)}`);

// ngit's nostr.bunker-uri carries no secret parameter, so nsyte cannot connect with it.
const bunk = writes && cfg("preview.nbunksec");
const nsec = writes && !bunk && cfg("nostr.nsec");
// A dry run publishes nothing, so a throwaway key avoids a pointless signer prompt.
secret = writes ? bunk || nsec || process.env.NSITE_SEC : randomBytes(32).toString("hex");
if (!secret) die(`no signing key for nsyte. set one up once:
  nsyte ci                                       prints an nbunksec
  git config --global preview.nbunksec <value>    stores it`);
if (writes) say(`signing with ${bunk ? "preview.nbunksec, approve the request in your signer app if it prompts" : nsec ? "nostr.nsec" : "NSITE_SEC"}`);

// Removal needs only the tag and the key, so it runs before anything the build needs.
if (undeploy) {
  // undeploy takes no --no-config and validates relays and servers, so hand it a throwaway one.
  const conf = resolvePath(tmpdir(), "nsyte-preview-undeploy.json");
  writeFileSync(conf, JSON.stringify({ relays: RELAYS.split(","), servers: SERVERS.split(",") }));
  say(`requesting removal of ${dTag}`);
  try {
    process.stderr.write(`${readable(exec("nsyte", ["undeploy", "-c", conf, "-d", dTag, "--yes", "--sec", secret], { shim: true }))}\n`);
  } catch (e) { die(`undeploy failed: ${readable(`${e.message}\n${e.stdout ?? ""}${e.stderr ?? ""}`)}`, 1); }
  say("removal requested. relays and storage servers may still hold copies");
  process.exit(0);
}

const head = git("rev-parse", "HEAD");
// A fetched PR ref keeps the event id suffix that `pr list` reports; your own pushed branch tracks bare.
const remote = cfg(`branch.${branch}.remote`) || "origin";
const refs = [pr.branch, bare(pr.branch)].map((b) => `refs/remotes/${remote}/${b}`);
// Fetch every live run: a ref another clone has pushed past would compare clean against HEAD.
if (live) {
  say(`fetching ${pr.branch}`);
  try { exec("git", ["fetch", remote]); } catch (e) { die(`git fetch failed, so the tree cannot be checked against the PR:\n${e.message}`); }
}
const pushed = refs.map((r) => git("rev-parse", "--verify", "--quiet", r)).find(Boolean) ?? "";
// A git failure must not read as a clean tree.
let status = "";
try { status = exec("git", ["status", "--porcelain"]); }
catch (e) { die(`git status failed, so the tree cannot be checked against the PR:\n${e.message}`); }
const lines = status ? status.split("\n") : [];
// Untracked files reach the preview only if the build copies them, so they warn rather than block.
const untracked = lines.filter((l) => l.startsWith("??")).length;
const drift = lines.some((l) => !l.startsWith("??")) ? "the working tree has uncommitted changes"
  : !pushed ? `${pr.branch} is not in this clone, so the tree cannot be checked against the PR`
  : pushed !== head ? `HEAD ${head.slice(0, 7)} is not the pushed commit ${pushed.slice(0, 7)}`
  : "";
if (drift && live && !has("allow-dirty")) die(`${drift}, so the preview would not match the PR. commit or push first, or pass --allow-dirty`);
if (drift) say(`warning: ${drift}, the preview may not match the PR`);
if (untracked) say(`warning: ${untracked} untracked file${untracked === 1 ? "" : "s"} present, and a build that copies them would publish them`);

// Windows env lookup is case-insensitive but rest-exclusion is not, so match on the uppercased name.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== "NSITE_SEC"));

const pm = MANAGERS.find(([, lock]) => existsSync(resolvePath(root, lock)));
if (!custom && !pm) die(`no lockfile found, so the build command is unknown. pass --build "<command>" and --dir <folder>`);

if (pm) { say(`install dependencies with ${pm[0]}`); try { stream(pm[0], pm[2], env); } catch (e) { die(`install failed: ${scrub(e.message)}`, 1); } }
try {
  say("build");
  const prod = { ...env, NODE_ENV: "production" };
  if (custom) exec(custom, [], { shell: true, stdio: ["ignore", 2, 2], env: prod });
  else stream(pm[0], ["run", "build"], prod);
} catch (e) {
  if (/ENOENT|not recognized/i.test(String(e.message))) say("the build command was not found on PATH");
  die(`build failed: ${scrub(e.message)}`, 1);
}

// The folder only exists once the build has run, and a repo can hold a stale sibling, so newest wins.
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const dir = wantDir || DIRS.filter((d) => isDir(resolvePath(root, d)))
  .sort((a, b) => statSync(resolvePath(root, b)).mtimeMs - statSync(resolvePath(root, a)).mtimeMs)[0];
const outDir = dir && resolvePath(root, dir);
if (!outDir || !isDir(outDir)) die(wantDir ? `--dir ${wantDir} is not a folder` : `the build produced none of ${DIRS.join(", ")}. pass --dir <folder>`, 1);
say(`publishing ${dir}/`);

// Client side routing needs a fallback file and most builds do not emit one.
const fallback = resolvePath(outDir, "404.html");
const index = resolvePath(outDir, "index.html");
if (!existsSync(fallback) && existsSync(index)) {
  copyFileSync(index, fallback);
  say("added 404.html for client side routing");
}

// Injected after the build so no app carries preview code, whatever framework produced the html.
// It names the commit, not the PR, because the PR id is already in the url and the commit is not.
const badge = `<div id="__preview" style="position:fixed;left:12px;bottom:12px;z-index:2147483000;padding:5px 10px;border-radius:999px;font:12px/1 ui-monospace,monospace;color:#D3D1C7;background:rgba(20,20,22,.72);border:1px solid rgba(255,255,255,.18);pointer-events:none">preview ${head.slice(0, 7)}</div>`;
let stamped = 0;
for (const name of readdirSync(outDir, { recursive: true })) {
  const file = resolvePath(outDir, name);
  if (!name.toLowerCase().endsWith(".html") || !statSync(file).isFile()) continue;
  // An incremental build leaves an already stamped file in place, so drop our own last badge first.
  const html = readFileSync(file, "utf8").replace(OLD_BADGE, "");
  if (!BODY.test(html)) continue;
  writeFileSync(file, html.replace(BODY, `${badge}$&`));
  stamped++;
}
say(`marked ${stamped} page${stamped === 1 ? "" : "s"} as a preview`);

say(live ? `deploying ${dTag}` : `dry run for ${dTag}, pass --live to publish`);
// nsyte resolves the folder against its own cwd, so run it from the folder and hand it ".".
const deployArgs = [
  "deploy", ".", "--no-config", "--non-interactive",
  "--name", dTag,
  "--relays", RELAYS, "--servers", SERVERS,
  // A minified bundle trips the scanner every build and nsyte aborts on any hit.
  "--skip-secrets-scan",
  "--sec", secret,
];
if (existsSync(fallback)) deployArgs.push("--fallback", "404.html");
// Without --sync nsyte exits before printing the url when nothing changed, and a rerun is the normal case.
if (live) deployArgs.push("--sync");
else deployArgs.push("--dry-run");

let out = "";
try { out = exec("nsyte", deployArgs, { shim: true, cwd: outDir }); }
catch (e) {
  if (/ENOENT|not recognized/i.test(String(e.message))) say("nsyte is not on PATH. binaries: https://github.com/sandwichfarm/nsyte/releases");
  die(`deploy failed: ${scrub(e.message)}`, 1);
}
// nsyte echoes its own argv on some failures, and that carries --sec.
const clean = readable(out);
process.stderr.write(`${clean}\n`);

if (!live) { say("dry run finished, nothing was published. publish with --live"); process.exit(0); }

// Excluding ESC as well as whitespace: a stray control byte must never end up inside a link.
const url = clean.match(/https:\/\/[^\s\x1b]+\.nsite\.[^\s\x1b]+/)?.[0]?.replace(/\/$/, "");
if (!url) die("the deploy went through but nsyte reported no url, so there is no confirmed link to post", 1);
say(`preview: ${url}`);
console.log(url);
if (has("no-comment")) process.exit(0);

// The url is fixed by the signer's key and the PR id, so rerunning republishes in place and one comment is enough.
let thread;
try { thread = json(exec("ngit", ["pr", "view", pr.id, "--comments", "--json", "-d"]), "{"); }
catch (e) { die(`the preview is live at ${url} but the existing comments could not be read, so post the link yourself rather than risk a duplicate:\n${e.message}`, 1); }
// A link posted by hand may be wrapped in markdown, so compare extracted urls, not whitespace tokens.
const links = (body) => (String(body).match(/https:\/\/[^\s<>()[\]]+/g) ?? []).map((u) => u.replace(/\/$/, ""));
if ((thread?.comments ?? []).some((c) => links(c.body).includes(url))) { say("link is already on the PR"); process.exit(0); }

say("commenting on the PR");
try { exec("ngit", ["pr", "comment", pr.id, "--body", `Preview: ${url}`, "-d"], { stdio: ["ignore", "pipe", 2] }); }
catch (e) { die(`the preview is live at ${url} but the comment failed, post the link yourself:\n${e.message}`, 1); }
say("done");
