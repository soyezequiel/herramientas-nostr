import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SDK = "nostr-bal-browser-sdk";
const IGNORED = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".next", ".nuxt", ".turbo",
]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

function usage() {
  console.error("Usage: node audit-bal-integration.mjs <target-project-root> [--json]");
  process.exit(2);
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const positional = args.filter((arg) => arg !== "--json");
if (positional.length !== 1) usage();

const target = path.resolve(positional[0]);
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`Target directory does not exist: ${target}`);
  process.exit(2);
}

function walk(root, accept) {
  const found = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile() && accept(full, entry.name)) found.push(full);
    }
  }
  return found;
}

function readText(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size > 1_500_000) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readPackage(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { __parseError: String(error) };
  }
}

function dependencySpec(pkg, name) {
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    if (pkg?.[section]?.[name]) return { section, spec: pkg[section][name] };
  }
  return null;
}

const packageFiles = walk(target, (_full, name) => name === "package.json");
const packages = packageFiles.map((file) => ({ file, dir: path.dirname(file), pkg: readPackage(file) }));
const browserPackages = packages.filter(({ pkg }) => dependencySpec(pkg, SDK));
const sourceFiles = walk(target, (full) => SOURCE_EXTENSIONS.has(path.extname(full)));
const sources = sourceFiles.map((file) => ({ file, text: readText(file) }));
const joined = sources.map(({ text }) => text).join("\n");

const findings = [];
function add(level, code, message, file) {
  findings.push({ level, code, message, ...(file ? { file: path.relative(target, file) || "." } : {}) });
}
function pass(code, message, file) { add("PASS", code, message, file); }
function warn(code, message, file) { add("WARN", code, message, file); }
function fail(code, message, file) { add("FAIL", code, message, file); }

if (!packageFiles.length) fail("package.missing", "No package.json was found under the target.");
for (const { file, pkg } of packages.filter(({ pkg }) => pkg.__parseError)) {
  fail("package.invalid", `Cannot parse package.json: ${pkg.__parseError}`, file);
}

if (!browserPackages.length) {
  fail("sdk.dependency", `${SDK} is not declared in any package.`);
} else {
  for (const { file, pkg } of browserPackages) {
    const sdk = dependencySpec(pkg, SDK);
    pass("sdk.dependency", `${SDK} declared in ${sdk.section} as ${sdk.spec}.`, file);
    for (const peer of ["nostr-game-protocol", "nostr-tools"]) {
      const dep = dependencySpec(pkg, peer);
      if (dep) pass(`peer.${peer}`, `${peer} declared as ${dep.spec}.`, file);
      else fail(`peer.${peer}`, `${peer} must be a direct compatible dependency of the browser package.`, file);
    }
  }
}

const adapter = sources.find(({ text }) => /createBalBrowserLogin\s*\(/.test(text));
if (adapter) pass("adapter.factory", "Found createBalBrowserLogin configuration.", adapter.file);
else fail("adapter.factory", "No createBalBrowserLogin configuration was found.");

const worker = sources.find(({ text }) => /(?:from\s*|import\s*)["']nostr-bal-browser-sdk\/worker["']/.test(text));
if (worker) pass("worker.entry", "Found the SDK SharedWorker entry import.", worker.file);
else fail("worker.entry", "Missing a worker entry that imports nostr-bal-browser-sdk/worker.");

const checks = [
  ["config.gameId", /gameId\s*:/, "Found gameId in BAL configuration.", "Missing gameId in BAL configuration."],
  ["config.gameName", /gameName\s*:/, "Found gameName in BAL configuration.", "Missing gameName in BAL configuration."],
  ["config.permissions", /permissions\s*:/, "Found explicit permissions in BAL configuration.", "Missing explicit permissions in BAL configuration."],
  ["config.launcher-key", /launcherOriginStorageKey\s*:/, "Found game-unique launcherOriginStorageKey.", "Missing game-unique launcherOriginStorageKey."],
  ["config.worker", /createWorker\s*:/, "Found SharedWorker factory.", "Missing SharedWorker factory."],
  ["config.active-key", /activeHintKey\s*:/, "Found game-unique activeHintKey.", "Missing game-unique activeHintKey."],
  ["permission.pubkey", /["']get_public_key["']/, "Found get_public_key permission.", "Permissions do not visibly include get_public_key."],
  ["permission.auth-sign", /["']sign_event:\d+["']|`sign_event:\$\{/, "Found an event-signing permission for authentication.", "Permissions do not visibly include an event kind for signed authentication."],
];
for (const [code, pattern, success, failure] of checks) {
  const haystack = code.startsWith("permission.") ? joined : adapter?.text ?? "";
  if (adapter && pattern.test(haystack)) pass(code, success, adapter.file);
  else if (code.startsWith("config.")) fail(code, failure, adapter?.file);
  else warn(code, failure, adapter?.file);
}

if (/\.connect\s*\(|tryBalLogin\s*\(/.test(joined)) pass("lifecycle.connect", "Found BAL connect usage.");
else fail("lifecycle.connect", "BAL is configured but no login flow calls connect().");

if (/\.logout\s*\(|logoutBal\s*\(/.test(joined)) pass("lifecycle.logout", "Found BAL logout usage.");
else warn("lifecycle.logout", "No BAL logout integration was found.");

if (/hasLauncherContext\s*\(|hasBalLauncherContext\s*\(/.test(joined)) {
  pass("lifecycle.context", "Found launcher/shared-session context handling.");
} else {
  warn("lifecycle.context", "No launcher/shared-session context check was found; verify startup ordering manually.");
}

const removesLnOrigin = /searchParams\.delete\s*\(\s*["']lnOrigin["']\s*\)/.test(joined);
const replacesHistory = /history\.replaceState\s*\(/.test(joined);
if (removesLnOrigin && replacesHistory) {
  pass("url.cleanup", "Found targeted lnOrigin cleanup with history.replaceState; verify it runs after context capture and preserves other URL state.");
} else {
  warn("url.cleanup", "No targeted post-capture lnOrigin cleanup was found; the launcher parameter may remain visible or be removed too broadly.");
}

const accountComparison = /(?:previous|current|stored|existing)[A-Za-z0-9_]*Pubkey[\s\S]{0,500}(?:===|!==)[\s\S]{0,120}(?:bal|next|new|signer)[A-Za-z0-9_]*Pubkey/i.test(joined)
  || /(?:bal|next|new|signer)[A-Za-z0-9_]*Pubkey[\s\S]{0,500}(?:===|!==)[\s\S]{0,120}(?:previous|current|stored|existing)[A-Za-z0-9_]*Pubkey/i.test(joined);
if (accountComparison) {
  pass("session.account-switch", "Found an apparent current-vs-BAL pubkey comparison before account replacement; review ordering manually.");
} else {
  warn("session.account-switch", "No current-vs-BAL pubkey comparison was detected; same-account launches may log out or different accounts may share state.");
}

const conditionalWorkerBypass = adapter
  && /createWorker\s*:[\s\S]{0,500}(?:throw\s+new|return\s+null|SharedWorker\s*=)/.test(adapter.text);
if (conditionalWorkerBypass) {
  warn("worker.reuse", "SharedWorker creation appears conditionally bypassed; do not force window fallback for every explicit lnOrigin/room link.", adapter.file);
} else if (adapter) {
  pass("worker.reuse", "No obvious conditional bypass of SharedWorker reuse was found.", adapter.file);
}

const roomLinkSignals = /lnInvite|room.?invite|room.?link/i.test(joined);
const concurrentInviteSignals = /Promise\.all\s*\(|prefetch(?:ed)?(?:Invite|Verification)|inviteVerification\s*=|verificationPromise\s*=/i.test(joined);
if (roomLinkSignals && concurrentInviteSignals) {
  pass("performance.room-link", "Found signals that invite verification is prefetched/concurrent; verify protected join awaits both identity and invite.");
} else if (roomLinkSignals) {
  warn("performance.room-link", "Room-link handling was found without obvious concurrent invite verification; check for serialized BAL/JWKS latency.");
}

const blockingEnrichment = [];
for (const { file, text } of sources) {
  const pattern = /await\s+(?:sync\w*Presence|fetch\w*Profile|load\w*Contacts)\s*\(/ig;
  for (const match of text.matchAll(pattern)) {
    const context = text.slice(Math.max(0, match.index - 600), match.index);
    if (/function\s+(?:hydrate|enrich|refresh|load)[A-Za-z0-9_]*\s*\([^)]*\)[\s\S]*$/i.test(context)) continue;
    const line = text.slice(0, match.index).split(/\r?\n/).length;
    blockingEnrichment.push(`${path.relative(target, file)}:${line}`);
  }
}
if (blockingEnrichment.length) {
  warn("performance.enrichment", `Awaited profile/presence/social enrichment may block a critical path at ${blockingEnrichment.join(", ")}.`);
} else {
  pass("performance.enrichment", "No obvious awaited profile/presence/social enrichment was found in source.");
}

const tokenSignals = /(?:localStorage|sessionStorage)[^\n]{0,160}token|session.?token|auth.?token/i.test(joined);
const bindingSignals = /tokenBelongsToPubkey|sessionTokenBelongsToPubkey|token[^\n]{0,80}pubkey|pubkey[^\n]{0,80}token/i.test(joined);
if (!tokenSignals) pass("session.binding", "No persistent game-token flow detected; identity binding may be inapplicable.");
else if (bindingSignals) pass("session.binding", "Found an apparent token-to-pubkey binding check; review its trust boundary.");
else warn("session.binding", "Persistent token signals exist, but no token-to-current-BAL-pubkey binding check was found.");

const challengeSignals = /challenge/i.test(joined);
const signatureSignals = /verifyEvent\s*\(|verifySignature\s*\(|validateEvent\s*\(/.test(joined);
if (challengeSignals && signatureSignals) pass("server.challenge", "Found challenge and Nostr signature-verification signals; inspect one-use/freshness checks manually.");
else warn("server.challenge", "Could not confirm server-side signed challenge verification. Never authenticate from getPublicKey() alone.");

const vitePackages = packages.filter(({ pkg }) => dependencySpec(pkg, "vite") || dependencySpec(pkg, "vitest"));
if (vitePackages.length) {
  const dedupeNgp = /dedupe\s*:\s*\[[^\]]*["']nostr-game-protocol["']/s.test(joined);
  const dedupeTools = /dedupe\s*:\s*\[[^\]]*["']nostr-tools["']/s.test(joined);
  if (dedupeNgp && dedupeTools) pass("vite.dedupe", "Vite dedupes both Nostr peer dependencies.");
  else warn("vite.dedupe", "Vite detected without dedupe for both nostr-game-protocol and nostr-tools.");
}

const unsafeLines = [];
for (const { file, text } of sources) {
  const handlesBalMessaging = /nostr-bal|launcherOrigin|lnOrigin|luna-negra:bal|Bunker Auto Login/i.test(text);
  text.split(/\r?\n/).forEach((line, index) => {
    if (/(?:localStorage|sessionStorage)\.(?:setItem|getItem)[^\n]*(?:bunkerUri|bunker_uri|nsec|private.?key)/i.test(line)) {
      unsafeLines.push(`${path.relative(target, file)}:${index + 1}`);
    }
    if (handlesBalMessaging && /postMessage\s*\([^\n]+,[\s]*["']\*["']\s*\)/.test(line)) {
      warn("security.postmessage", "Found postMessage with wildcard target origin.", file);
    }
  });
}
if (unsafeLines.length) fail("security.persistence", `Possible BAL/private credential storage at ${unsafeLines.join(", ")}.`);
else pass("security.persistence", "No obvious bunker URI/nsec/private-key browser storage was found.");

if (/Cross-Origin-Opener-Policy["']?\s*[:=]\s*["']same-origin["']/i.test(joined)) {
  warn("headers.coop", "COOP same-origin can sever the cross-origin launcher opener; verify restrict-properties/fallback.");
}
if (/Content-Security-Policy/i.test(joined) && !/worker-src[^;\n]*['"]?self/i.test(joined)) {
  warn("headers.csp", "CSP was detected without an obvious worker-src 'self' allowance.");
}

const summary = {
  target,
  counts: {
    pass: findings.filter((item) => item.level === "PASS").length,
    warn: findings.filter((item) => item.level === "WARN").length,
    fail: findings.filter((item) => item.level === "FAIL").length,
  },
  findings,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`BAL integration audit: ${target}`);
  for (const item of findings) {
    console.log(`[${item.level}] ${item.code}: ${item.message}${item.file ? ` (${item.file})` : ""}`);
  }
  console.log(`Summary: ${summary.counts.pass} passed, ${summary.counts.warn} warnings, ${summary.counts.fail} failed.`);
}

process.exit(summary.counts.fail ? 1 : 0);
