/**
 * How much of a goal turn is actually new work?
 *
 * The budget used to count `totalTokens`, which pi defines as
 * input + output + cacheRead + cacheWrite. A goal loop re-reads its whole
 * cached prefix every single turn, so that number measures the conversation's
 * length times the number of turns — not the work done. This runs a real
 * cached session and prints both meters side by side, so the claim in
 * src/usage.ts is a measurement rather than an argument.
 *
 * Needs a provider that reports a cache breakdown (Anthropic models do).
 *
 *   bun run test/live/budget-meter.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { billableTokens } from "../../src/usage.ts";

const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "anthropic/claude-sonnet-4.5";
const NL = String.fromCharCode(10);

const home = mkdtempSync(join(tmpdir(), "pify-budget-meter-"));
const repo = mkdtempSync(join(tmpdir(), "pify-budget-repo-"));
const out = join(home, "usage.jsonl");
const probe = join(home, "probe.ts");

const PROBE_SOURCE = [
  'import { appendFileSync } from "node:fs";',
  "export default function probe(pi) {",
  '  pi.on("message_end", async (event) => {',
  "    const u = event && event.message && event.message.usage;",
  '    if (event && event.message && event.message.role === "assistant" && u) {',
  "      appendFileSync(process.env.USAGE_OUT, JSON.stringify({",
  "        input: u.input, output: u.output, cacheRead: u.cacheRead,",
  "        cacheWrite: u.cacheWrite, totalTokens: u.totalTokens,",
  "      }) + String.fromCharCode(10));",
  "    }",
  "  });",
  "}",
].join(NL);

try {
  writeFileSync(probe, PROBE_SOURCE);
  writeFileSync(join(repo, "a.ts"), "export const a = 1;" + NL);
  writeFileSync(join(repo, "b.ts"), "export const b = 2;" + NL);

  spawnSync(
    "pi",
    [
      "--provider", PROVIDER,
      "--model", MODEL,
      "--no-extensions",
      "-e", probe,
      // Wrapped in literal double quotes: spawnSync with shell:true on
      // Windows concatenates args unquoted, and an unwrapped sentence reaches
      // pi as one prompt per word (see task/test/live/sweep-wire.mjs).
      "-p", '"Read a.ts then read b.ts using the read tool, then say DONE."',
    ],
    {
      cwd: repo,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, USAGE_OUT: out },
    },
  );

  const turns = existsSync(out)
    ? readFileSync(out, "utf8").split(NL).filter(Boolean).map((l) => JSON.parse(l))
    : [];

  let passed = 0;
  let failed = 0;
  const check = (name, ok, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    ok ? passed++ : failed++;
  };

  const old = turns.reduce((n, t) => n + t.totalTokens, 0);
  const meter = turns.reduce((n, t) => n + billableTokens(t), 0);
  const cached = turns.reduce((n, t) => n + t.cacheRead, 0);

  console.log(`assistant messages: ${turns.length}`);
  for (const t of turns) {
    console.log(
      `  totalTokens ${String(t.totalTokens).padStart(6)}  →  budget meter ${String(billableTokens(t)).padStart(6)}` +
        `   (cacheRead ${t.cacheRead})`,
    );
  }
  console.log(`${NL}old meter: ${old}   new meter: ${meter}   of which re-read from cache: ${cached}`);

  check("the session ran", turns.length > 0, `${turns.length} messages`);
  check("the provider reports a cache breakdown", cached > 0, `${cached} cached tokens`);
  // The claim is that the old meter counted the cached re-reads and the new
  // one does not — so the gap between them IS the cached tokens. Asserting a
  // factor instead was measuring the session's length: a two-turn run lands at
  // 1.96 and failed a `> 2` threshold while the property under test held
  // exactly. A test that depends on how chatty the model felt is not measuring
  // the meter.
  check(
    "the old meter counted the cached re-reads and the new one does not",
    Math.abs(old - meter - cached) <= Math.max(50, cached * 0.02),
    `old ${old} − new ${meter} = ${old - meter}, cached ${cached}`,
  );
  const steady = turns.filter((t) => t.cacheRead > 0);
  check(
    "a steady-state turn adds far less than it re-reads",
    steady.length > 0 && steady.every((t) => billableTokens(t) * 10 < t.totalTokens),
    steady.map((t) => `${billableTokens(t)}/${t.totalTokens}`).join(", "),
  );

  console.log(`${NL}${passed}/${passed + failed} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
