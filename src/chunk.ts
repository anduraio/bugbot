/**
 * Splits a big pull request diff into parts that are each reviewed in their
 * own model request. Files stay whole when they fit, in diff order so files
 * in the same directory tend to share a part. A single file that is too big
 * on its own is split at hunk boundaries, repeating its header in every part.
 * A hunk is never split.
 */

/** About four characters per token, the same estimate as context.ts. */
function tokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface DiffSection {
  /** The path as written in the `diff --git` header, for display only. */
  label: string;
  /** Header lines before the first hunk, newline-joined with a trailing newline. */
  header: string;
  /** Each hunk's raw text, from its `@@` line, with a trailing newline. */
  hunks: readonly string[];
  /** Added plus removed lines in this section. */
  changedLines: number;
}

export interface DiffChunk {
  /** Raw unified diff for this part. */
  diff: string;
  /** Section labels in this part, in diff order. */
  labels: readonly string[];
  changedLines: number;
}

export interface ChunkLimits {
  /** Estimated diff tokens per part. */
  maxTokens: number;
  /** Added plus removed lines per part. */
  maxChangedLines: number;
}

function changedIn(lines: readonly string[]): number {
  let count = 0;
  for (const line of lines) {
    if (
      (line.startsWith("+") && !line.startsWith("+++ ")) ||
      (line.startsWith("-") && !line.startsWith("--- "))
    ) {
      count += 1;
    }
  }
  return count;
}

function labelOf(gitLine: string): string {
  const match = /^diff --git a\/(.*) b\/(.*)$/.exec(gitLine);
  return match?.[2] ?? gitLine.slice("diff --git ".length);
}

/**
 * Splits a diff on `diff --git` lines. Anything before the first header is
 * dropped. A diff with no `diff --git` header comes back as one section with
 * no hunks split out, so it is never cut.
 */
export function splitDiff(diff: string): DiffSection[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) {
      starts.push(index);
    }
  });

  if (starts.length === 0) {
    return diff.trim() === ""
      ? []
      : [
          {
            label: "(diff)",
            header: diff.endsWith("\n") ? diff : `${diff}\n`,
            hunks: [],
            changedLines: changedIn(lines),
          },
        ];
  }

  const sections: DiffSection[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] ?? 0;
    const end = starts[index + 1] ?? lines.length;
    const body = lines.slice(start, end);
    const firstHunk = body.findIndex((line) => line.startsWith("@@ "));
    const headerLines = firstHunk === -1 ? body : body.slice(0, firstHunk);
    const hunks: string[] = [];

    if (firstHunk !== -1) {
      let current: string[] = [];
      for (const line of body.slice(firstHunk)) {
        if (line.startsWith("@@ ") && current.length > 0) {
          hunks.push(`${current.join("\n")}\n`);
          current = [];
        }
        current.push(line);
      }
      if (current.length > 0) {
        hunks.push(`${current.join("\n")}\n`);
      }
    }

    sections.push({
      label: labelOf(body[0] ?? ""),
      header: `${headerLines.join("\n")}\n`,
      hunks,
      changedLines: changedIn(firstHunk === -1 ? [] : body.slice(firstHunk)),
    });
  }

  return sections;
}

function sectionText(section: DiffSection): string {
  return section.header + section.hunks.join("");
}

/**
 * Cuts one oversized section into pieces at hunk boundaries. Every piece
 * keeps the full header so it still parses as that file's diff.
 */
function splitSection(section: DiffSection, limits: ChunkLimits): DiffSection[] {
  if (section.hunks.length <= 1) {
    return [section];
  }

  const pieces: DiffSection[] = [];
  let hunks: string[] = [];
  let tokens = tokensOf(section.header);
  let changed = 0;

  for (const hunk of section.hunks) {
    const hunkTokens = tokensOf(hunk);
    const hunkChanged = changedIn(hunk.split("\n"));
    if (
      hunks.length > 0 &&
      (tokens + hunkTokens > limits.maxTokens ||
        changed + hunkChanged > limits.maxChangedLines)
    ) {
      pieces.push({ ...section, hunks, changedLines: changed });
      hunks = [];
      tokens = tokensOf(section.header);
      changed = 0;
    }
    hunks.push(hunk);
    tokens += hunkTokens;
    changed += hunkChanged;
  }
  pieces.push({ ...section, hunks, changedLines: changed });

  return pieces;
}

/**
 * Groups sections into parts under both limits. A diff that already fits
 * comes back as exactly one part holding the original text, so a small pull
 * request is sent byte for byte as before.
 */
export function planChunks(diff: string, limits: ChunkLimits): DiffChunk[] {
  const sections = splitDiff(diff);
  const total = sections.reduce((sum, section) => sum + section.changedLines, 0);

  if (
    sections.length <= 1 &&
    (sections[0]?.hunks.length ?? 0) <= 1
  ) {
    return diff.trim() === ""
      ? []
      : [{ diff, labels: sections.map((s) => s.label), changedLines: total }];
  }

  if (tokensOf(diff) <= limits.maxTokens && total <= limits.maxChangedLines) {
    return [{ diff, labels: sections.map((s) => s.label), changedLines: total }];
  }

  const pieces = sections.flatMap((section) =>
    tokensOf(sectionText(section)) > limits.maxTokens ||
    section.changedLines > limits.maxChangedLines
      ? splitSection(section, limits)
      : [section],
  );

  const chunks: DiffChunk[] = [];
  let text = "";
  let labels: string[] = [];
  let changed = 0;

  const flush = (): void => {
    if (text !== "") {
      chunks.push({ diff: text, labels, changedLines: changed });
    }
    text = "";
    labels = [];
    changed = 0;
  };

  for (const piece of pieces) {
    const pieceText = sectionText(piece);
    if (
      text !== "" &&
      (tokensOf(text) + tokensOf(pieceText) > limits.maxTokens ||
        changed + piece.changedLines > limits.maxChangedLines)
    ) {
      flush();
    }
    text += pieceText;
    if (!labels.includes(piece.label)) {
      labels.push(piece.label);
    }
    changed += piece.changedLines;
  }
  flush();

  return chunks;
}
