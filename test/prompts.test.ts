import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROMPT_FILES } from "../src/prompts.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const promptsDir = join(repoRoot, "prompts");

const HEADER =
  /^<!-- vendored from pstack (\S+) \| pstack version (\S+) \| sha256 ([0-9a-f]{64}) \| MIT \(c\) 2026 Lauren Tan \| refresh with scripts\/sync-prompts\.sh -->\n/;

// The character classes keep this detector from matching its own source in the
// repo's `git grep` secret scan. It matches the same strings.
const SECRET_PATTERN =
  /sk[-]or[-]|BEGIN (RSA|PRIVATE)|ghp[_]|github[_]pat[_]/;

/** Every .md file under prompts/, as repo-relative paths, README excluded. */
function vendoredFiles(): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        found.push(`prompts/${relative(promptsDir, absolute).split(sep).join("/")}`);
      }
    }
  };

  walk(promptsDir);
  return found.filter((path) => path !== "prompts/README.md").sort();
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("vendored prompts", () => {
  const files = vendoredFiles();

  it("matches PROMPT_FILES exactly", () => {
    expect(files).toEqual([...PROMPT_FILES].sort());
  });

  it("every vendored file starts with the pstack header", () => {
    for (const path of files) {
      const content = readFileSync(join(repoRoot, path), "utf8");
      const header = HEADER.exec(content);

      expect(header, `${path} is missing the vendored header`).not.toBeNull();
      if (header === null) {
        throw new Error(`${path} is missing the vendored header`);
      }

      expect(header[3], `${path} sha256 must be 64 lowercase hex`).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }
  });

  it("keeps the body byte-identical to the hashed source", () => {
    for (const path of files) {
      const content = readFileSync(join(repoRoot, path), "utf8");
      const header = HEADER.exec(content);

      if (header === null) {
        throw new Error(`${path} is missing the vendored header`);
      }

      const body = content.slice(header[0].length);
      expect(sha256(body), `${path} body does not match its header`).toBe(
        header[3],
      );
    }
  });

  it("lists every vendored file in the prompts/README.md table", () => {
    const readme = readFileSync(join(promptsDir, "README.md"), "utf8");
    const listed = [...readme.matchAll(/^\| `(prompts\/[^`]+)` \|/gm)].map(
      (match) => match[1],
    );

    expect(listed.sort()).toEqual([...PROMPT_FILES].sort());
  });

  it("contains no secrets", () => {
    for (const path of ["prompts/README.md", ...files]) {
      const content = readFileSync(join(repoRoot, path), "utf8");
      expect(content, path).not.toMatch(SECRET_PATTERN);
    }
  });
});
