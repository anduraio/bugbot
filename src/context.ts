import type { ChangedLines, DiffSide } from "./filter.js";
import { loadSystemPrompt, renderUserMessage } from "./prompt.js";

/**
 * Context assembly: diff parsing, changed files, AGENTS.md and the token
 * budget. The diff is authoritative: every path read from disk comes from the
 * parsed diff, and diff hunks are never truncated.
 */

export interface ReviewRequest {
  /** "owner/name". */
  repository: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  /** Unified diff for this pass: the full PR, or before..after on synchronize. */
  diff: string;
  /** Paths changed in this pass. */
  changedFiles: readonly string[];
  /** AGENTS.md from the PR head, else the default branch. */
  agentsMd: string;
  /** PR title, untrusted data shown to the model. */
  title?: string;
  /** PR body, untrusted data shown to the model. */
  body?: string;
  /** Input token budget, estimated at about 4 characters per token. */
  maxTokens?: number;
}

export interface ContextFile {
  path: string;
  content: string;
  /** True when only +/-80 lines around each hunk were kept. */
  truncatedToHunks: boolean;
}

export interface ReviewContext {
  title: string;
  body: string;
  diff: string;
  files: readonly ContextFile[];
  agentsMd: string;
  /** Estimated input tokens, including the reserved system prompt. */
  estimatedTokens: number;
  /** Files left out entirely, for the summary. */
  skipped: readonly string[];
  /** Why a skipped file's contents were left out, keyed by path. */
  skipReasons?: Readonly<Record<string, string>>;
  /** Files reduced to hunks, for the summary. */
  truncated: readonly string[];
  /**
   * True when the whole input sent to the model, including the prompt
   * wrappers, cannot fit the budget even after every reducible file was
   * reduced or dropped. The diff itself is always kept.
   */
  overBudget: boolean;
  /** Characters reserved for the system prompt in the token estimate. */
  systemPromptChars: number;
  /** Changed line numbers per file and side, for the posting filter. */
  changedLines: ChangedLines;
  /** Added plus removed lines across the parsed diff. */
  totalChangedLines: number;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface DiffHunk {
  /** The raw `@@ ... @@` header. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Hunk body, including the leading +, - or space marker. */
  lines: readonly string[];
}

export interface DiffFile {
  /** Old path, or null for an added file. */
  oldPath: string | null;
  /** New path, or null for a deleted file. */
  newPath: string | null;
  /** The path findings should use: new path, else old path. */
  path: string;
  status: FileStatus;
  binary: boolean;
  hunks: readonly DiffHunk[];
  added: number;
  removed: number;
}

export interface ParsedDiff {
  files: readonly DiffFile[];
  changedLines: ChangedLines;
  totalChangedLines: number;
}

export interface LineRange {
  start: number;
  end: number;
}

interface MutableFile {
  oldPath: string | null;
  newPath: string | null;
  headerOldPath: string | null;
  headerNewPath: string | null;
  status: FileStatus;
  renamed: boolean;
  binary: boolean;
  hunks: DiffHunk[];
  addedLines: number[];
  removedLines: number[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Decodes one git C-style quoted path. Git writes non-ASCII path bytes as
 * octal escapes (`"caf\303\251.txt"`), so octal escapes are collected as
 * bytes and decoded as UTF-8 together with the surrounding text. Values are
 * returned unchanged when git did not quote them.
 */
function unquotePath(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"')) || value.length < 2) {
    return value;
  }

  const inner = value.slice(1, -1);
  const bytes: number[] = [];
  const pushText = (text: string): void => {
    for (const byte of Buffer.from(text, "utf8")) {
      bytes.push(byte);
    }
  };

  const simpleEscapes: Readonly<Record<string, number>> = {
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    v: 0x0b,
    t: 0x09,
    n: 0x0a,
    r: 0x0d,
    '"': 0x22,
    "\\": 0x5c,
  };

  let index = 0;
  while (index < inner.length) {
    const char = inner[index] ?? "";

    if (char !== "\\") {
      const next = inner.indexOf("\\", index);
      const end = next === -1 ? inner.length : next;
      pushText(inner.slice(index, end));
      index = end;
      continue;
    }

    const octal = /^[0-7]{3}/.exec(inner.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += 4;
      continue;
    }

    const escaped = inner[index + 1];
    if (escaped === undefined) {
      bytes.push(0x5c);
      index += 1;
      continue;
    }

    const byte = simpleEscapes[escaped];
    if (byte === undefined) {
      pushText(escaped);
    } else {
      bytes.push(byte);
    }
    index += 2;
  }

  return Buffer.from(bytes).toString("utf8");
}

/** Strips the a/ or b/ prefix and maps /dev/null to null. */
function cleanPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "/dev/null") {
    return null;
  }

  const unquoted = unquotePath(trimmed);
  if (unquoted === "/dev/null") {
    return null;
  }

  if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) {
    return unquoted.slice(2);
  }

  return unquoted;
}

/**
 * Finds where `diff --git a/X b/X` splits when both sides name the same path.
 * The first ` b/` is ambiguous when X itself contains ` b/`, so every later
 * occurrence is checked too. Renames (`a/X b/Y`) have no symmetric split; the
 * caller falls back to the first separator and the rename lines are
 * authoritative.
 */
function splitSymmetricHeader(rest: string): [string, string] | null {
  let from = 0;
  while (true) {
    const separator = rest.indexOf(" b/", from);
    if (separator <= 0) {
      return null;
    }

    const oldRaw = rest.slice(0, separator);
    const newRaw = rest.slice(separator + 1);
    if (
      oldRaw.startsWith("a/") &&
      newRaw.startsWith("b/") &&
      oldRaw.slice(2) === newRaw.slice(2)
    ) {
      return [oldRaw, newRaw];
    }

    from = separator + 1;
  }
}

/** Splits the two paths in `diff --git <old> <new>`, quoted or not. */
function splitGitHeader(rest: string): [string, string] | null {
  const quoted = /^("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")$/.exec(rest.trim());
  if (quoted !== null) {
    const oldRaw = quoted[1];
    const newRaw = quoted[2];
    if (oldRaw === undefined || newRaw === undefined) {
      return null;
    }
    return [oldRaw, newRaw];
  }

  const symmetric = splitSymmetricHeader(rest);
  if (symmetric !== null) {
    return symmetric;
  }

  const separator = rest.indexOf(" b/");
  if (separator > 0) {
    return [rest.slice(0, separator).trim(), rest.slice(separator + 1).trim()];
  }

  const parts = rest.trim().split(/\s+/);
  const oldPart = parts[0];
  const newPart = parts[1];
  if (oldPart === undefined || newPart === undefined) {
    return null;
  }

  return [oldPart, newPart];
}

/**
 * Paths from `Binary files a/X and b/Y differ`. Searches every ` and ` so a
 * path containing the word " and " still splits into a matching a/ and b/
 * pair (or /dev/null for additions and deletions).
 */
function splitBinaryPaths(line: string): [string, string] | null {
  const body = line.slice("Binary files ".length, line.lastIndexOf(" differ"));
  let separator = body.indexOf(" and ");
  let fallback: [string, string] | null = null;

  while (separator > 0) {
    const oldRaw = body.slice(0, separator);
    const newRaw = body.slice(separator + " and ".length);
    if (
      (oldRaw.startsWith("a/") || oldRaw === "/dev/null") &&
      (newRaw.startsWith("b/") || newRaw === "/dev/null")
    ) {
      const pair: [string, string] = [oldRaw, newRaw];
      const oldPath = cleanPath(oldRaw);
      if (oldPath !== null && oldPath === cleanPath(newRaw)) {
        return pair;
      }
      fallback ??= pair;
    }

    separator = body.indexOf(" and ", separator + 1);
  }

  return fallback;
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} | null {
  const match = HUNK_HEADER.exec(line);
  if (match === null) {
    return null;
  }

  const oldStart = Number.parseInt(match[1] ?? "", 10);
  const newStart = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isInteger(oldStart) || !Number.isInteger(newStart)) {
    return null;
  }

  const oldLines = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
  const newLines = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);

  return {
    oldStart,
    oldLines: Number.isInteger(oldLines) ? oldLines : 0,
    newStart,
    newLines: Number.isInteger(newLines) ? newLines : 0,
  };
}

/**
 * Parses a unified git diff. Handles added, deleted, renamed and binary files,
 * multiple hunks and the `\ No newline at end of file` marker. Hunk bodies are
 * consumed using the counts in their headers, so content that happens to look
 * like a file header cannot end a hunk early.
 */
export function parseDiff(diff: string): ParsedDiff {
  const lines = diff.split(/\r?\n/);
  const files: MutableFile[] = [];
  let current: MutableFile | null = null;

  const startFile = (oldRaw: string, newRaw: string): MutableFile => {
    const headerOldPath = cleanPath(oldRaw);
    const headerNewPath = cleanPath(newRaw);
    const file: MutableFile = {
      oldPath: headerOldPath,
      newPath: headerNewPath,
      headerOldPath,
      headerNewPath,
      status: "modified",
      renamed: false,
      binary: false,
      hunks: [],
      addedLines: [],
      removedLines: [],
    };
    files.push(file);
    return file;
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.startsWith("diff --git ")) {
      const paths = splitGitHeader(line.slice("diff --git ".length));
      current =
        paths === null ? startFile("", "") : startFile(paths[0], paths[1]);
      index += 1;
      continue;
    }

    if (current === null) {
      index += 1;
      continue;
    }

    if (line.startsWith("new file mode")) {
      current.status = "added";
      current.oldPath = null;
      index += 1;
      continue;
    }

    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      current.newPath = null;
      index += 1;
      continue;
    }

    if (line.startsWith("rename from ")) {
      current.oldPath = cleanPath(line.slice("rename from ".length));
      current.renamed = true;
      index += 1;
      continue;
    }

    if (line.startsWith("rename to ")) {
      current.newPath = cleanPath(line.slice("rename to ".length));
      current.renamed = true;
      index += 1;
      continue;
    }

    if (line.startsWith("--- ")) {
      current.oldPath = cleanPath(line.slice(4));
      index += 1;
      continue;
    }

    if (line.startsWith("+++ ")) {
      current.newPath = cleanPath(line.slice(4));
      index += 1;
      continue;
    }

    if (line.startsWith("Binary files ")) {
      current.binary = true;
      const paths = splitBinaryPaths(line);
      // Renames already took their paths from `rename from`/`rename to`.
      if (paths !== null && !current.renamed) {
        current.oldPath = cleanPath(paths[0]);
        current.newPath = cleanPath(paths[1]);
        current.headerOldPath = current.oldPath;
        current.headerNewPath = current.newPath;
      }
      index += 1;
      continue;
    }

    if (line === "GIT binary patch") {
      current.binary = true;
      index += 1;
      continue;
    }

    const header = parseHunkHeader(line);
    if (header === null) {
      index += 1;
      continue;
    }

    let oldCursor = header.oldStart;
    let newCursor = header.newStart;
    let oldLeft = header.oldLines;
    let newLeft = header.newLines;
    const body: string[] = [];

    let cursor = index + 1;
    while (cursor < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const bodyLine = lines[cursor] ?? "";

      if (bodyLine.startsWith("\\")) {
        body.push(bodyLine);
        cursor += 1;
        continue;
      }

      if (bodyLine.startsWith("+")) {
        current.addedLines.push(newCursor);
        newCursor += 1;
        newLeft -= 1;
        body.push(bodyLine);
        cursor += 1;
        continue;
      }

      if (bodyLine.startsWith("-")) {
        current.removedLines.push(oldCursor);
        oldCursor += 1;
        oldLeft -= 1;
        body.push(bodyLine);
        cursor += 1;
        continue;
      }

      if (bodyLine.startsWith(" ")) {
        oldCursor += 1;
        newCursor += 1;
        oldLeft -= 1;
        newLeft -= 1;
        body.push(bodyLine);
        cursor += 1;
        continue;
      }

      break;
    }

    current.hunks.push({
      header: line,
      oldStart: header.oldStart,
      oldLines: header.oldLines,
      newStart: header.newStart,
      newLines: header.newLines,
      lines: body,
    });

    index = cursor;
  }

  const parsedFiles: DiffFile[] = [];
  const mutableLines = new Map<string, Map<DiffSide, Set<number>>>();
  let totalChangedLines = 0;

  for (const file of files) {
    const path =
      file.newPath ?? file.oldPath ?? file.headerNewPath ?? file.headerOldPath;
    if (path === null) {
      continue;
    }

    let status = file.status;
    if (file.renamed) {
      status = "renamed";
    } else if (file.newPath === null) {
      status = "deleted";
    } else if (file.oldPath === null) {
      status = "added";
    }

    parsedFiles.push({
      oldPath: file.oldPath,
      newPath: file.newPath,
      path,
      status,
      binary: file.binary,
      hunks: file.hunks,
      added: file.addedLines.length,
      removed: file.removedLines.length,
    });

    const sides = new Map<DiffSide, Set<number>>();
    sides.set("RIGHT", new Set(file.addedLines));
    sides.set("LEFT", new Set(file.removedLines));
    mutableLines.set(path, sides);
    totalChangedLines += file.addedLines.length + file.removedLines.length;
  }

  return {
    files: parsedFiles,
    changedLines: mutableLines,
    totalChangedLines,
  };
}

/**
 * Changed line numbers per file and side. RIGHT is the added lines on the new
 * side and LEFT the removed lines on the old side, ready for `shouldPost`.
 */
export function changedLinesFromDiff(diff: string): ChangedLines {
  return parseDiff(diff).changedLines;
}

/** New-side line ranges covered by hunks, keyed by the file's post-change path. */
export function hunkRangesByPath(diff: string): Map<string, LineRange[]> {
  const ranges = new Map<string, LineRange[]>();
  for (const file of parseDiff(diff).files) {
    const list: LineRange[] = [];
    for (const hunk of file.hunks) {
      if (hunk.newLines > 0) {
        list.push({
          start: hunk.newStart,
          end: hunk.newStart + hunk.newLines - 1,
        });
      } else if (hunk.newStart > 0) {
        // A deletion-only hunk has no new-side lines. Keep +/-80 around the
        // position where the removed block used to be.
        list.push({ start: hunk.newStart, end: hunk.newStart });
      }
    }
    ranges.set(file.path, list);
  }
  return ranges;
}

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "tif",
  "tiff",
  "avif",
  "heic",
  "svg",
  "pdf",
]);

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path).toLowerCase());
}

function isMinified(path: string): boolean {
  return /\.min\.[^/]+$/i.test(path);
}

function isGeneratedPath(path: string): boolean {
  // Only top-level output directories count; `src/build/foo.ts` is source.
  if (
    path.startsWith("dist/") ||
    path.startsWith("build/") ||
    path.startsWith(".next/")
  ) {
    return true;
  }

  const name = basename(path);
  return /\.generated\./i.test(name) || name.endsWith(".snap");
}

function isImage(path: string): boolean {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function isMigration(path: string): boolean {
  return path.startsWith("supabase/migrations/");
}

function countLines(content: string): number {
  const withoutTrailingNewline = content.endsWith("\n")
    ? content.slice(0, -1)
    : content;
  return withoutTrailingNewline === "" ? 0 : withoutTrailingNewline.split("\n").length;
}

function hasGeneratedMarker(content: string): boolean {
  return content
    .split("\n", 5)
    .some((line) => line.includes("@generated"));
}

export type ReadFile = (path: string) => Promise<string | null>;

export interface BuildContextOptions {
  /**
   * System prompt size, reserved from the input budget. When omitted,
   * `buildContext` measures the vendored prompt itself so a caller cannot
   * silently undercount it.
   */
  systemPromptChars?: number;
  /** Pick the comment-sicko system prompt when measuring it here. */
  commentSicko?: boolean;
}

/**
 * Estimated input tokens for exactly what will be sent: the system prompt
 * characters plus the assembled user message (wrappers, tags, notes and the
 * skipped/truncated lists included). Assembling here keeps the budget honest
 * when the prompt layer changes.
 */
function estimateTokens(
  context: ReviewContext,
  files: readonly ContextFile[],
  skipped: readonly string[],
  truncated: readonly string[],
  skipReasons: Readonly<Record<string, string>>,
): number {
  const candidate: ReviewContext = {
    ...context,
    files,
    skipped,
    truncated,
    skipReasons,
  };
  const userChars = renderUserMessage(candidate).length;
  return Math.ceil((context.systemPromptChars + userChars) / 4);
}

/** Keeps +/-80 lines around each hunk, with a marker for every omitted gap. */
function reduceToHunks(
  content: string,
  ranges: readonly LineRange[],
): { content: string; truncated: boolean } {
  if (ranges.length === 0) {
    return { content, truncated: false };
  }

  const lines = content.split("\n");
  const totalLines = content.endsWith("\n") ? lines.length - 1 : lines.length;
  const keep = new Set<number>();

  for (const range of ranges) {
    const start = Math.max(1, range.start - 80);
    const end = Math.min(totalLines, range.end + 80);
    for (let line = start; line <= end; line += 1) {
      keep.add(line);
    }
  }

  if (keep.size >= totalLines) {
    return { content, truncated: false };
  }

  const sorted = [...keep].sort((a, b) => a - b);
  const first = sorted[0];
  if (first === undefined) {
    return { content: "", truncated: true };
  }

  const output: string[] = [];
  let runStart = first;
  let runEnd = first;
  let previousEnd = 0;

  const flush = (): void => {
    if (runStart > previousEnd + 1) {
      output.push(`... lines ${previousEnd + 1}-${runStart - 1} omitted ...`);
    }
    output.push(...lines.slice(runStart - 1, runEnd));
    previousEnd = runEnd;
  };

  for (let index = 1; index < sorted.length; index += 1) {
    const line = sorted[index];
    if (line === undefined) {
      continue;
    }

    if (line === runEnd + 1) {
      runEnd = line;
    } else {
      flush();
      runStart = line;
      runEnd = line;
    }
  }
  flush();

  if (runEnd < totalLines) {
    output.push(`... lines ${runEnd + 1}-${totalLines} omitted ...`);
  }

  return { content: output.join("\n"), truncated: true };
}

/**
 * Applies the input budget. Diff hunks are always kept. Full files are first
 * reduced to +/-80 lines around their hunks, largest first, re-checking after
 * each one. If that is still over, files are dropped largest first — including
 * a file whose +/-80 windows already cover its whole content, which phase 1
 * cannot reduce. A diff that cannot fit on its own sets `overBudget` instead
 * of throwing.
 */
export function applyTokenBudget(
  context: ReviewContext,
  maxTokens: number,
): ReviewContext {
  const budget = Number.isFinite(maxTokens) ? Math.max(0, maxTokens) : 0;
  let files = [...context.files];
  let skipped = [...context.skipped];
  let truncated = [...context.truncated];
  let skipReasons: Record<string, string> = { ...context.skipReasons };

  if (estimateTokens(context, files, skipped, truncated, skipReasons) <= budget) {
    return {
      ...context,
      files,
      skipped,
      truncated,
      skipReasons,
      estimatedTokens: estimateTokens(context, files, skipped, truncated, skipReasons),
      overBudget: false,
    };
  }

  const ranges = hunkRangesByPath(context.diff);

  // Phase 1: reduce the largest full file first, then re-check.
  const bySize = [...files].sort((a, b) => b.content.length - a.content.length);
  for (const file of bySize) {
    if (estimateTokens(context, files, skipped, truncated, skipReasons) <= budget) {
      break;
    }
    if (file.truncatedToHunks) {
      continue;
    }

    const reduced = reduceToHunks(file.content, ranges.get(file.path) ?? []);
    if (!reduced.truncated) {
      continue;
    }

    files = files.map((candidate) =>
      candidate.path === file.path
        ? {
            path: candidate.path,
            content: reduced.content,
            truncatedToHunks: true,
          }
        : candidate,
    );

    if (!truncated.includes(file.path)) {
      truncated.push(file.path);
    }
  }

  // Phase 2: drop any remaining file entirely, largest first. Phase 1 leaves a
  // file with `truncatedToHunks: false` when its +/-80 windows already cover
  // the whole content, so filtering on `truncatedToHunks` here would strand
  // it forever.
  while (estimateTokens(context, files, skipped, truncated, skipReasons) > budget) {
    const drop = [...files].sort(
      (a, b) => b.content.length - a.content.length,
    )[0];
    if (drop === undefined) {
      break;
    }

    files = files.filter((file) => file.path !== drop.path);
    truncated = truncated.filter((path) => path !== drop.path);
    if (!skipped.includes(drop.path)) {
      skipped.push(drop.path);
    }
    skipReasons = {
      ...skipReasons,
      [drop.path]: "dropped to fit the token budget, contents omitted",
    };
  }

  const estimatedTokens = estimateTokens(context, files, skipped, truncated, skipReasons);

  return {
    ...context,
    files,
    skipped,
    truncated,
    skipReasons,
    estimatedTokens,
    overBudget: estimatedTokens > budget,
  };
}

/** True when the file has any range on the post-change side to anchor on. */
function hasNewSideRange(file: DiffFile): boolean {
  return file.hunks.some((hunk) => hunk.newLines > 0 || hunk.newStart > 0);
}

/**
 * Reads the post-change contents of every changed file that is worth sending,
 * then applies the budget. The reader is injected so tests need no git or
 * filesystem access.
 */
export async function buildContext(
  request: ReviewRequest,
  readFile: ReadFile,
  options: BuildContextOptions = {},
): Promise<ReviewContext> {
  const parsed = parseDiff(request.diff);
  const skipped: string[] = [];
  const skipReasons: Record<string, string> = {};
  const files: ContextFile[] = [];

  for (const file of parsed.files) {
    const path = file.path;

    if (file.status === "deleted") {
      skipped.push(path);
      continue;
    }

    if (
      file.binary ||
      isImage(path) ||
      isLockfile(path) ||
      isMinified(path) ||
      isGeneratedPath(path)
    ) {
      skipped.push(path);
      continue;
    }

    if (!hasNewSideRange(file)) {
      // Pure renames, mode-only changes and `+0,0` hunks have no new-side
      // range. Their full contents can never be reduced around a hunk, so
      // send the diff only.
      skipped.push(path);
      skipReasons[path] = "no new-side lines in the diff, contents omitted";
      continue;
    }

    let content: string | null;
    try {
      content = await readFile(path);
    } catch {
      content = null;
    }

    if (content === null || content.includes("\u0000")) {
      skipped.push(path);
      continue;
    }

    if (hasGeneratedMarker(content)) {
      skipped.push(path);
      continue;
    }

    if (isMigration(path) && countLines(content) > 500) {
      skipped.push(path);
      continue;
    }

    files.push({ path, content, truncatedToHunks: false });
  }

  const systemPromptChars =
    options.systemPromptChars ??
    (await loadSystemPrompt({ commentSicko: options.commentSicko })).length;

  const context: ReviewContext = {
    title: request.title ?? "",
    body: request.body ?? "",
    diff: request.diff,
    files,
    agentsMd: request.agentsMd,
    estimatedTokens: 0,
    skipped,
    skipReasons,
    truncated: [],
    overBudget: false,
    systemPromptChars,
    changedLines: parsed.changedLines,
    totalChangedLines: parsed.totalChangedLines,
  };

  context.estimatedTokens = estimateTokens(context, files, skipped, [], skipReasons);

  return applyTokenBudget(context, request.maxTokens ?? 120_000);
}

export interface SelectModelInput {
  /** Normal model id. */
  model: string;
  /** Model for big PRs. Empty or undefined means no fallback. */
  bigPrModel?: string;
  /** Added plus removed lines in this pass. */
  changedLines: number;
  overBudget: boolean;
}

export type ModelChoice = { model: string } | { skip: string };

/**
 * Big PRs (over 1,500 changed lines) and over-budget contexts use
 * `big_pr_model`. Without one the review is skipped rather than sent
 * truncated past the budget.
 */
export function selectModel({
  model,
  bigPrModel,
  changedLines,
  overBudget,
}: SelectModelInput): ModelChoice {
  const fallback =
    bigPrModel !== undefined && bigPrModel.trim() !== "" ? bigPrModel : null;

  if (overBudget) {
    return fallback === null
      ? { skip: "budget overflow, no big_pr_model set" }
      : { model: fallback };
  }

  if (changedLines > 1_500) {
    return fallback === null
      ? { skip: "big PR over 1500 changed lines, no big_pr_model set" }
      : { model: fallback };
  }

  return { model };
}
