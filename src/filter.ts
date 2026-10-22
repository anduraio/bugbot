import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Severity and category values the reviewer may return.
 * Anything outside these enums is dropped by FindingSchema, except the
 * fail-safe normalizations below.
 */
export const SeveritySchema = z.enum(["high", "medium", "low"]);
export const CategorySchema = z.enum(["bug", "security", "edge-case", "data", "root-cause"]);
export const SideSchema = z.enum(["RIGHT", "LEFT"]);
/**
 * The model's self-triage, applying prompts/bugbot-triage.md in the same pass.
 * `dismiss` findings count in the summary only, except that high severity and
 * the security/data categories can never be dismissed (see `triageAllowsPost`).
 */
export const TriageSchema = z.enum(["fix", "ask", "dismiss"]);

const CATEGORY_VALUES = new Set(["bug", "security", "edge-case", "data", "root-cause"]);
const TRIAGE_VALUES = new Set(["fix", "ask", "dismiss"]);

/**
 * Fail-safe aliases applied before schema validation, so a typo can never
 * suppress a finding:
 * - `triage`: trim + lowercase; `"skip"` is an alias of `"dismiss"`; any
 *   other unknown value, `null` or a non-string becomes `"fix"`.
 * - `category`: trim + lowercase; any other unknown value becomes `"bug"`.
 *   `categoryCoerced` records that this happened (R2-N1), so a `dismiss` on a
 *   coerced category is ignored the same way the safety override ignores one.
 * - `severity`: trim + lowercase only. An unknown severity stays invalid
 *   rather than guessing how severe a bug is.
 *
 * `categoryCoerced` is internal: a re-parse of an already-normalized finding
 * keeps a carried `true` (the model layer parses, then `classifyFindings`
 * parses again), but a real coercion can never be cleared, because the
 * computed value is OR-ed with the carried one.
 */
function normalizeFindingFields(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) {
    return raw;
  }

  const value: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const lower = (field: unknown): string | undefined =>
    typeof field === "string" ? field.trim().toLowerCase() : undefined;

  const triage = lower(value.triage);
  if (triage !== undefined) {
    value.triage = triage === "skip" ? "dismiss" : TRIAGE_VALUES.has(triage) ? triage : "fix";
  } else if ("triage" in value) {
    value.triage = "fix";
  }

  let categoryCoerced = value.categoryCoerced === true;
  const category = lower(value.category);
  if (category !== undefined) {
    if (CATEGORY_VALUES.has(category)) {
      value.category = category;
    } else {
      value.category = "bug";
      categoryCoerced = true;
    }
  } else if ("category" in value && value.category !== undefined) {
    // null and other non-strings are coerced too; a missing category stays
    // schema-invalid, as decided in the fix brief.
    value.category = "bug";
    categoryCoerced = true;
  }
  value.categoryCoerced = categoryCoerced;

  const severity = lower(value.severity);
  if (severity !== undefined) {
    value.severity = severity;
  }

  return value;
}

const FindingObjectSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  end_line: z.number().int().positive().optional(),
  side: SideSchema.default("RIGHT"),
  severity: SeveritySchema,
  category: CategorySchema,
  /**
   * Internal fail-safe flag set by `normalizeFindingFields` (R2-N1): the
   * category was unknown or null and became `"bug"`. It is not part of the
   * model's output contract and is stripped from `--local` JSON, but a carried
   * `true` from an earlier parse is preserved (OR-ed), so a real coercion can
   * never be cleared. A model that sets it can only make `dismiss` ignored,
   * which is the safe direction.
   */
  categoryCoerced: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  suggested_fix: z.string().default(""),
  angle: z.string().min(1),
  /**
   * Enclosing symbol supplied by the context pass. Kept in the schema for the
   * prompt contract, but ignored by the hash: the deterministic symbol below
   * is what identifies a finding.
   */
  symbol: z.string().default(""),
  /** Self-triage: fix or ask to post, dismiss to count in the summary only. */
  triage: TriageSchema.default("fix"),
});

/**
 * A reason made only of punctuation or emoji normalizes to an empty token set,
 * which would make unrelated findings look identical. Require one letter or
 * digit; the similarity function also treats zero tokens as dissimilar.
 */
const FindingValidatedSchema = FindingObjectSchema.superRefine((value, context) => {
  if (!/[\p{L}\p{N}]/u.test(value.reason)) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "reason must contain at least one letter or digit",
    });
  }
});

export const FindingSchema = z.preprocess(normalizeFindingFields, FindingValidatedSchema);

export type Finding = z.infer<typeof FindingSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Category = z.infer<typeof CategorySchema>;
export type DiffSide = z.infer<typeof SideSchema>;
export type Triage = z.infer<typeof TriageSchema>;

/** Post only findings at or above this confidence unless configured lower. */
export const DEFAULT_MIN_CONFIDENCE = 0.8;
/** Hard cap of inline comments per pass. The rest count as overCap. */
export const MAX_POSTED_COMMENTS = 15;
/** Jaccard threshold for "the model reworded the same finding". */
export const REASON_SIMILARITY_THRESHOLD = 0.6;
/** Visible comment body cap, not counting the hidden marker. */
export const MAX_COMMENT_BODY = 4_000;
/** Comment title line, including the surrounding `**`. */
export const MAX_TITLE_LINE = 100;

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
 * deterministic symbol). The line number is intentionally excluded, so code
 * that moves down the file dedupes instead of posting again.
 *
 * The model's own `symbol` is ignored; pass the symbol from `enclosingSymbol`.
 * The default is the hunk-context/`""` fallback.
 */
export function findingHash(
  finding: Pick<Finding, "file" | "category" | "reason">,
  symbol = "",
): string {
  const key = [
    finding.file,
    finding.category,
    normalizeReason(finding.reason),
    symbol,
  ].join("\u0000");

  return createHash("sha1").update(key, "utf8").digest("hex");
}

/** Jaccard similarity of the normalized reason token sets, in [0, 1]. */
export function reasonSimilarity(a: string, b: string): number {
  const left = new Set(normalizeReason(a).split(" ").filter(Boolean));
  const right = new Set(normalizeReason(b).split(" ").filter(Boolean));

  if (left.size === 0 || right.size === 0) {
    // Punctuation-only reasons have no identity to compare; never let two
    // empty token sets count as a perfect match.
    return 0;
  }

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1;
    }
  }

  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Reads BUGBOT_MIN_CONFIDENCE. A finite number in [0, 1] is honored; empty,
 * non-numeric, out-of-range, whitespace-padded or otherwise malformed values
 * fall back to 0.8, so garbage can never lower the bar. `0.1` is allowed on
 * purpose: an operator can deliberately lower the threshold. Whitespace is
 * rejected rather than trimmed because a typo must not silently change it.
 */
export function minConfidenceFromEnv(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_MIN_CONFIDENCE;
  }

  if (raw === "" || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) {
    return DEFAULT_MIN_CONFIDENCE;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return DEFAULT_MIN_CONFIDENCE;
  }

  return parsed;
}

/**
 * Hidden comment marker plus the visible-or-hidden RUN_ID line that
 * poteto-mode's watch-pr reads to count review passes.
 */
export function marker(hash: string, runId: string, sha: string): string {
  return `<!-- bugbot:v1 id=${hash} run=${runId} sha=${sha} -->\nRUN_ID: ${runId}`;
}

export interface ParsedMarker {
  hash: string;
  runId: string;
  sha: string;
}

/**
 * The marker must be the whole line, exactly as `marker` writes it. Embedded
 * text, extra fields and missing fields are ignored.
 *
 * Step 6 note: a marker proves only that *some* comment body contains this
 * text. Callers must only trust markers on comments authored by the Bugbot
 * App (the `andura-bugbot[bot]` login), because a hostile PR body or reply can
 * contain a look-alike marker. Formatting a comment neutralizes marker syntax
 * in model text, but that does not authenticate other authors.
 */
const MARKER_LINE =
  /^<!-- bugbot:v1 id=([0-9a-f]{40}) run=([^\s]+) sha=([^\s]+) -->$/;

export function parseMarker(body: string): ParsedMarker | null {
  for (const line of body.split(/\r?\n/)) {
    const match = MARKER_LINE.exec(line);
    if (match !== null) {
      const hash = match[1];
      const runId = match[2];
      const sha = match[3];
      if (hash !== undefined && runId !== undefined && sha !== undefined) {
        return { hash, runId, sha };
      }
    }
  }

  return null;
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
   * the summary instead of posting it.
   */
  selfFilter?: (finding: Finding) => boolean;
}

type GateFailure = "belowConfidence" | "lowSeverity" | "notInDiff";

/**
 * First failing confidence/severity/diff-line rule, in that order. Used both
 * by `shouldPost` (as a boolean gate) and by `classifyFindings` (to attribute
 * the summary count), so the two can never drift.
 */
function gateFailure(
  finding: Finding,
  minConfidence: number,
  changedLines: ChangedLines,
): GateFailure | null {
  if (finding.confidence < minConfidence) {
    return "belowConfidence";
  }

  if (finding.severity === "low") {
    return "lowSeverity";
  }

  const sides = changedLines.get(finding.file);
  if (sides === undefined) {
    return "notInDiff";
  }

  const lines = sides.get(finding.side);
  if (lines === undefined || !lines.has(finding.line)) {
    return "notInDiff";
  }

  if (finding.end_line !== undefined) {
    if (finding.end_line < finding.line || !lines.has(finding.end_line)) {
      return "notInDiff";
    }
  }

  return null;
}

/**
 * Post only high-confidence, at-least-medium findings whose line is in the
 * PR's diff. Everything else belongs in the summary as a count.
 */
export function shouldPost(finding: Finding, options: ShouldPostOptions): boolean {
  if (gateFailure(finding, options.minConfidence, options.changedLines) !== null) {
    return false;
  }

  if (options.selfFilter !== undefined && !options.selfFilter(finding)) {
    return false;
  }

  return true;
}

/**
 * The triage rule with the safety override. A `dismiss` is ignored when the
 * finding is high severity, in the security/data categories, or its category
 * was coerced to `"bug"` from an unknown value (R2-N1): the model cannot talk
 * itself out of those, and a misspelled `"securty"` must not hide one.
 */
export function triageAllowsPost(finding: Finding): boolean {
  if (finding.triage !== "dismiss" || finding.categoryCoerced) {
    return true;
  }

  return (
    finding.severity === "high" ||
    finding.category === "security" ||
    finding.category === "data"
  );
}

export interface EnclosingSymbolOptions {
  /**
   * True when `content` is the whole file. When false (for example a ±80-line
   * window from the context pass, N10) the hunk context is used instead of
   * scanning the window as if it started at line 1.
   */
  fullContent?: boolean;
}

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "return",
  "typeof",
  "new",
  "delete",
  "await",
  "yield",
  "do",
  "else",
  "try",
  "finally",
  "throw",
  "super",
  "this",
  "import",
  "export",
  "function",
  "class",
  "const",
  "let",
  "var",
  "async",
  "interface",
  "type",
  "enum",
]);

interface Declaration {
  name: string;
  openLine: number;
  closeLine?: number;
  parent: Declaration | null;
  /** Dotted name, built once from the parent's cached name (R3-N3). */
  qualified: string;
  /** Number of named components in `qualified`, capped by MAX_SYMBOL_NAME_DEPTH. */
  depth: number;
}

interface BodyOpen {
  openLine: number;
  openColumn: number;
}

interface StripState {
  blockComment: boolean;
  template: boolean;
  /** Python triple-quoted string that is still open, if any. */
  triple: '"""' | "'''" | null;
}

/**
 * Simple regex-literal heuristic (R2-N2): after one of these tokens a `/`
 * opens a regex rather than division. Deliberately conservative; a false
 * negative only leaves a brace in the scope count, a false positive could
 * hide real code.
 */
const REGEX_PREFIX_CHARS = "(,=:[!&|?;{}";
const REGEX_PREFIX_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

/**
 * Rust declarations use `'a` lifetimes, which the generic single-quote string
 * lexer would mistake for a string start. Only on lines that clearly begin a
 * Rust declaration (and therefore cannot be JavaScript) is an apostrophe
 * followed by an identifier treated as a lifetime.
 */
const RUST_DECLARATION_LINE =
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?(?:impl|fn|struct|enum|trait|where)\b/;

function lifetimeAt(line: string, index: number): string | null {
  // The caller has already tested RUST_DECLARATION_LINE once per line (R5-B1).
  const match = /^'[A-Za-z_]\w*/.exec(line.slice(index));
  if (match === null || line[index + match[0].length] === "'") {
    return null;
  }
  return match[0];
}

/**
 * Longest regex literal considered. A `/` that is not closed within this many
 * characters is treated as division, so an unterminated class such as `/[/[/[`
 * cannot make every second character rescan the rest of the line (R4-B1).
 * Trade-off: a longer valid regex is lexed as division and can shift a symbol (R5-N4).
 */
const MAX_REGEX_LITERAL_CHARS = 256;

/**
 * Characters scanned by `regexLiteralEnd`. Exported for the R5-N1 test: the
 * cap makes this linear, and a work bound is deterministic where a wall-clock
 * limit was flaky (N8).
 */
export const regexScanStats = { chars: 0 };

/**
 * Index of the closing `/` of a regex literal, or -1 when this line has none.
 * `lastCloseBracket` is `line.lastIndexOf("]")`, computed once per line: a
 * character class that has no `]` after it can never close, so `/[/[/[...` is
 * rejected without rescanning 256 characters at every `/` (R4-B1).
 */
function regexLiteralEnd(line: string, start: number, lastCloseBracket: number): number {
  const limit = Math.min(line.length, start + 1 + MAX_REGEX_LITERAL_CHARS);
  regexScanStats.chars += Math.max(0, limit - (start + 1));
  let inClass = false;
  let index = start + 1;
  while (index < limit) {
    const code = line.charCodeAt(index);
    if (code === 92 /* \ */) {
      index += 2;
      continue;
    }
    if (code === 91 /* [ */) {
      if (index > lastCloseBracket) {
        return -1;
      }
      inClass = true;
    } else if (code === 93 /* ] */) {
      inClass = false;
    } else if (code === 47 /* / */ && !inClass) {
      return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * Bound on the emitted-text look-behind `regexCanStartAfter` performs. A word
 * longer than this cannot be one of the prefix keywords, and the walk stops at
 * the first non-word character, so the look-behind is short and the stripper
 * stays linear (R4-B1).
 */
const STRIP_TAIL_CHARS = 128;

/**
 * True when a regex literal may start after the text emitted so far. Reads only
 * the last token, backwards from the end of `parts`, instead of the whole
 * accumulated line: the previous implementation passed `out` to the identifier
 * regex once per `/`, which is quadratic on a long line (R4-B1). `parts` holds
 * emitted pieces, most one character; the walk visits each character at most
 * once between slashes.
 */
function regexCanStartAfter(parts: readonly string[]): boolean {
  let pieceIndex = parts.length - 1;
  let charIndex = pieceIndex >= 0 ? (parts[pieceIndex] ?? "").length - 1 : -1;
  const previous = (): string => {
    while (pieceIndex >= 0) {
      const piece = parts[pieceIndex] ?? "";
      if (charIndex >= 0) {
        const char = piece[charIndex] ?? "";
        charIndex -= 1;
        return char;
      }
      pieceIndex -= 1;
      charIndex = pieceIndex >= 0 ? (parts[pieceIndex] ?? "").length - 1 : -1;
    }
    return "";
  };

  let last = previous();
  while (last !== "" && isWhitespace(last)) {
    last = previous();
  }
  if (last === "") {
    return true;
  }
  if (REGEX_PREFIX_CHARS.includes(last)) {
    return true;
  }
  if (!isWordChar(last)) {
    return false;
  }

  let word = last;
  let looked = 1;
  for (let char = previous(); char !== "" && isWordChar(char); char = previous()) {
    looked += 1;
    if (looked > STRIP_TAIL_CHARS) {
      // Longer than any prefix keyword, so the old regex could not match one.
      return false;
    }
    word = char + word;
  }
  // `\w` includes digits, but an identifier cannot start with one; drop them so
  // `1abc` still yields the `abc` the old regex found.
  return REGEX_PREFIX_WORDS.has(word.replace(/^[0-9]+/, ""));
}

/**
 * Blanks string, template-literal, regex-literal, Python triple-quoted string
 * and comment contents while keeping the line length (and therefore every code
 * column) unchanged. Braces in those regions then cannot move the scope depth.
 * This is deliberately not a full parser.
 */
function stripStringsAndComments(line: string, state: StripState): string {
  const parts: string[] = [];
  const emit = (piece: string): void => {
    parts.push(piece);
  };
  let quote: string | null = null;
  let index = 0;
  // -2 = not computed yet; lastIndexOf scans the line once, lazily.
  // Performance fast path only, no behaviour effect (R6-N2).
  let lastCloseBracket = -2;
  // Same lazy once-per-line answer: the whole-line Rust test is anchored at the
  // start and would otherwise rescan the line's leading whitespace at every
  // apostrophe, which is quadratic on one long line (R5-B1).
  let rustLine: boolean | null = null;

  while (index < line.length) {
    const char = line[index] ?? "";
    const next = line[index + 1] ?? "";

    if (state.blockComment) {
      if (char === "*" && next === "/") {
        state.blockComment = false;
        emit("  ");
        index += 2;
      } else {
        emit(" ");
        index += 1;
      }
      continue;
    }

    if (state.template) {
      if (char === "\\") {
        emit("  ");
        index += 2;
      } else if (char === "`") {
        state.template = false;
        emit("`");
        index += 1;
      } else {
        emit(" ");
        index += 1;
      }
      continue;
    }

    if (state.triple !== null) {
      if (line.startsWith(state.triple, index)) {
        emit(state.triple);
        state.triple = null;
        index += 3;
      } else {
        emit(" ");
        index += 1;
      }
      continue;
    }

    if (quote !== null) {
      if (char === "\\") {
        emit("  ");
        index += 2;
      } else if (char === quote) {
        quote = null;
        emit(char);
        index += 1;
      } else {
        emit(" ");
        index += 1;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      emit(" ".repeat(line.length - index));
      break;
    }
    if (char === "/" && next === "*") {
      state.blockComment = true;
      emit("  ");
      index += 2;
      continue;
    }
    if (char === "/" && regexCanStartAfter(parts)) {
      if (lastCloseBracket === -2) {
        lastCloseBracket = line.lastIndexOf("]");
      }
      const end = regexLiteralEnd(line, index, lastCloseBracket);
      if (end >= 0) {
        emit(`/${" ".repeat(end - index - 1)}/`);
        index = end + 1;
        continue;
      }
    }
    if (line.startsWith('"""', index) || line.startsWith("'''", index)) {
      state.triple = line.startsWith('"""', index) ? '"""' : "'''";
      emit(state.triple);
      index += 3;
      continue;
    }
    if (char === "`") {
      state.template = true;
      emit(char);
      index += 1;
      continue;
    }
    if (char === "'") {
      rustLine ??= RUST_DECLARATION_LINE.test(line);
      const lifetime = rustLine ? lifetimeAt(line, index) : null;
      if (lifetime !== null) {
        emit(lifetime);
        index += lifetime.length;
        continue;
      }
    }
    if (char === '"' || char === "'") {
      quote = char;
      emit(char);
      index += 1;
      continue;
    }

    emit(char);
    index += 1;
  }

  return parts.join("");
}

/** First plain `=` (not `=>`, `==` or another compound operator) at or after `from`. */
function findAssignment(line: string, from: number): number {
  for (let index = from; index < line.length; index += 1) {
    if (line[index] !== "=") {
      continue;
    }
    const previous = line[index - 1] ?? "";
    const next = line[index + 1] ?? "";
    if (next === ">" || next === "=" || previous === "=") {
      continue;
    }
    if ("+-*/%&|^!<>?".includes(previous)) {
      continue;
    }
    return index;
  }
  return -1;
}

/** Index of the first non-whitespace character at or after `from`. */
function skipSpaces(text: string, from: number): number {
  let index = from;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }
  return index;
}

/**
 * Index just past a balanced `<...>` type-parameter list starting at `start`,
 * or `start` when there is none (R3-B1). The angle-depth scan mirrors
 * `findBodyOpen`, so `<T extends Map<K, V>>` is skipped as one list.
 */
function skipTypeParameterList(text: string, start: number): number {
  if (text[start] !== "<") {
    return start;
  }

  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (char === "=" && next === ">") {
      // `=>` in a constraint type is not the end of the list.
      index += 1;
    } else if (char === "<") {
      depth += 1;
    } else if (char === ">") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return start;
}

/**
 * Index just past a balanced `[...]` type-parameter list starting at `start`,
 * or `start` when there is none. Go spells its type parameters with brackets
 * (R3-B1), and a constraint can itself contain brackets (`[]T`, `map[K]V`).
 */
function skipBracketTypeParameterList(text: string, start: number): number {
  if (text[start] !== "[") {
    return start;
  }

  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return start;
}

function isCallableStart(text: string): boolean {
  const trimmed = text.trimStart();
  if (/^(?:async\s+)?function\b/.test(trimmed)) {
    return true;
  }

  // Generic arrow: `<T>(x) =>` or `async <T,>(x) =>` (R3-B1).
  const withoutAsync = trimmed.replace(/^async\s+/, "");
  const afterTypeParameters = skipTypeParameterList(withoutAsync, 0);
  if (afterTypeParameters > 0) {
    return withoutAsync.slice(afterTypeParameters).trimStart().startsWith("(");
  }

  return (
    /^async\s+\(/.test(trimmed) ||
    /^async\s+[A-Za-z_$][\w$]*\s*=>/.test(trimmed) ||
    trimmed.startsWith("(") ||
    /^[A-Za-z_$][\w$]*\s*=>/.test(trimmed)
  );
}

function callableNeedsArrow(text: string): boolean {
  return !/^(?:async\s+)?function\b/.test(text.trimStart());
}

const TYPE_BRACE_KEYWORDS = new Set([
  "is",
  "keyof",
  "extends",
  "infer",
  "typeof",
  "readonly",
  "satisfies",
  "as",
  "of",
  "instanceof",
  "new",
  "struct",
  "interface",
]);

/**
 * Characters before a `{` that `isTypeLiteralBrace` inspects for a type
 * keyword. The longest keyword (`instanceof`) is 10, so a longer word cannot
 * match; the bound also stops the look-behind from rescanning a long line
 * prefix for every brace (R4-B1).
 */
const TYPE_LITERAL_LOOKBEHIND_CHARS = 64;

function isWordCode(code: number): boolean {
  return (
    (code >= 97 && code <= 122) || // a-z
    (code >= 65 && code <= 90) || // A-Z
    (code >= 48 && code <= 57) || // 0-9
    code === 95 || // _
    code === 36 // $
  );
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isWhitespaceCode(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  );
}

function isWordChar(char: string): boolean {
  return isWordCode(char.charCodeAt(0));
}

function isWhitespace(char: string): boolean {
  return isWhitespaceCode(char.charCodeAt(0));
}

/**
 * True when the `{` at `column` belongs to a type literal rather than a body
 * (R2-B2): after `:`/`|`/`&`/`<`/`,`/`=` or after a type keyword such as the
 * `is` in `v is { a: 1 }`. Scoped by the caller to a return-type position.
 * Compares the word backwards without slicing, so a line full of `is{` does
 * not allocate one string per brace (R4-B1).
 */
function isTypeLiteralBrace(text: string, column: number): boolean {
  let previous = column - 1;
  while (previous >= 0 && isWhitespaceCode(text.charCodeAt(previous))) {
    previous -= 1;
  }
  if (previous < 0) {
    return false;
  }

  const code = text.charCodeAt(previous);
  // `:` `|` `&` `<` `,` `=`
  if (code === 58 || code === 124 || code === 38 || code === 60 || code === 44 || code === 61) {
    return true;
  }

  let start = previous;
  while (
    start >= 0 &&
    previous - start < TYPE_LITERAL_LOOKBEHIND_CHARS &&
    isWordCode(text.charCodeAt(start))
  ) {
    start -= 1;
  }
  // The old regex was `([A-Za-z_$][\w$]*)$`: a leading digit run is not part of
  // the match, so skip it before comparing.
  let wordStart = start + 1;
  while (wordStart <= previous && isDigitCode(text.charCodeAt(wordStart))) {
    wordStart += 1;
  }
  const length = previous - wordStart + 1;
  if (length <= 0) {
    return false;
  }

  for (const keyword of TYPE_BRACE_KEYWORDS) {
    if (keyword.length !== length) {
      continue;
    }
    let matches = true;
    for (let offset = 0; offset < length; offset += 1) {
      if (text.charCodeAt(wordStart + offset) !== keyword.charCodeAt(offset)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

/**
 * Total characters `findBodyOpen` may examine for one declaration. The 21-line
 * lookahead alone does not bound the work when a single line is hundreds of
 * thousands of characters; a real signature fits well inside this (R4-B1).
 * Trade-off: a signature whose `{` is past this budget is not named (R5-N4).
 * Overlaps MAX_IMPL_HEADER_CHARS on purpose, as defence in depth (R5-N1).
 */
const MAX_BODY_SCAN_CHARS = 4_000;

/**
 * Finds the `{` that opens a declaration body. Parentheses and brackets are
 * tracked, so a default parameter, a callback parameter type or a destructured
 * param cannot be mistaken for the body. Angle brackets are tracked after the
 * parameter list so the `{` of a return type such as `Promise<{ ok: boolean }>`
 * or `: { a: 1 } | null` is skipped instead of being taken as the body.
 * Multi-line signatures work because the scan continues until `{`, `;` or a
 * Python-like trailing `:`.
 */
function findBodyOpen(
  lines: readonly string[],
  startLine: number,
  startColumn: number,
  requireArrow: boolean,
  requireParams: boolean,
): BodyOpen | null {
  let paren = 0;
  let bracket = 0;
  let angle = 0;
  let sawArrow = false;
  let sawParamsClose = false;
  let scannedChars = 0;

  for (let offset = 0; startLine + offset < lines.length; offset += 1) {
    if (offset > 20) {
      return null;
    }

    const text = lines[startLine + offset] ?? "";
    let column = offset === 0 ? startColumn : 0;

    while (column < text.length) {
      scannedChars += 1;
      if (scannedChars > MAX_BODY_SCAN_CHARS) {
        return null;
      }
      const char = text[column] ?? "";
      const next = text[column + 1] ?? "";

      if (char === "(") {
        paren += 1;
        column += 1;
        continue;
      }
      if (char === ")") {
        paren = Math.max(0, paren - 1);
        if (paren === 0) {
          sawParamsClose = true;
        }
        column += 1;
        continue;
      }
      if (char === "[") {
        bracket += 1;
        column += 1;
        continue;
      }
      if (char === "]") {
        bracket = Math.max(0, bracket - 1);
        column += 1;
        continue;
      }
      if (char === "<" && paren === 0 && bracket === 0) {
        angle += 1;
        column += 1;
        continue;
      }
      if (char === ">" && paren === 0 && bracket === 0) {
        angle = Math.max(0, angle - 1);
        column += 1;
        continue;
      }
      if (char === "=" && next === ">") {
        sawArrow = true;
        column += 2;
        continue;
      }
      if (paren === 0 && bracket === 0 && char === "{") {
        // An object literal inside `<...>` (a generic constraint or a
        // return type such as `Promise<{ ok: boolean }>`) is not the body.
        // After the parameter list, a type literal after `:`/`|`/`&`/... is
        // not the body either (R2-B2).
        if (angle > 0 || (sawParamsClose && isTypeLiteralBrace(text, column))) {
          column += 1;
          continue;
        }
        if ((!requireArrow || sawArrow) && (!requireParams || sawParamsClose)) {
          return { openLine: startLine + offset + 1, openColumn: column };
        }
        column += 1;
        continue;
      }
      if (paren === 0 && bracket === 0 && char === ";") {
        return null;
      }

      column += 1;
    }

    // A Python signature ends at `:`, not `{`; never scan into the next
    // statement looking for a brace.
    if (paren === 0 && bracket === 0 && text.trimEnd().endsWith(":")) {
      return null;
    }
    // A method's parameter list and its body brace belong together; without
    // this, a multi-line call statement could donate a later block as a body.
    if (requireParams && sawParamsClose) {
      return null;
    }
  }

  return null;
}

/**
 * True when a method-like line can really open a body: either `{` follows at
 * paren depth 0 on this line, or the parameter list is still open. This keeps
 * a plain call statement such as `write()` from being mistaken for a
 * multi-line method that opens a brace somewhere later.
 */
function methodBodyCanFollow(line: string, from: number): boolean {
  let paren = 0;
  for (let index = from; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === "(") {
      paren += 1;
    } else if (char === ")") {
      paren = Math.max(0, paren - 1);
    } else if (char === "{" && paren === 0) {
      return true;
    }
  }
  return paren > 0;
}

/**
 * Index of a whole word at angle-bracket depth 0, or -1. Used for the Rust
 * `impl ... for ...` header, where `for` inside `From<T>` must not count.
 * Unbalanced angles (for example a `->` in a bound) are clamped at 0.
 */
function findTopLevelWord(text: string, word: string): number {
  let angle = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "<") {
      angle += 1;
      continue;
    }
    if (char === ">") {
      angle = Math.max(0, angle - 1);
      continue;
    }
    if (angle > 0 || !text.startsWith(word, index)) {
      continue;
    }

    const before = text[index - 1] ?? " ";
    const after = text[index + word.length] ?? " ";
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
      return index;
    }
  }
  return -1;
}

/**
 * Longest `impl` header passed to the generic stripper. Beyond it the name is
 * not worth guessing, and the trailing-`<...>` loop would be quadratic on the
 * header (R4-B1).
 * Overlaps MAX_BODY_SCAN_CHARS on purpose, as defence in depth (R5-N1).
 */
const MAX_IMPL_HEADER_CHARS = 2_000;

/**
 * Backward-scan replacements for the four end-anchored regexes that ran on a
 * declaration line (`implTypeName` and the Go receiver branch): an unanchored
 * regex with `$` is retried from every start position, which is quadratic on a
 * 2,000-char line (R6-B1). Each helper is linear in the line length and
 * reproduces the regex it replaces, with the same `\s` and `\w` character
 * sets. Exported for the equivalence test that keeps those regexes as the
 * oracle.
 */
export function trimmedEnd(text: string, end: number): number {
  let index = end;
  while (index > 0 && isWhitespaceCode(text.charCodeAt(index - 1))) {
    index -= 1;
  }
  return index;
}

/** `/([A-Za-z_]\w*)\s*$/.exec(text)?.[1] ?? ""`, without the retry. */
export function trailingIdentifier(text: string): string {
  const end = trimmedEnd(text, text.length);
  let start = end;
  while (start > 0) {
    const code = text.charCodeAt(start - 1);
    // `\w` excludes `$`, although isWordCode includes it for identifiers.
    if (code === 36 || !isWordCode(code)) {
      break;
    }
    start -= 1;
  }
  // `\w` includes digits, but an identifier cannot start with one.
  while (start < end && isDigitCode(text.charCodeAt(start))) {
    start += 1;
  }
  return text.slice(start, end);
}

/** `text.replace(/\[[^\]]*\]\s*$/, "")`, without the retry. */
export function stripTrailingBracketGroup(text: string): string {
  const end = trimmedEnd(text, text.length);
  if (end < 2 || text[end - 1] !== "]") {
    return text;
  }
  const open = text.indexOf("[", text.lastIndexOf("]", end - 2) + 1);
  return open < 0 || open >= end - 1 ? text : text.slice(0, open);
}

/** The `replace(/<[^<>]*>\s*$/, "").trimEnd()` loop, without the retry. */
export function stripTrailingAngleGroups(text: string): string {
  let end = trimmedEnd(text, text.length);
  while (end >= 2 && text[end - 1] === ">") {
    const open = text.lastIndexOf("<", end - 2);
    if (open < 0 || text.indexOf(">", open + 1) !== end - 1) {
      break;
    }
    end = trimmedEnd(text, open);
  }
  return text.slice(0, end);
}

/**
 * Rust `impl` name (R2-B1): the type after a top-level ` for ` when the header
 * is `impl Trait for Type`, otherwise the plain type. Generics, references,
 * lifetimes, `mut`, `where` clauses and `path::` prefixes are stripped so
 * `impl<T> From<T> for app::Wrapper<T>` becomes `Wrapper`.
 */
function implTypeName(header: string): string {
  if (header.length > MAX_IMPL_HEADER_CHARS) {
    return "";
  }

  const forIndex = findTopLevelWord(header, "for");
  let text = (forIndex >= 0 ? header.slice(forIndex + "for".length) : header).trim();

  const whereIndex = findTopLevelWord(text, "where");
  if (whereIndex >= 0) {
    text = text.slice(0, whereIndex).trimEnd();
  }

  let stripped = true;
  while (stripped) {
    stripped = false;
    if (text.startsWith("&")) {
      text = text.slice(1).trimStart();
      stripped = true;
    }
    if (text.startsWith("mut ")) {
      text = text.slice("mut ".length).trimStart();
      stripped = true;
    }
    const lifetime = /^'[A-Za-z_]\w*\s*/.exec(text);
    if (lifetime !== null) {
      text = text.slice(lifetime[0].length).trimStart();
      stripped = true;
    }
  }

  text = stripTrailingAngleGroups(text);

  const segment = text.split("::").pop() ?? "";
  return trailingIdentifier(segment);
}

/** Header text between `startColumn` on `startLine` and a body opening brace. */
function headerText(
  lines: readonly string[],
  startLine: number,
  startColumn: number,
  body: BodyOpen,
): string {
  const bodyIndex = body.openLine - 1;
  const parts: string[] = [];
  for (let index = startLine; index <= bodyIndex; index += 1) {
    const text = lines[index] ?? "";
    const from = index === startLine ? startColumn : 0;
    const to = index === bodyIndex ? body.openColumn : text.length;
    parts.push(text.slice(from, to));
  }
  return parts.join(" ");
}

/** True when a `:` appears at paren depth 0 before any `{` (a Python class). */
function hasTopLevelColon(line: string, from: number): boolean {
  let paren = 0;
  for (let index = from; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === "(") {
      paren += 1;
    } else if (char === ")") {
      paren = Math.max(0, paren - 1);
    } else if (char === "{" && paren === 0) {
      return false;
    } else if (char === ":" && paren === 0) {
      return true;
    }
  }
  return false;
}

interface DetectedDeclaration {
  name: string;
  body: BodyOpen;
}

/**
 * Lines longer than this are never candidates for a declaration (R3-B2).
 * Whitespace-padded generated or hostile lines make several declaration
 * regexes backtrack quadratically; the scan still counts their braces and
 * strings, it just does not try to name them. 2,000 characters is far above
 * any real signature.
 */
export const MAX_DECLARATION_LINE_CHARS = 2_000;

function detectDeclaration(
  lines: readonly string[],
  index: number,
): DetectedDeclaration | null {
  const line = lines[index] ?? "";
  if (line.length > MAX_DECLARATION_LINE_CHARS || line.trim() === "") {
    return null;
  }

  // TS namespace/module, so a function inside qualifies as N.f (R2-N2).
  let match = /^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$]*)/.exec(
    line,
  );
  if (match !== null) {
    const name = match[1] ?? "";
    const afterName = match.index + match[0].length;
    const body = findBodyOpen(lines, index, afterName, false, false);
    return name === "" || body === null ? null : { name, body };
  }

  // TS/JS class.
  match = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(
    line,
  );
  if (match !== null) {
    const name = match[1] ?? "";
    const afterName = match.index + match[0].length;
    if (name === "" || hasTopLevelColon(line, afterName)) {
      return null;
    }
    const body = findBodyOpen(lines, index, afterName, false, false);
    return body === null ? null : { name, body };
  }

  // TS/JS function declaration, including async and generators. One
  // whitespace quantifier before the optional `*` and one after: no two can
  // match the same run (R4-N1).
  match = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*(?:\*\s*)?([A-Za-z_$][\w$]*)/.exec(
    line,
  );
  if (match !== null) {
    const name = match[1] ?? "";
    const body = findBodyOpen(lines, index, match.index + match[0].length, false, false);
    return name === "" || body === null ? null : { name, body };
  }

  // Rust impl block, so methods inside it qualify as Type.method. For
  // `impl Trait for Type` the type after `for` wins, not the trait (R2-B1).
  match = /^\s*(?:pub\s+)?impl\b/.exec(line);
  if (match !== null) {
    const afterImpl = match.index + match[0].length;
    const body = findBodyOpen(lines, index, afterImpl, false, false);
    if (body === null) {
      return null;
    }
    const name = implTypeName(headerText(lines, index, afterImpl, body));
    return name === "" ? null : { name, body };
  }

  // Go func, with an optional receiver: Server.Handle.
  match = /^\s*func\s+\(([^)]*)\)\s*([A-Za-z_]\w*)\s*\(/.exec(line);
  if (match !== null) {
    const receiver = match[1] ?? "";
    const method = match[2] ?? "";
    // `func (s *Stack[T]) Push` names the generic receiver type without its
    // type-parameter list (R2-N2).
    const receiverType = stripTrailingBracketGroup(receiver);
    const typeName = trailingIdentifier(receiverType);
    const name = typeName === "" ? method : `${typeName}.${method}`;
    const body = findBodyOpen(
      lines,
      index,
      match.index + match[0].length - 1,
      false,
      true,
    );
    return name === "" || body === null ? null : { name, body };
  }

  // Go func without a receiver, with optional `[...]` type parameters
  // (`func Map[T any](`, R3-B1). Methods cannot have type parameters.
  match = /^\s*func\s+([A-Za-z_]\w*)/.exec(line);
  if (match !== null) {
    const name = match[1] ?? "";
    let column = skipSpaces(line, match.index + match[0].length);
    column = skipBracketTypeParameterList(line, column);
    column = skipSpaces(line, column);
    if (name === "" || line[column] !== "(") {
      return null;
    }
    const body = findBodyOpen(lines, index, column, false, true);
    return body === null ? null : { name, body };
  }

  // Rust fn, with optional visibility and modifiers.
  match =
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/.exec(
      line,
    );
  if (match !== null) {
    const name = match[1] ?? "";
    const body = findBodyOpen(lines, index, match.index + match[0].length, false, false);
    return name === "" || body === null ? null : { name, body };
  }

  // const/let/var bound to an object, a function or an arrow function.
  match = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*/.exec(line);
  if (match !== null) {
    const name = match[1] ?? "";
    const assignment = findAssignment(line, match.index + match[0].length);
    if (assignment < 0) {
      return null;
    }
    const after = line.slice(assignment + 1);
    if (/^\s*\{/.test(after)) {
      const body = findBodyOpen(lines, index, assignment + 1, false, false);
      return name === "" || body === null ? null : { name, body };
    }
    if (!isCallableStart(after)) {
      return null;
    }
    const body = findBodyOpen(
      lines,
      index,
      assignment + 1,
      callableNeedsArrow(after),
      false,
    );
    return name === "" || body === null ? null : { name, body };
  }

  // Typed class field, class field arrow or object arrow property:
  // `handler: Handler = (x) => {`, `onSave: (x) => {`, `handler = async x => {`.
  match = /^\s*(?:(?:public|private|protected|static|readonly|override|abstract|declare)\s+)*([A-Za-z_$][\w$]*)\s*\??:/.exec(
    line,
  );
  if (match !== null) {
    const name = match[1] ?? "";
    const afterColon = match.index + match[0].length;
    const assignment = findAssignment(line, afterColon);
    if (assignment >= 0) {
      const after = line.slice(assignment + 1);
      if (isCallableStart(after)) {
        const body = findBodyOpen(
          lines,
          index,
          assignment + 1,
          callableNeedsArrow(after),
          false,
        );
        return name === "" || body === null ? null : { name, body };
      }
    }
    const value = line.slice(afterColon);
    if (isCallableStart(value)) {
      const body = findBodyOpen(
        lines,
        index,
        afterColon,
        callableNeedsArrow(value),
        false,
      );
      return name === "" || body === null ? null : { name, body };
    }
    return null;
  }

  // Bare class field arrow or assignment: `handler = (event) => {`.
  match =
    /^\s*(?:(?:public|private|protected|static|readonly|override|abstract|declare)\s+)*([A-Za-z_$][\w$]*)\s*=(?![=>])\s*/.exec(
      line,
    );
  if (match !== null) {
    const name = match[1] ?? "";
    const assignment = match.index + match[0].length - 1;
    const after = line.slice(assignment + 1);
    if (!isCallableStart(after)) {
      return null;
    }
    const body = findBodyOpen(
      lines,
      index,
      assignment + 1,
      callableNeedsArrow(after),
      false,
    );
    return name === "" || body === null ? null : { name, body };
  }

  // Unnamed object container: `export default {`.
  if (/^\s*export\s+default\s*\{/.test(line)) {
    const brace = line.indexOf("{");
    return {
      name: "",
      body: { openLine: index + 1, openColumn: brace },
    };
  }

  // TS/JS method, generator method or object method: `render(...) {`,
  // `*gen() {`, `async charge(...) {`, with modifiers, private names and an
  // optional generic `<...>` list before `(` (R3-B1).
  match =
    /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|declare|get|set)\s+)*(\*)?#?([A-Za-z_$][\w$]*)/.exec(
      line,
    );
  if (match !== null) {
    const name = match[2] ?? "";
    if (name === "" || CONTROL_KEYWORDS.has(name)) {
      return null;
    }
    let openColumn = skipSpaces(line, match.index + match[0].length);
    openColumn = skipTypeParameterList(line, openColumn);
    openColumn = skipSpaces(line, openColumn);
    if (line[openColumn] !== "(" || !methodBodyCanFollow(line, openColumn)) {
      return null;
    }
    const body = findBodyOpen(lines, index, openColumn, false, true);
    return body === null ? null : { name, body };
  }

  return null;
}

/**
 * Maximum dotted components in a symbol. A hostile file can nest thousands of
 * declarations; beyond this the innermost components are kept, which bounds
 * the per-declaration name work and the symbol length (R3-N3).
 */
export const MAX_SYMBOL_NAME_DEPTH = 32;

interface QualifiedName {
  qualified: string;
  depth: number;
}

/**
 * Builds a child's dotted name from the parent's cached name, without walking
 * the parent chain and without `unshift` (R3-N3).
 */
function childName(
  parent: { qualified: string; depth: number } | null,
  name: string,
): QualifiedName {
  if (parent === null) {
    return { qualified: name, depth: name === "" ? 0 : 1 };
  }
  if (name === "") {
    return { qualified: parent.qualified, depth: parent.depth };
  }

  const depth = parent.depth + 1;
  const joined = parent.qualified === "" ? name : `${parent.qualified}.${name}`;
  if (depth <= MAX_SYMBOL_NAME_DEPTH) {
    return { qualified: joined, depth };
  }

  const parts = joined.split(".");
  return {
    qualified: parts.slice(parts.length - MAX_SYMBOL_NAME_DEPTH).join("."),
    depth,
  };
}

interface CollectedDeclarations<DeclarationType> {
  declarations: DeclarationType[];
  /** Qualified symbol for each file line, indexed from 0. */
  owners: string[];
}

function collectCDeclarations(
  lines: readonly string[],
): CollectedDeclarations<Declaration> {
  const declarations: Declaration[] = [];
  const owners: string[] = new Array<string>(lines.length).fill("");
  // One entry per open brace: whether it opened a declaration, and which
  // declaration was active before it, so closing is O(1).
  const stack: Array<{
    declaration: Declaration | null;
    previous: Declaration | null;
  }> = [];
  let active: Declaration | null = null;
  let pending: DetectedDeclaration | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const detected: DetectedDeclaration | null =
      pending ?? detectDeclaration(lines, index);

    const text = lines[index] ?? "";
    let pushed = false;

    for (let column = 0; column < text.length; column += 1) {
      const char = text[column] ?? "";

      if (char === "{") {
        if (
          detected !== null &&
          !pushed &&
          lineNumber === detected.body.openLine &&
          column === detected.body.openColumn
        ) {
          const name = childName(active, detected.name);
          const declaration: Declaration = {
            name: detected.name,
            openLine: lineNumber,
            parent: active,
            qualified: name.qualified,
            depth: name.depth,
          };
          declarations.push(declaration);
          stack.push({ declaration, previous: active });
          active = declaration;
          pushed = true;
        } else {
          stack.push({ declaration: null, previous: active });
        }
      } else if (char === "}") {
        const closed = stack.pop();
        if (closed !== undefined && closed.declaration !== null) {
          closed.declaration.closeLine = lineNumber;
          active = closed.previous;
        }
      }
    }

    // A closing brace's own line is not inside the declaration it closes, so
    // record the owner after the line's braces have been processed.
    owners[index] = active?.qualified ?? "";
    pending = detected !== null && !pushed ? detected : null;
  }

  return { declarations, owners };
}

interface PythonDeclaration {
  name: string;
  indent: number;
  startLine: number;
  colonLine: number;
  endLine: number;
  parent: PythonDeclaration | null;
  /** Dotted name, built once from the parent's cached name (R3-N3). */
  qualified: string;
  /** Number of named components in `qualified`, capped by MAX_SYMBOL_NAME_DEPTH. */
  depth: number;
}

function indentWidth(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") {
      width += 1;
    } else if (char === "\t") {
      width += 4;
    } else {
      break;
    }
  }
  return width;
}

/** Line index of the `:` that opens a Python body, at paren depth 0. */
function pythonColonLine(lines: readonly string[], start: number): number {
  let paren = 0;
  for (let offset = 0; offset < 20 && start + offset < lines.length; offset += 1) {
    const text = lines[start + offset] ?? "";
    for (let column = 0; column < text.length; column += 1) {
      const char = text[column] ?? "";
      if (char === "(" || char === "[") {
        paren += 1;
      } else if (char === ")" || char === "]") {
        paren = Math.max(0, paren - 1);
      } else if (char === ":" && paren === 0) {
        return start + offset;
      }
    }
  }
  return start;
}

/**
 * Python declarations in one linear pass (R2-N3). An indent stack closes every
 * body as soon as a non-blank line dedents to its indent or shallower, so
 * there is no per-declaration forward scan. The `endLine` of the innermost
 * declaration is the only one that needs closing at that point; its parent is
 * closed by its own later sibling or the end of the file. A per-line owner
 * array makes each finding's lookup O(1) (R3-N3).
 */
function collectPythonDeclarations(
  lines: readonly string[],
): CollectedDeclarations<PythonDeclaration> {
  const declarations: PythonDeclaration[] = [];
  const owners: string[] = new Array<string>(lines.length).fill("");
  const stack: PythonDeclaration[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index] ?? "";
    const trimmed = text.trimStart();

    if (trimmed !== "" && !trimmed.startsWith("#")) {
      const indent = indentWidth(text);

      // Close every declaration the line dedents out of. `index <= colonLine`
      // keeps a multi-line signature (whose closing `)` may sit at column 0)
      // from closing its own declaration before the body starts.
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        if (top === undefined || index <= top.colonLine || indent > top.indent) {
          break;
        }
        stack.pop();
        top.endLine = index + 1;
      }

      // Long lines keep their indentation for scope, but are not declaration
      // candidates (R3-B2). Python 3.12 `[T]` type parameters are accepted
      // (R3-B1), and only one whitespace quantifier can match each run.
      if (text.length <= MAX_DECLARATION_LINE_CHARS) {
        let match = /^\s*class\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?(?:\([^)]*\)\s*)?:/.exec(
          text,
        );
        if (match === null) {
          match = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?\(/.exec(
            text,
          );
        }

        const name = match?.[1] ?? "";
        if (name !== "") {
          const parent = stack[stack.length - 1] ?? null;
          const qualified = childName(parent, name);
          const declaration: PythonDeclaration = {
            name,
            indent,
            startLine: index + 1,
            colonLine: pythonColonLine(lines, index),
            endLine: lines.length + 1,
            parent,
            qualified: qualified.qualified,
            depth: qualified.depth,
          };
          declarations.push(declaration);
          stack.push(declaration);
        }
      }
    }

    owners[index] = stack[stack.length - 1]?.qualified ?? "";
  }

  return { declarations, owners };
}

/**
 * Above these limits a hostile PR file is not lexed for symbols at all; the
 * hunk context is used instead (R2-N3). The limits are deliberately generous:
 * real files that large are rare, and the scan is per file, not per finding.
 */
export const MAX_SYMBOL_SCAN_CHARS = 400_000;
export const MAX_SYMBOL_SCAN_LINES = 20_000;

/**
 * Full-file symbol scans performed. Exported for the R2-N3 test that asserts
 * `classifyFindings` scans a (file, side) pair once, not once per finding.
 */
export const symbolScanStats = { scans: 0 };

interface SymbolTable {
  lineCount: number;
  /** Qualified symbol per line, indexed from 0 (R3-N3). */
  cOwners: string[];
  pyOwners: string[];
}

/** Lex and index one file, or null when it is over the scan limits. */
function buildSymbolTable(content: string): SymbolTable | null {
  if (content.length > MAX_SYMBOL_SCAN_CHARS) {
    return null;
  }

  const lines = content.split(/\r?\n/);
  if (lines.length > MAX_SYMBOL_SCAN_LINES) {
    return null;
  }

  symbolScanStats.scans += 1;
  const state: StripState = {
    blockComment: false,
    template: false,
    triple: null,
  };
  const cleanLines = lines.map((text) => stripStringsAndComments(text, state));

  return {
    lineCount: lines.length,
    cOwners: collectCDeclarations(cleanLines).owners,
    pyOwners: collectPythonDeclarations(cleanLines).owners,
  };
}

/** O(1) per finding: both indexes were built once, with the file (R3-N3). */
function lookupSymbol(table: SymbolTable, line: number): string {
  if (line > table.lineCount) {
    return "";
  }

  const python = table.pyOwners[line - 1] ?? "";
  return python !== "" ? python : (table.cOwners[line - 1] ?? "");
}

/**
 * Deterministic dotted symbol for a finding: `A.render`, `outer.inner` or
 * `handlers.onSave`, from the post-change content (LEFT uses the old content
 * in step 6). Scope-aware brace tracking for C-like languages and indentation
 * for Python means a declaration only wins while its body is still open, and
 * a line known to be top-level returns `""` instead of the last declaration
 * above it. The hunk context is used only when the content is unavailable,
 * known to be a partial window, or over the scan limits, never as a guess for
 * a top-level line.
 *
 * This is a line heuristic, not a full parser: strings, templates, comments,
 * regex literals and Python triple-quoted strings are stripped well enough to
 * keep braces and declaration lines out of the scope count.
 */
export function enclosingSymbol(
  content: string,
  line: number,
  hunkContext?: string,
  options: EnclosingSymbolOptions = {},
): string {
  const fullContent = options.fullContent ?? true;
  if (content === "" || !fullContent) {
    return (hunkContext ?? "").trim();
  }

  if (!Number.isInteger(line) || line <= 0) {
    return "";
  }

  const table = buildSymbolTable(content);
  if (table === null) {
    return (hunkContext ?? "").trim();
  }

  return lookupSymbol(table, line);
}

/** Cross-pass dedupe input. Step 6 fills it from Bugbot's own comments. */
export interface ExistingFinding {
  hash: string;
  file: string;
  category: Category;
  symbol: string;
  reason: string;
  state: "open" | "resolved" | "skipped";
  /** The thread's current line, null when GitHub calls the thread outdated. */
  line?: number | null;
  /** Where the thread was anchored before it became outdated. */
  originalLine?: number | null;
  /** The diff side the thread is anchored to, when known (N5). */
  side?: DiffSide | null;
}

/** A changed hunk on one side of an incremental diff. */
export interface ScopeRange {
  side: DiffSide;
  start: number;
  end: number;
}

/** Hunk ranges keyed by path, for the synchronize incremental scope. */
export type ScopeLines = ReadonlyMap<string, readonly ScopeRange[]>;

/**
 * A finding may be a duplicate when an open Bugbot comment (not an earlier
 * finding in the same pass) has the same path, category and side and its line
 * is within this many lines (step 8c).
 */
export const LOCATION_DUPLICATE_WINDOW = 3;

/**
 * A nearby line alone is not enough: two different bugs are routinely a line
 * or two apart. Within the window the reasons must also overlap at least this
 * much. The same line needs no text check, so a pure reword still dedupes.
 * Cross-pass only; in-pass duplicates need the same line (S8D-R1-N1).
 */
export const LOCATION_DUPLICATE_SIMILARITY = 0.2;

/** One finding ready to become an inline comment. */
export interface PlannedComment {
  finding: Finding;
  file: string;
  line: number;
  endLine?: number;
  side: DiffSide;
  severity: Severity;
  category: Category;
  confidence: number;
  reason: string;
  suggestedFix: string;
  triage: Triage;
  /** Deterministic enclosing symbol used in the hash. */
  symbol: string;
  hash: string;
  /** Bold title line; `formatComment` sanitizes and caps it once on output. */
  title: string;
}

export interface ClassifySummary {
  /** Inline comments kept under the cap. */
  posted: number;
  belowConfidence: number;
  lowSeverity: number;
  notInDiff: number;
  triageDismissed: number;
  duplicate: number;
  overCap: number;
  /** Findings outside the before..after hunks on an incremental pass. */
  outOfScope: number;
  /** Findings that failed schema validation (including model-layer drops). */
  schemaInvalid: number;
}

export interface ClassifiedFindings {
  post: PlannedComment[];
  summary: ClassifySummary;
}

export interface ClassifyOptions {
  changedLines: ChangedLines;
  /** Defaults to DEFAULT_MIN_CONFIDENCE. The CLI resolves the env override. */
  minConfidence?: number;
  /** Defaults to MAX_POSTED_COMMENTS. */
  maxComments?: number;
  /** Comments Bugbot already posted on this PR, in any state. */
  existing?: readonly ExistingFinding[];
  /**
   * File content for the deterministic symbol. RIGHT should be post-change,
   * LEFT pre-change. Return undefined when the content is unavailable; the
   * hunk-context fallback is then used.
   */
  contentFor?: (file: string, side: DiffSide) => string | undefined;
  /**
   * Whether `contentFor` returned the whole file (N10). False, or undefined
   * content, makes the symbol use the hunk context rather than scanning a
   * truncated window as if it started at line 1. Defaults to true.
   */
  contentIsFullFor?: (file: string, side: DiffSide) => boolean;
  /** Hunk header context text, the first fallback for the symbol. */
  hunkContextFor?: (
    file: string,
    line: number,
    side: DiffSide,
  ) => string | undefined;
  /**
   * The diff's own text for an anchor line, used to recognise bare words that
   * the code uses as identifiers when the cross-pass veto compares two reasons
   * (S8D-R1-N1). Without it only backticked tokens count.
   */
  lineTextFor?: (
    file: string,
    line: number,
    side: DiffSide,
  ) => string | undefined;
  /**
   * Findings the model layer already dropped as schema-invalid, so the
   * summary buckets add up to the model's raw finding count.
   */
  schemaInvalid?: number;
  /**
   * Incremental scope: the before..after hunks on synchronize. When set, a
   * finding whose line is outside every hunk for its file and side counts as
   * outOfScope instead of posting. Undefined keeps the full PR diff.
   */
  scope?: ScopeLines;
}

interface Candidate {
  finding: Finding;
  symbol: string;
  hash: string;
}

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  high: 2,
  medium: 1,
  low: 0,
};

function emptySummary(): ClassifySummary {
  return {
    posted: 0,
    belowConfidence: 0,
    lowSeverity: 0,
    notInDiff: 0,
    triageDismissed: 0,
    duplicate: 0,
    overCap: 0,
    outOfScope: 0,
    schemaInvalid: 0,
  };
}

function compareCandidates(a: Candidate, b: Candidate): number {
  const bySeverity = SEVERITY_RANK[b.finding.severity] - SEVERITY_RANK[a.finding.severity];
  if (bySeverity !== 0) {
    return bySeverity;
  }

  const byConfidence = b.finding.confidence - a.finding.confidence;
  if (byConfidence !== 0) {
    return byConfidence;
  }

  if (a.finding.file !== b.finding.file) {
    return a.finding.file < b.finding.file ? -1 : 1;
  }

  if (a.finding.line !== b.finding.line) {
    return a.finding.line - b.finding.line;
  }

  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

/**
 * Tie-break for equal-confidence copies of the same identity: lower line,
 * then lower end_line, then LEFT before RIGHT. Without this the posted
 * anchor would follow the model's output order (N7).
 */
function compareDuplicateCandidates(a: Candidate, b: Candidate): number {
  if (a.finding.line !== b.finding.line) {
    return a.finding.line - b.finding.line;
  }

  const aEnd = a.finding.end_line ?? Number.MAX_SAFE_INTEGER;
  const bEnd = b.finding.end_line ?? Number.MAX_SAFE_INTEGER;
  if (aEnd !== bEnd) {
    return aEnd - bEnd;
  }

  if (a.finding.side !== b.finding.side) {
    return a.finding.side === "LEFT" ? -1 : 1;
  }

  return 0;
}

/** The comment's current line, falling back to original_line when outdated. */
function existingCommentLine(item: ExistingFinding): number | null {
  if (item.line !== undefined && item.line !== null) {
    return item.line;
  }
  return item.originalLine ?? null;
}

/**
 * True when two findings on the same path, category and side are the same
 * finding by location. The same line is always the same finding (the line
 * window catches a model that reworded the reason enough to change the hash).
 * A reword often changes which identifier it names, so the identifier veto
 * does not apply on the same line (S8D-R2-N2). A nearby line only counts when
 * the reasons also overlap, so two different bugs three lines apart both post
 * (S8D-B1). When both reasons name code identifiers and share none of them,
 * the match is a sibling template rather than a reword, so it is not a
 * duplicate (S8D-R1-N1). `identifiers` is a callback so the line scans run
 * only for a nearby pair that reaches the veto (S8D-R2-N1).
 */
function isNearLocationDuplicate(
  line: number,
  reason: string,
  otherLine: number,
  otherReason: string,
  identifiers: () => {
    candidate: ReadonlySet<string>;
    other: ReadonlySet<string>;
  },
): boolean {
  const delta = Math.abs(line - otherLine);
  if (delta > LOCATION_DUPLICATE_WINDOW) {
    return false;
  }
  if (delta === 0) {
    return true;
  }
  if (reasonSimilarity(reason, otherReason) < LOCATION_DUPLICATE_SIMILARITY) {
    return false;
  }

  const named = identifiers();
  return !(
    named.candidate.size > 0 &&
    named.other.size > 0 &&
    !setsIntersect(named.candidate, named.other)
  );
}

const IDENTIFIER_TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const BACKTICKED_SPAN = /`([^`]+)`/g;

function setsIntersect(
  a: ReadonlySet<string>,
  b: ReadonlySet<string>,
): boolean {
  for (const value of a) {
    if (b.has(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Code identifiers a reason names: every token inside backticks, plus
 * identifier-like words that the diff line itself uses as code. Two sibling
 * bugs written from one template name different code (`user.profile` vs
 * `order.customer`), while a reword names the same `end`, `start`, `pageSize`
 * and `slice` (S8D-R1-N1).
 */
function namedIdentifiers(
  reason: string,
  lineText: string | undefined,
): Set<string> {
  const named = new Set<string>();
  for (const match of reason.matchAll(BACKTICKED_SPAN)) {
    for (const token of (match[1] ?? "").match(IDENTIFIER_TOKEN) ?? []) {
      named.add(token);
    }
  }

  const lineTokens = new Set(lineText?.match(IDENTIFIER_TOKEN) ?? []);
  for (const token of reason.match(IDENTIFIER_TOKEN) ?? []) {
    if (lineTokens.has(token)) {
      named.add(token);
    }
  }

  return named;
}

/**
 * Identifier sets for one classify pass, computed on demand and memoized per
 * candidate and per thread. A pair reaches the veto at most once, so this
 * bounds the full diff-line scans: nothing is scanned when the window or the
 * similarity check already rejects the pair, the candidate is scanned at most
 * once across all its threads, and each thread at most once across all
 * candidates (S8D-R2-N1).
 */
interface IdentifierMemo {
  candidate(candidate: Candidate): ReadonlySet<string>;
  thread(item: ExistingFinding, line: number, side: DiffSide): ReadonlySet<string>;
}

function identifierMemo(
  lineTextFor: ClassifyOptions["lineTextFor"],
): IdentifierMemo {
  const candidates = new WeakMap<Candidate, ReadonlySet<string>>();
  const threads = new WeakMap<ExistingFinding, ReadonlySet<string>>();

  return {
    candidate: (candidate) => {
      const known = candidates.get(candidate);
      if (known !== undefined) {
        return known;
      }
      const named = namedIdentifiers(
        candidate.finding.reason,
        lineTextFor?.(
          candidate.finding.file,
          candidate.finding.line,
          candidate.finding.side,
        ),
      );
      candidates.set(candidate, named);
      return named;
    },
    thread: (item, line, side) => {
      const known = threads.get(item);
      if (known !== undefined) {
        return known;
      }
      const named = namedIdentifiers(
        item.reason,
        lineTextFor?.(item.file, line, side),
      );
      threads.set(item, named);
      return named;
    },
  };
}

/**
 * Step 8c location dedupe: same path, category and side as an unresolved
 * Bugbot comment, at the same line or nearby with a similar reason. A comment
 * whose side is unknown is not used, so a LEFT finding can never be swallowed
 * by a RIGHT comment on the same number (N5).
 */
function isLocationDuplicate(
  candidate: Candidate,
  existing: readonly ExistingFinding[],
  identifiers: IdentifierMemo,
): boolean {
  return existing.some((item) => {
    if (item.state === "resolved") {
      return false;
    }
    if (
      item.file !== candidate.finding.file ||
      item.category !== candidate.finding.category ||
      item.side === undefined ||
      item.side === null ||
      item.side !== candidate.finding.side
    ) {
      return false;
    }
    const line = existingCommentLine(item);
    if (line === null) {
      return false;
    }
    const side = item.side;

    return isNearLocationDuplicate(
      candidate.finding.line,
      candidate.finding.reason,
      line,
      item.reason,
      () => ({
        candidate: identifiers.candidate(candidate),
        other: identifiers.thread(item, line, side),
      }),
    );
  });
}

function isExistingDuplicate(
  candidate: Candidate,
  existing: readonly ExistingFinding[],
  identifiers: IdentifierMemo,
): boolean {
  if (existing.some((item) => item.hash === candidate.hash)) {
    return true;
  }

  if (isLocationDuplicate(candidate, existing, identifiers)) {
    return true;
  }

  return existing.some(
    (item) =>
      item.file === candidate.finding.file &&
      item.category === candidate.finding.category &&
      item.symbol === candidate.symbol &&
      reasonSimilarity(item.reason, candidate.finding.reason) >=
        REASON_SIMILARITY_THRESHOLD,
  );
}

/** True when the finding's line is inside a hunk of the incremental diff. */
function scopeAllows(finding: Finding, scope: ScopeLines): boolean {
  const ranges = scope.get(finding.file);
  if (ranges === undefined) {
    return false;
  }

  return ranges.some(
    (range) =>
      range.side === finding.side &&
      finding.line >= range.start &&
      finding.line <= range.end,
  );
}

/**
 * Turns schema-valid findings into inline comments plus summary counts.
 *
 * Per finding the checks run in this order: schema, confidence/severity/diff
 * line, self-triage with the safety override, cross-pass dedupe against
 * existing comments, incremental scope, in-pass hash dedupe (the highest
 * confidence, then the lowest anchor), in-pass same-line location dedupe, then
 * the per-pass cap. Scope runs before the in-pass passes so an out-of-scope
 * neighbour cannot remove an in-scope finding (S8D-B2), while cross-pass
 * dedupe stays first so a reworded repeat is still a duplicate. Invalid items
 * count as `schemaInvalid`, so the printed buckets add up to the model's
 * findings.
 */
export function classifyFindings(
  findings: readonly unknown[],
  options: ClassifyOptions,
): ClassifiedFindings {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const maxComments = Math.max(
    0,
    Math.trunc(options.maxComments ?? MAX_POSTED_COMMENTS),
  );
  const existing = options.existing ?? [];
  const summary = emptySummary();
  summary.schemaInvalid = Math.max(0, Math.trunc(options.schemaInvalid ?? 0));
  const survivors: Candidate[] = [];

  // One table per (file, side), built on first use and reused for every
  // finding in that file, so a hostile PR cannot force one full scan per
  // finding (R2-N3). A null entry means "use the hunk context" because the
  // content is missing, truncated, or over the scan limits.
  const symbolSources = new Map<string, SymbolTable | null>();
  const symbolFor = (finding: Finding): string => {
    const key = `${finding.side}\u0000${finding.file}`;
    let table = symbolSources.get(key);
    if (table === undefined) {
      const content = options.contentFor?.(finding.file, finding.side) ?? "";
      const full = options.contentIsFullFor?.(finding.file, finding.side) ?? true;
      table = content !== "" && full ? buildSymbolTable(content) : null;
      symbolSources.set(key, table);
    }

    if (table === null) {
      return (
        options.hunkContextFor?.(finding.file, finding.line, finding.side) ?? ""
      ).trim();
    }

    return lookupSymbol(table, finding.line);
  };

  for (const raw of findings) {
    const parsed = FindingSchema.safeParse(raw);
    if (!parsed.success) {
      summary.schemaInvalid += 1;
      continue;
    }

    const finding = parsed.data;
    const failure = gateFailure(finding, minConfidence, options.changedLines);
    if (failure !== null) {
      summary[failure] += 1;
      continue;
    }

    if (!triageAllowsPost(finding)) {
      summary.triageDismissed += 1;
      continue;
    }

    const symbol = symbolFor(finding);
    survivors.push({
      finding,
      symbol,
      hash: findingHash(finding, symbol),
    });
  }

  // Cross-pass dedupe first: hash equality in any state, a reworded finding
  // with the same file, category and deterministic symbol, or step 8c location
  // equality against an unresolved thread. Counting a duplicate before the
  // scope test is what keeps the live rewrite at F:7 a duplicate rather than
  // an out-of-scope miss.
  const afterCrossPass: Candidate[] = [];
  const identifiers = identifierMemo(options.lineTextFor);
  for (const candidate of survivors) {
    if (isExistingDuplicate(candidate, existing, identifiers)) {
      summary.duplicate += 1;
      continue;
    }

    afterCrossPass.push(candidate);
  }

  // Incremental scope next, before any in-pass dedupe: an out-of-scope
  // finding must never occupy a line and remove an in-scope neighbour
  // (S8D-B2). It still counts as out of scope rather than duplicate.
  const inScope: Candidate[] = [];
  for (const candidate of afterCrossPass) {
    if (
      options.scope !== undefined &&
      !scopeAllows(candidate.finding, options.scope)
    ) {
      summary.outOfScope += 1;
      continue;
    }
    inScope.push(candidate);
  }

  // In-pass dedupe: the same identity keeps its highest-confidence copy, with
  // a deterministic anchor when confidence also ties.
  const bestByHash = new Map<string, Candidate>();
  for (const candidate of inScope) {
    const previous = bestByHash.get(candidate.hash);
    if (previous === undefined) {
      bestByHash.set(candidate.hash, candidate);
      continue;
    }

    summary.duplicate += 1;
    if (
      candidate.finding.confidence > previous.finding.confidence ||
      (candidate.finding.confidence === previous.finding.confidence &&
        compareDuplicateCandidates(candidate, previous) < 0)
    ) {
      bestByHash.set(candidate.hash, candidate);
    }
  }

  // In-pass location dedupe: a differently worded finding on the exact same
  // line, path, category and side is the same finding. The within-3-lines rule
  // deliberately does not apply here: a model that lists two findings in one
  // response meant two findings, and the live reword was cross-pass
  // (S8D-R1-N1). Candidates arrive in deterministic quality order, so the
  // first wins.
  const keptLocations = new Map<string, Set<number>>();
  const postable: Candidate[] = [];
  for (const candidate of [...bestByHash.values()].sort(compareCandidates)) {
    const key = `${candidate.finding.file}\u0000${candidate.finding.category}\u0000${candidate.finding.side}`;
    const occupied = keptLocations.get(key) ?? new Set<number>();
    if (occupied.has(candidate.finding.line)) {
      summary.duplicate += 1;
      continue;
    }

    occupied.add(candidate.finding.line);
    keptLocations.set(key, occupied);
    postable.push(candidate);
  }

  const kept = postable.slice(0, maxComments);
  summary.posted = kept.length;
  summary.overCap = postable.length - kept.length;

  return {
    summary,
    post: kept.map((candidate) => {
      const finding = candidate.finding;
      return {
        finding,
        file: finding.file,
        line: finding.line,
        ...(finding.end_line === undefined ? {} : { endLine: finding.end_line }),
        side: finding.side,
        severity: finding.severity,
        category: finding.category,
        confidence: finding.confidence,
        reason: finding.reason,
        suggestedFix: finding.suggested_fix,
        triage: finding.triage,
        symbol: candidate.symbol,
        hash: candidate.hash,
        title: commentTitle(finding.severity, finding.category, finding.reason),
      };
    }),
  };
}

/** Decodes the XML entities the prompt layer escapes. One pass only. */
function unescapeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, "\n")
    .replace(/&#13;/g, "\r")
    .replace(/&#9;/g, "\t")
    .replace(/&amp;/g, "&");
}

/**
 * Model text is untrusted. Escape marker delimiters and drop RUN_ID lines so a
 * hostile diff cannot plant a fake Bugbot marker inside a comment.
 */
function neutralizeMarkers(text: string): string {
  return text
    .split(/\r\n|\r|\n|\u2028|\u2029/)
    .filter((line) => !/^[ \t\u00a0]*RUN_ID:/i.test(line))
    .join("\n")
    .replaceAll("<!--", "&lt;!--")
    .replaceAll("-->", "--&gt;");
}

function sanitizeModelText(text: string): string {
  return neutralizeMarkers(unescapeEntities(text));
}

/** Caps by UTF-16 code unit without splitting a surrogate pair. */
function capText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }

  return `${text.slice(0, end)}…`;
}

function firstSentence(text: string): string {
  const firstLine = text.split(/\r\n|\r|\n|\u2028|\u2029/, 1)[0] ?? "";
  const match = /^(.*?[.!?])(?:\s|$)/.exec(firstLine);
  return (match?.[1] ?? firstLine).trim();
}

/**
 * Builds `**High bug: the first sentence**` from raw model text. The raw
 * title is capped as a defensive bound; `formatComment` is the single place
 * that unescapes, neutralizes markers and caps the final title (N8), so a
 * title is never sanitized twice.
 */
export function commentTitle(
  severity: Severity,
  category: Category,
  reason: string,
): string {
  const clean = reason.replace(/\s+/g, " ").trim();
  const label = `${severity[0]?.toUpperCase() ?? ""}${severity.slice(1)} ${category}: `;
  const inner = capText(
    `${label}${firstSentence(clean)}`,
    MAX_TITLE_LINE - 4,
  );

  return `**${inner}**`;
}

/**
 * The body shape bugbot-triage expects: bold title, blank line, reason, then
 * the suggested fix, then the hidden marker and RUN_ID line. Title, reason and
 * fix are unescaped and marker-neutralized exactly once; the title is capped
 * at 100 and the visible part at 4000 characters before the marker is
 * appended. `runId` and `headSha` must be the step 6 values, so a malformed
 * one is rejected instead of breaking the marker.
 */
export function formatComment(
  planned: PlannedComment,
  runId: string,
  headSha: string,
): string {
  if (!/^\d+$/.test(runId)) {
    throw new Error("formatComment: runId must be digits only");
  }
  if (!/^[0-9a-f]{7,40}$/i.test(headSha)) {
    throw new Error("formatComment: headSha must be 7-40 hex characters");
  }

  const cleanTitle = sanitizeModelText(planned.title).replace(/\s+/g, " ").trim();
  const inner =
    cleanTitle.length >= 4 &&
    cleanTitle.startsWith("**") &&
    cleanTitle.endsWith("**")
      ? cleanTitle.slice(2, -2)
      : cleanTitle;
  const title = `**${capText(inner, MAX_TITLE_LINE - 4)}**`;
  const reason = sanitizeModelText(planned.reason);
  const fix = sanitizeModelText(planned.suggestedFix);
  const parts = [title, "", reason];

  if (fix.trim() !== "") {
    parts.push("", "**Suggested fix:**", fix);
  }

  const visible = capText(parts.join("\n"), MAX_COMMENT_BODY);
  return `${visible}\n\n${marker(planned.hash, runId, headSha)}`;
}
