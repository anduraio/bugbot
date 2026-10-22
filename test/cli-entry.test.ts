import {
  execFileSync,
  spawnSync,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The CLI must run when it is reached through a symlink (`npm link`,
 * `npm i -g`, `npx`). dist/cli.js is built from src/ first so the test always
 * exercises the current source, then run through a three-link chain.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const distCli = join(repoRoot, "dist", "cli.js");

let workDir: string | undefined;
let link1: string;
let link2: string;
let link3: string;

beforeAll(() => {
  execFileSync(
    process.execPath,
    [join(repoRoot, "node_modules", "typescript", "bin", "tsc")],
    { cwd: repoRoot, stdio: "pipe" },
  );
  chmodSync(distCli, 0o755);

  workDir = mkdtempSync(join(tmpdir(), "bb-cli-entry-"));
  link1 = join(workDir, "bugbot");
  link2 = join(workDir, "bugbot-2");
  link3 = join(workDir, "bugbot-3");
  symlinkSync(distCli, link1);
  symlinkSync(link1, link2);
  symlinkSync(link2, link3);
});

afterAll(() => {
  if (workDir !== undefined) {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function run(file: string, args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(file, [...args], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: workDir ?? tmpdir(),
      TMPDIR: tmpdir(),
    },
    timeout: 30_000,
  });
}

describe("CLI entry point detection", () => {
  it("runs --help through a symlink chain", () => {
    const result = run(link3, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage: bugbot");
    expect(result.stderr).toBe("");
  });

  it("rejects bad usage through a symlink chain", () => {
    const result = run(link3, ["status", "1", "--repo", "-x/y"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--repo needs <owner>/<repo>");
  });

  it("rejects an unknown command through a symlink chain", () => {
    const result = run(link3, ["definitely-not-a-command"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: bugbot review");
  });

  it("does not run main when the module is imported", () => {
    const importer = join(workDir ?? tmpdir(), "import-cli.mjs");
    writeFileSync(
      importer,
      `import { main } from ${JSON.stringify(pathToFileURL(distCli).href)};\n` +
        `console.log("imported " + typeof main);\n`,
    );

    const result = run(process.execPath, [importer]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("imported function\n");
  });

  it("refuses to exit 0 when a bin-named entry is not detected", () => {
    // A wrapper named like the bin that imports the CLI cannot be detected as
    // the entry point; the guard must turn the silent no-op into a failure.
    const wrapperDir = join(workDir ?? tmpdir(), "wrapper");
    mkdirSync(wrapperDir);
    writeFileSync(join(wrapperDir, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(wrapperDir, "cli.js"),
      `import ${JSON.stringify(pathToFileURL(distCli).href)};\n` +
        `console.log("imported");\n`,
    );

    const result = run(process.execPath, [join(wrapperDir, "cli.js")]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("entry point was not detected");
  });
});
