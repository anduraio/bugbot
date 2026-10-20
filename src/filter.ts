import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Severity and category values the reviewer may return.
 * Anything outside these enums is dropped by FindingSchema.
 */
export const SeveritySchema = z.enum(["high", "medium", "low"]);
export const CategorySchema = z.enum(["bug", "security", "edge-case", "data", "root-cause"]);
export const SideSchema = z.enum(["RIGHT", "LEFT"]);

export const FindingSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  end_line: z.number().int().positive().optional(),
  side: SideSchema.default("RIGHT"),
  severity: SeveritySchema,
  category: CategorySchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  suggested_fix: z.string().default(""),
  angle: z.string().min(1),
  /**
   * Enclosing symbol supplied by the context pass. Part of the finding hash so
   * moving a finding between functions creates a new hash, while moving it
   * between lines does not.
   */
  symbol: z.string().default(""),
});

export type Finding = z.infer<typeof FindingSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Category = z.infer<typeof CategorySchema>;
export type DiffSide = z.infer<typeof SideSchema>;

/**
 * Normalize the reason so formatting-only model drift does not create a new
 * finding. Lowercase, strip markdown backticks, turn punctuation into spaces,
 * collapse whitespace and trim. Deliberately keeps the whole reason: the
 * hash is about identity, not brevity.
 */
export function normalizeReason(reason: string): string {
  return reason
    .normalize("NFKC")
    .toLowerCase()
    .replace(/`+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Stable identity for a finding: sha1(file + category + normalized reason +
 * symbol). The line number is intentionally excluded, so code that moves down
 * the file dedupes instead of posting again.
 */
export function findingHash(
  finding: Pick<Finding, "file" | "category" | "reason" | "symbol">,
): string {
  const key = [
    finding.file,
    finding.category,
    normalizeReason(finding.reason),
    finding.symbol,
  ].join("\u0000");

  return createHash("sha1").update(key, "utf8").digest("hex");
}

/**
 * Hidden comment marker plus the visible-or-hidden RUN_ID line that
 * poteto-mode's watch-pr reads to count review passes.
 */
export function marker(hash: string, runId: string, sha: string): string {
  return `<!-- bugbot:v1 id=${hash} run=${runId} sha=${sha} -->\nRUN_ID: ${runId}`;
}

/**
 * File path -> diff side -> postable line numbers on that side. RIGHT covers
 * the new file and LEFT the old one, so a LEFT finding can never land on a
 * line that only exists on the RIGHT side.
 */
export type ChangedLines = ReadonlyMap<
  string,
  ReadonlyMap<DiffSide, ReadonlySet<number>>
>;

export interface ShouldPostOptions {
  minConfidence: number;
  changedLines: ChangedLines;
  /**
   * Inverted bugbot-triage self-filter. Return false to send the finding to
   * the summary instead of posting it. Step 5 supplies the real filter; until
   * then every finding passes.
   */
  selfFilter?: (finding: Finding) => boolean;
}

/**
 * Post only high-confidence, at-least-medium findings whose line is in the
 * PR's diff. Everything else belongs in the summary as a count.
 */
export function shouldPost(finding: Finding, options: ShouldPostOptions): boolean {
  if (finding.confidence < options.minConfidence) {
    return false;
  }

  if (finding.severity === "low") {
    return false;
  }

  const sides = options.changedLines.get(finding.file);
  if (sides === undefined) {
    return false;
  }

  const lines = sides.get(finding.side);
  if (lines === undefined || !lines.has(finding.line)) {
    return false;
  }

  if (finding.end_line !== undefined) {
    if (finding.end_line < finding.line || !lines.has(finding.end_line)) {
      return false;
    }
  }

  if (options.selfFilter !== undefined && !options.selfFilter(finding)) {
    return false;
  }

  return true;
}
