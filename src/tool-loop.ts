/**
 * A stuck-tool-loop detector, complementing the no-progress guard.
 *
 * The LoopGuard in this suite fingerprints TURNS and treats any turn that
 * called a tool as progress — so an agent re-running the exact same tool with
 * the exact same arguments every turn (re-reading one file, re-running one
 * failing command, polling one id forever) is never flagged: each turn "made
 * progress". For an UNATTENDED self-driving loop that is money spent on a spin.
 *
 * This watches the last `window` tool calls (default 5) across the driven run.
 * When all of them are the same tool with byte-identical canonical arguments,
 * it reports once and clears, so the caller can pause or disarm. Arguments are
 * canonicalised with sorted keys, so `{a,b}` and `{b,a}` match but `echo 1` and
 * `echo 2` do not. The idea is ECC's loop detector (affaan-m/ECC hooks): a
 * 5-slot ring of tool+full-payload hashes where all five must match. Zero
 * dependencies beyond node:crypto; deterministic and pure.
 */
import { createHash } from "node:crypto";

/** Stable JSON: object keys sorted recursively, so argument order never matters. */
function canonical(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[circular]";
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = walk((v as Record<string, unknown>)[key]);
    return out;
  };
  try {
    return JSON.stringify(walk(value));
  } catch {
    return "";
  }
}

export class ToolLoopRing {
  private ring: string[] = [];
  private readonly window: number;

  constructor(window = 5) {
    this.window = Math.max(2, Math.floor(window));
  }

  /**
   * Record one tool call. Returns a reason string the first time the last
   * `window` calls are all the same tool with identical arguments (and clears,
   * so it reports once per stuck run), null otherwise.
   */
  push(toolName: string, args: unknown): string | null {
    const key = createHash("sha256").update(`${toolName}\u0000${canonical(args)}`).digest("hex");
    this.ring.push(key);
    if (this.ring.length > this.window) this.ring.shift();
    if (this.ring.length === this.window && this.ring.every((k) => k === this.ring[0])) {
      this.ring = [];
      return `the same \`${toolName}\` call repeated ${this.window} times in a row`;
    }
    return null;
  }

  reset(): void {
    this.ring = [];
  }
}
