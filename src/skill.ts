import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `bugbot install-skill --harness <name>` copies the vendored /bugbot skill
 * into one harness's skills folder under $HOME. It never writes under
 * ~/.pstack, never writes through a symlink, and never deletes anything.
 */

export const HARNESS_PATHS = {
  claude: [".claude", "skills", "bugbot"],
  "claude-personal": [".claude-personal", "skills", "bugbot"],
  grok: [".grok", "skills", "bugbot"],
  opencode: [".config", "opencode", "skills", "bugbot"],
  agents: [".agents", "skills", "bugbot"],
} as const;

export type Harness = keyof typeof HARNESS_PATHS;

export const INSTALL_HELP = `usage: bugbot install-skill --harness <name> [--force] [--dry-run]

Copies the /bugbot skill into the harness skills folder under $HOME:
  claude           ~/.claude/skills/bugbot/SKILL.md
  claude-personal  ~/.claude-personal/skills/bugbot/SKILL.md
  grok             ~/.grok/skills/bugbot/SKILL.md
  opencode         ~/.config/opencode/skills/bugbot/SKILL.md
  agents           ~/.agents/skills/bugbot/SKILL.md

An identical file is a no-op. A different file is only overwritten with
--force. --dry-run prints the destination and writes nothing.
Bugbot never writes under ~/.pstack, and refuses when any part of the
destination path is a symlink or resolves outside $HOME.

Exit codes: 0 installed (or already identical), 1 usage or file error.`;

export interface InstallSkillDeps {
  readonly home?: string;
  readonly sourcePath?: string;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The vendored skill, resolved relative to this package (works from dist/). */
export function skillSourcePath(): string {
  return fileURLToPath(new URL("../skill/bugbot/SKILL.md", import.meta.url));
}

interface InstallOptions {
  readonly harness: Harness;
  readonly force: boolean;
  readonly dryRun: boolean;
}

function isHarness(value: string): value is Harness {
  return Object.prototype.hasOwnProperty.call(HARNESS_PATHS, value);
}

function parseInstallArgs(args: readonly string[]): InstallOptions {
  let harness: string | null = null;
  let force = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--harness") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--harness needs one of: " + Object.keys(HARNESS_PATHS).join(", "));
      }
      harness = value;
      i += 1;
    } else if (arg === "--force") {
      force = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    }
  }

  if (harness === null) {
    throw new Error(
      "--harness is required (one of: " + Object.keys(HARNESS_PATHS).join(", ") + ")",
    );
  }
  if (!isHarness(harness)) {
    throw new Error(
      `unknown harness ${JSON.stringify(harness)}: expected one of ` +
        Object.keys(HARNESS_PATHS).join(", "),
    );
  }

  return { harness, force, dryRun };
}

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return (
    fromParent === "" ||
    (!fromParent.startsWith("..") && !fromParent.startsWith(sep))
  );
}

/**
 * Refuses symlinks anywhere in the destination path and any destination that
 * resolves outside $HOME or under ~/.pstack. A textual check cannot see a
 * symlinked skills folder (B4), so walk the real filesystem instead. The
 * nearest existing ancestor is resolved too: if a link appears after this
 * check, the atomic rename below still replaces the link rather than writing
 * through it.
 */
async function destinationProblem(
  home: string,
  destination: string,
): Promise<string | null> {
  let homeReal: string;
  try {
    homeReal = await realpath(home);
  } catch {
    return `HOME ${JSON.stringify(home)} does not exist`;
  }

  const parts = relative(resolve(home), destination).split(sep);
  let current = resolve(home);
  let nearest = current;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // The rest of the path does not exist yet; mkdir creates it.
        break;
      }
      return `could not inspect ${current}: ${errorMessage(error)}`;
    }
    if (info.isSymbolicLink()) {
      return `${current} is a symlink`;
    }
    nearest = current;
  }

  let nearestReal: string;
  try {
    nearestReal = await realpath(nearest);
  } catch (error) {
    return `could not resolve ${nearest}: ${errorMessage(error)}`;
  }
  if (!isInside(homeReal, nearestReal)) {
    return `${nearest} resolves outside HOME (${nearestReal})`;
  }
  if (isInside(join(homeReal, ".pstack"), nearestReal)) {
    return `${nearest} resolves inside ~/.pstack`;
  }
  return null;
}

export async function runInstallSkill(
  args: readonly string[],
  deps: InstallSkillDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const fail = deps.error ?? ((line: string) => console.error(line));

  let options: InstallOptions;
  try {
    options = parseInstallArgs(args);
  } catch (error) {
    fail(`Bugbot: ${errorMessage(error)}`);
    return 1;
  }

  const home = deps.home ?? process.env["HOME"] ?? "";
  if (home === "") {
    fail("Bugbot: HOME is not set, so there is nowhere to install the skill");
    return 1;
  }

  const relativeDir = HARNESS_PATHS[options.harness].join(sep);
  const destinationDir = resolve(home, relativeDir);
  const destination = join(destinationDir, "SKILL.md");

  // Defence in depth: the harness map above already excludes .pstack.
  const fromHome = relative(resolve(home), destination);
  if (
    fromHome.startsWith("..") ||
    fromHome.split(sep).includes(".pstack")
  ) {
    fail("Bugbot: refuses to install a skill under ~/.pstack");
    return 1;
  }

  const problem = await destinationProblem(resolve(home), destination);
  if (problem !== null) {
    fail(
      `Bugbot: refuses to install the skill at ${destination}: ${problem}. ` +
        "Nothing was written.",
    );
    return 1;
  }

  const source = deps.sourcePath ?? skillSourcePath();
  let content: string;
  try {
    content = await readFile(source, "utf8");
  } catch (error) {
    fail(`Bugbot: could not read the bundled skill: ${errorMessage(error)}`);
    return 1;
  }

  if (options.dryRun) {
    log(`Bugbot: would install the skill at ${destination} (dry run).`);
    return 0;
  }

  let existing: string | null = null;
  try {
    existing = await readFile(destination, "utf8");
  } catch {
    // Missing file is the normal first-install case.
  }

  if (existing !== null) {
    if (existing === content) {
      log(`Bugbot: skill is already installed at ${destination}`);
      return 0;
    }
    if (!options.force) {
      fail(
        `Bugbot: ${destination} already exists with different content; ` +
          "re-run with --force to overwrite",
      );
      return 1;
    }
  }

  try {
    await mkdir(destinationDir, { recursive: true });
    const raced = await destinationProblem(resolve(home), destination);
    if (raced !== null) {
      fail(
        `Bugbot: refuses to install the skill at ${destination}: ${raced}. ` +
          "Nothing was written.",
      );
      return 1;
    }
    // Write a sibling temp file and rename so a symlink planted after the
    // check above is replaced, never followed (B4).
    const temporary = join(
      destinationDir,
      `.SKILL.md.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`,
    );
    try {
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  } catch (error) {
    fail(`Bugbot: could not install the skill at ${destination}: ${errorMessage(error)}`);
    return 1;
  }

  log(`Bugbot: skill installed at ${destination}`);
  return 0;
}

/** Exposed for tests: the exact destination for a harness and HOME. */
export function skillDestination(home: string, harness: Harness): string {
  return join(resolve(home), HARNESS_PATHS[harness].join(sep), "SKILL.md");
}

/** Exposed for tests: the parent directory that receives SKILL.md. */
export function skillDestinationDir(home: string, harness: Harness): string {
  return dirname(skillDestination(home, harness));
}
