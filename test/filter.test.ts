import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIN_CONFIDENCE,
  FindingSchema,
  MAX_COMMENT_BODY,
  MAX_POSTED_COMMENTS,
  MAX_SYMBOL_NAME_DEPTH,
  MAX_SYMBOL_SCAN_CHARS,
  MAX_SYMBOL_SCAN_LINES,
  REASON_SIMILARITY_THRESHOLD,
  classifyFindings,
  commentTitle,
  enclosingSymbol,
  findingHash,
  formatComment,
  marker,
  minConfidenceFromEnv,
  parseMarker,
  reasonSimilarity,
  shouldPost,
  stripTrailingAngleGroups,
  stripTrailingBracketGroup,
  symbolScanStats,
  trailingIdentifier,
  trimmedEnd,
  type DiffSide,
  type ExistingFinding,
  type Finding,
  type PlannedComment,
  type ScopeLines,
} from "../src/filter.js";
import { diffLineTexts } from "../src/context.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return FindingSchema.parse({
    file: "src/billing.ts",
    line: 42,
    severity: "high",
    category: "bug",
    confidence: 0.9,
    reason: "Dropped the `expiresAt` check, so expired subscriptions keep access.",
    suggested_fix: "Restore the expiresAt check.",
    angle: "interrogate:correctness",
    symbol: "isSubscriptionActive",
    ...overrides,
  });
}

const MINIFIED_CHUNK = "var a=b(c,d)+e.f[g]*h;if(i){j=k}else{l=m};x=y/z;w=v/u;";

/** One ~390,000-char minified-style line with two divisions per chunk (R4-B1). */
function minifiedLine(): string {
  return MINIFIED_CHUNK.repeat(Math.floor(390_000 / MINIFIED_CHUNK.length));
}

const changedLines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
  [
    "src/billing.ts",
    new Map<DiffSide, ReadonlySet<number>>([
      ["RIGHT", new Set([42, 43, 50])],
      ["LEFT", new Set([41])],
    ]),
  ],
]);

describe("findingHash", () => {
  it("is the same when the same finding moves to a shifted line", () => {
    const before = finding({ line: 42 });
    const after = finding({ line: 43, end_line: 45 });

    expect(findingHash(after)).toBe(findingHash(before));
  });

  it("ignores formatting-only drift in the reason", () => {
    const plain = finding({ reason: "Null deref in the subscription lookup." });
    const noisy = finding({ reason: "  NULL deref in the `subscription` lookup.  " });

    expect(findingHash(noisy)).toBe(findingHash(plain));
  });

  it("is a lowercase 40-character hex sha1", () => {
    expect(findingHash(finding())).toMatch(/^[0-9a-f]{40}$/);
  });

  it("changes when the file changes", () => {
    expect(findingHash(finding({ file: "src/other.ts" }))).not.toBe(
      findingHash(finding()),
    );
  });

  it("changes when the category changes", () => {
    expect(findingHash(finding({ category: "security" }))).not.toBe(
      findingHash(finding()),
    );
  });

  it("changes when the reason changes", () => {
    expect(findingHash(finding({ reason: "A different bug entirely." }))).not.toBe(
      findingHash(finding()),
    );
  });

  it("ignores the model's symbol but changes with the deterministic symbol", () => {
    expect(findingHash(finding({ symbol: "otherSymbol" }))).toBe(
      findingHash(finding()),
    );
    expect(findingHash(finding({ symbol: "a" }), "one")).not.toBe(
      findingHash(finding({ symbol: "b" }), "two"),
    );
  });

  it("stays the same on a shifted line when the model symbol drifts or is missing", () => {
    const before = finding({ line: 42, symbol: "cartOwnerName" });
    const after = finding({ line: 47, end_line: 49, symbol: "" });

    expect(findingHash(after, "cartOwnerName")).toBe(
      findingHash(before, "cartOwnerName"),
    );
  });

  it("changes when the deterministic symbol moves into another function", () => {
    const content = [
      "export function cartSubtotal(order: Order): number {",
      "  return order.total;",
      "}",
      "export function cartOwnerName(order: Order): string {",
      "  return order.name;",
      "}",
    ].join("\n");
    const inSubtotal = enclosingSymbol(content, 2);
    const inOwner = enclosingSymbol(content, 5);

    expect(inSubtotal).toBe("cartSubtotal");
    expect(inOwner).toBe("cartOwnerName");
    expect(findingHash(finding(), inSubtotal)).not.toBe(
      findingHash(finding(), inOwner),
    );
  });
});

describe("shouldPost", () => {
  it("posts a high-confidence, high-severity finding on a changed line", () => {
    expect(shouldPost(finding(), { minConfidence: 0.8, changedLines })).toBe(true);
  });

  it("does not post a finding below the confidence threshold", () => {
    expect(
      shouldPost(finding({ confidence: 0.79 }), { minConfidence: 0.8, changedLines }),
    ).toBe(false);
  });

  it("does not post a low-severity finding", () => {
    expect(
      shouldPost(finding({ severity: "low", confidence: 1 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(false);
  });

  it("does not post a finding whose line is not in the diff", () => {
    expect(shouldPost(finding({ line: 99 }), { minConfidence: 0.8, changedLines })).toBe(
      false,
    );
  });

  it("does not post a LEFT-side finding on a RIGHT-only line", () => {
    expect(
      shouldPost(finding({ side: "LEFT", line: 42 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(false);
  });

  it("posts a LEFT-side finding on a LEFT line", () => {
    expect(
      shouldPost(finding({ side: "LEFT", line: 41 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(true);
  });

  it("does not post a range whose end_line is before line", () => {
    expect(
      shouldPost(finding({ line: 43, end_line: 42 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(false);
  });

  it("does not post a range whose end_line is not in the diff", () => {
    expect(
      shouldPost(finding({ line: 42, end_line: 99 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(false);
  });

  it("posts a multi-line range fully inside the diff", () => {
    expect(
      shouldPost(finding({ line: 42, end_line: 43 }), {
        minConfidence: 0.8,
        changedLines,
      }),
    ).toBe(true);
  });
});

describe("marker", () => {
  it("carries the hidden marker and a RUN_ID line watch-pr can count", () => {
    const body = marker("abc123", "987654321", "deadbeef");

    expect(body).toContain("RUN_ID: ");
    expect(body).toContain("<!-- bugbot:v1 id=abc123 run=987654321 sha=deadbeef -->");
    expect(body).toContain("RUN_ID: 987654321");
  });
});

describe("enclosingSymbol", () => {
  const ts = [
    "export class Billing {",
    "  private readonly tax = 0.2;",
    "  constructor(private readonly repo: Repo) {}",
    "  async charge(order: Order): Promise<void> {",
    "    const total = order.total;",
    "    await this.repo.charge(total);",
    "  }",
    "  handler = async (event: Event) => {",
    "    run();",
    "  };",
    "}",
    "",
    "export function refund(order: Order): void {",
    "  if (!order.paid) {",
    "    return;",
    "  }",
    "}",
    "",
    "const applyDiscount = (total: number): number => {",
    "  return total * 0.9;",
    "};",
  ].join("\n");

  it("qualifies a TypeScript method with its class", () => {
    expect(enclosingSymbol(ts, 6)).toBe("Billing.charge");
    expect(enclosingSymbol(ts, 9)).toBe("Billing.handler");
  });

  it("finds a TypeScript function and a class", () => {
    expect(enclosingSymbol(ts, 15)).toBe("refund");
    expect(enclosingSymbol(ts, 2)).toBe("Billing");
  });

  it("finds a const arrow function", () => {
    expect(enclosingSymbol(ts, 20)).toBe("applyDiscount");
  });

  it("finds a Python def and class by indentation", () => {
    const python = [
      "class Billing:",
      "    def charge(self, order):",
      "        total = order.total",
      "        return total",
      "",
      "top_level = 1",
    ].join("\n");

    expect(enclosingSymbol(python, 3)).toBe("Billing.charge");
    expect(enclosingSymbol(python, 4)).toBe("Billing.charge");
    expect(enclosingSymbol(python, 1)).toBe("Billing");
    expect(enclosingSymbol(python, 6)).toBe("");
  });

  it("qualifies a Go method with its receiver type", () => {
    const go = [
      "func (s *Server) Handle(w http.ResponseWriter) {",
      "\twrite()",
      "}",
    ].join("\n");

    expect(enclosingSymbol(go, 2)).toBe("Server.Handle");
  });

  it("finds a Rust fn with visibility and async", () => {
    const rust = [
      "pub async fn handle(req: Request) -> Response {",
      "    respond()",
      "}",
    ].join("\n");

    expect(enclosingSymbol(rust, 2)).toBe("handle");
  });

  it("uses the hunk context only when the content is not known to be full", () => {
    expect(
      enclosingSymbol("const x = 1;\nconst y = 2;", 2, " export interface Order { "),
    ).toBe("");
    expect(enclosingSymbol("", 10, " export interface Order { ")).toBe(
      "export interface Order {",
    );
    expect(
      enclosingSymbol("const x = 1;", 1, " export interface Order { ", {
        fullContent: false,
      }),
    ).toBe("export interface Order {");
    expect(enclosingSymbol("const x = 1;", 1)).toBe("");
    expect(enclosingSymbol("", 10, "")).toBe("");
  });

  it("stops a declaration at its closing brace and qualifies nested functions", () => {
    const nested = [
      "function outer() {",
      "  function inner() {",
      "    bugA();",
      "  }",
      "  bugB();",
      "}",
      "const top = 1;",
      "bugC();",
    ].join("\n");

    expect(enclosingSymbol(nested, 3)).toBe("outer.inner");
    expect(enclosingSymbol(nested, 5)).toBe("outer");
    expect(enclosingSymbol(nested, 6)).toBe("");
    expect(enclosingSymbol(nested, 7)).toBe("");
    expect(enclosingSymbol(nested, 8)).toBe("");
  });

  it("separates same-named methods in different classes", () => {
    const classes = [
      "class A {",
      "  render() {",
      "    bugA();",
      "  }",
      "}",
      "class B {",
      "  render() {",
      "    bugB();",
      "  }",
      "}",
    ].join("\n");

    expect(enclosingSymbol(classes, 3)).toBe("A.render");
    expect(enclosingSymbol(classes, 8)).toBe("B.render");
  });

  it("qualifies object arrow properties, named or unnamed", () => {
    const named = [
      "const handlers = {",
      "  onSave: (x) => {",
      "    bugA();",
      "  },",
      "  onLoad: async (x) => {",
      "    bugB();",
      "  },",
      "};",
    ].join("\n");
    const unnamed = [
      "export default {",
      "  onSave: (x) => {",
      "    bug();",
      "  },",
      "};",
    ].join("\n");

    expect(enclosingSymbol(named, 3)).toBe("handlers.onSave");
    expect(enclosingSymbol(named, 6)).toBe("handlers.onLoad");
    expect(enclosingSymbol(unnamed, 3)).toBe("onSave");
  });

  it("recognizes typed class fields, including async", () => {
    const fields = [
      "class A {",
      "  handler: Handler = (x) => {",
      "    bugA();",
      "  };",
      "  asyncHandler: Handler = async (x) => {",
      "    bugB();",
      "  };",
      "}",
    ].join("\n");

    expect(enclosingSymbol(fields, 3)).toBe("A.handler");
    expect(enclosingSymbol(fields, 6)).toBe("A.asyncHandler");
  });

  it("recognizes multi-line method and arrow signatures", () => {
    const methods = [
      "class A {",
      "  render(",
      "    x: string,",
      "  ) {",
      "    bugA();",
      "  }",
      "}",
      "const handler = (",
      "  x: string,",
      ") => {",
      "  bugB();",
      "};",
    ].join("\n");

    expect(enclosingSymbol(methods, 5)).toBe("A.render");
    expect(enclosingSymbol(methods, 11)).toBe("handler");
  });

  it("recognizes generator methods and complex parameters", () => {
    const methods = [
      "class A {",
      "  *gen() {",
      "    bugA();",
      "  }",
      "  render(x: () => void) {",
      "    bugB();",
      "  }",
      "}",
    ].join("\n");

    expect(enclosingSymbol(methods, 3)).toBe("A.gen");
    expect(enclosingSymbol(methods, 6)).toBe("A.render");
  });

  it("ignores braces in strings, template literals and comments", () => {
    const content = [
      "function outer() {",
      '  const s = "function fake() {";',
      "  // function fake() {",
      "  const t = `start",
      "function fake() {",
      "  template brace }",
      "`;",
      "  bugA();",
      "}",
      "bugC();",
    ].join("\n");

    expect(enclosingSymbol(content, 2)).toBe("outer");
    expect(enclosingSymbol(content, 5)).toBe("outer");
    expect(enclosingSymbol(content, 8)).toBe("outer");
    expect(enclosingSymbol(content, 10)).toBe("");
  });

  it("handles moved functions, the declaration line and LEFT content", () => {
    const content = [
      "function alpha() {",
      "  bugA();",
      "}",
      "",
      "function beta() {",
      "  bugB();",
      "}",
    ].join("\n");

    expect(enclosingSymbol(content, 1)).toBe("alpha");
    expect(enclosingSymbol(content, 2)).toBe("alpha");
    expect(enclosingSymbol(content, 6)).toBe("beta");

    const shifted = ["// an edit above the function", "function alpha() {", "  bug();", "}"].join(
      "\n",
    );
    expect(enclosingSymbol(shifted, 3)).toBe("alpha");

    const removed = ["function removed() {", "  bug();", "}"].join("\n");
    expect(enclosingSymbol(removed, 2)).toBe("removed");
    expect(enclosingSymbol("", 1, "export function handler() {")).toBe(
      "export function handler() {",
    );
  });

  it("qualifies a Rust impl by the type after for, not the trait (R2-B1)", () => {
    const rust = [
      "impl Display for A {",
      "  fn fmt(&self, f: &mut Formatter) -> Result {",
      "    bugA();",
      "  }",
      "}",
      "impl Display for B {",
      "  fn fmt(&self, f: &mut Formatter) -> Result {",
      "    bugB();",
      "  }",
      "}",
    ].join("\n");

    expect(enclosingSymbol(rust, 3)).toBe("A.fmt");
    expect(enclosingSymbol(rust, 8)).toBe("B.fmt");
  });

  it("strips generics, references and paths from a Rust impl target (R2-B1)", () => {
    const rust = [
      "impl From<A> for X {",
      "  fn from(a: A) -> Self {",
      "    bugA();",
      "  }",
      "}",
      "impl From<B> for X {",
      "  fn from(b: B) -> Self {",
      "    bugB();",
      "  }",
      "}",
      "impl<'a, T> From<T> for &'a mut app::Wrapper<T> {",
      "  fn from(t: T) -> Self {",
      "    bugC();",
      "  }",
      "}",
    ].join("\n");

    // Two impls whose target is the same type share a symbol and therefore a
    // hash. That is expected: the deterministic identity is the type, and the
    // two `from` functions really do belong to X.
    expect(enclosingSymbol(rust, 3)).toBe("X.from");
    expect(enclosingSymbol(rust, 8)).toBe("X.from");
    expect(enclosingSymbol(rust, 13)).toBe("Wrapper.from");
  });

  it("keeps Rust lifetimes and a char literal's brace out of scope (R5-B1)", () => {
    const rust = [
      "impl<'a> Foo<'a> {",
      "  fn m(&'a self) {",
      "    let brace = '{';",
      "    bug();",
      "  }",
      "}",
      "function after() {",
      "  bugAfter();",
      "}",
    ].join("\n");

    // The lifetimes must not open a string, and `'{'` must not open a block;
    // either would leave `after` nested and change every later symbol.
    expect(enclosingSymbol(rust, 4)).toBe("Foo.m");
    expect(enclosingSymbol(rust, 8)).toBe("after");
  });

  it("reads lifetimes only on a Rust declaration line (R6-N1)", () => {
    const javascript = [
      "function a() {",
      "  const s = 'a {';",
      "  BUG();",
      "}",
      "function b() {",
      "  BUG2();",
      "}",
    ].join("\n");

    // Without the declaration-line guard, `'a {` in the JavaScript string is a
    // lifetime plus a block, so `b` is read as `a.b`.
    expect(enclosingSymbol(javascript, 3)).toBe("a");
    expect(enclosingSymbol(javascript, 6)).toBe("b");
  });

  it("does not read a Rust char literal as a lifetime (R6-N1)", () => {
    const rust = ["fn a() { let c = 'a'; }", "fn b() {", "    bug();", "}"].join("\n");

    // Without the `'a'` rule, the closing `}` is swallowed as string content,
    // so `b` is read as `a.b`.
    expect(enclosingSymbol(rust, 3)).toBe("b");
  });

  it("skips an object literal in a return type instead of taking it as the body (R2-B2)", () => {
    const content = [
      "async function load(): Promise<{ ok: boolean }> {", // 1
      "  bugLoad();", // 2
      "}", // 3
      "function list(): Array<{ id: number }> {", // 4
      "  bugList();", // 5
      "}", // 6
      "class A {", // 7
      "  async load(): Promise<{ ok: boolean }> {", // 8
      "    bugMethod();", // 9
      "  }", // 10
      "  m(): Record<string, { a: 1 }> {", // 11
      "    bugRecord();", // 12
      "  }", // 13
      "}", // 14
      "function f(): { a: 1 } | null {", // 15
      "  bugUnion();", // 16
      "}", // 17
      "function isX(v: unknown): v is { a: 1 } {", // 18
      "  bugPredicate();", // 19
      "}", // 20
      "const arrow = async (): Promise<{ ok: boolean }> => {", // 21
      "  bugArrow();", // 22
      "};", // 23
      "function f2(x: Map<string, { a: 1 }>) {", // 24
      "  bugParam();", // 25
      "}", // 26
      "class Box<T extends { a: 1 }> {", // 27
      "  value(): T {", // 28
      "    bugGeneric();", // 29
      "  }", // 30
      "}", // 31
    ].join("\n");

    expect(enclosingSymbol(content, 2)).toBe("load");
    expect(enclosingSymbol(content, 5)).toBe("list");
    expect(enclosingSymbol(content, 9)).toBe("A.load");
    expect(enclosingSymbol(content, 12)).toBe("A.m");
    expect(enclosingSymbol(content, 16)).toBe("f");
    expect(enclosingSymbol(content, 19)).toBe("isX");
    expect(enclosingSymbol(content, 22)).toBe("arrow");
    expect(enclosingSymbol(content, 25)).toBe("f2");
    expect(enclosingSymbol(content, 29)).toBe("Box.value");
  });

  it("qualifies a generic Go receiver by its type (R2-N2)", () => {
    const go = [
      "func (s *Stack[T]) Push(v T) {",
      "\tbug();",
      "}",
      "func (s *Queue[T]) Push(v T) {",
      "\tbug();",
      "}",
    ].join("\n");

    expect(enclosingSymbol(go, 2)).toBe("Stack.Push");
    expect(enclosingSymbol(go, 5)).toBe("Queue.Push");
  });

  it("recognises generic method signatures (R3-B1)", () => {
    const content = [
      "class Http {",
      "  async get<T>(url: string): Promise<T> {",
      "    bugGet();",
      "  }",
      "  static create<T>(x: T): Http {",
      "    bugCreate();",
      "  }",
      "  map<U>(f: (value: T) => U): U[] {",
      "    bugMap();",
      "  }",
      "  post<T>(): Promise<T> {",
      "    bugPost();",
      "  }",
      "}",
    ].join("\n");

    expect(enclosingSymbol(content, 3)).toBe("Http.get");
    expect(enclosingSymbol(content, 6)).toBe("Http.create");
    expect(enclosingSymbol(content, 9)).toBe("Http.map");
    expect(enclosingSymbol(content, 12)).toBe("Http.post");
  });

  it("recognises generic arrow functions and generic class fields (R3-B1)", () => {
    const content = [
      "const f = <T>(x: T): T => {", // 1
      "  bugF();", // 2
      "};", // 3
      "const g = async <T,>(x: T): Promise<T> => {", // 4
      "  bugG();", // 5
      "};", // 6
      "class A {", // 7
      "  field = <T>(x: T): T => {", // 8
      "    bugField();", // 9
      "  };", // 10
      "  typed: Handler = <T>(x: T) => {", // 11
      "    bugTyped();", // 12
      "  };", // 13
      "  plain = async <T>(x: T): Promise<T> => {", // 14
      "    bugPlain();", // 15
      "  };", // 16
      "}", // 17
    ].join("\n");

    expect(enclosingSymbol(content, 2)).toBe("f");
    expect(enclosingSymbol(content, 5)).toBe("g");
    expect(enclosingSymbol(content, 9)).toBe("A.field");
    expect(enclosingSymbol(content, 12)).toBe("A.typed");
    expect(enclosingSymbol(content, 15)).toBe("A.plain");
  });

  it("recognises Go generic functions by name (R3-B1)", () => {
    const go = [
      "func Map[T any](xs []T) []T {",
      "\tbugMap();",
      "}",
      "func Filter[T comparable, U any](xs []T) []U {",
      "\tbugFilter();",
      "}",
    ].join("\n");

    expect(enclosingSymbol(go, 2)).toBe("Map");
    expect(enclosingSymbol(go, 5)).toBe("Filter");
  });

  it("recognises Python 3.12 type parameters (R3-B1)", () => {
    const python = [
      "class A[T]:",
      "    def f[T](self, x: T) -> T:",
      "        bugF();",
      "    def g(self):",
      "        bugG();",
    ].join("\n");

    expect(enclosingSymbol(python, 3)).toBe("A.f");
    expect(enclosingSymbol(python, 5)).toBe("A.g");
  });

  it("recognises type-parameter constraints containing an arrow (R4-N3)", () => {
    const methods = [
      "class Http {", // 1
      "  run<F extends (a: number) => void>(f: F) {", // 2
      "    bugRun();", // 3
      "  }", // 4
      "  m<T = () => void>(x: T) {", // 5
      "    bugM();", // 6
      "  }", // 7
      "}", // 8
    ].join("\n");
    expect(enclosingSymbol(methods, 3)).toBe("Http.run");
    expect(enclosingSymbol(methods, 6)).toBe("Http.m");

    const arrows = [
      "const f = <T extends (a: number) => void>(x: T) => {", // 1
      "  bugF();", // 2
      "};", // 3
      "const g = <T = () => void>(x: T) => {", // 4
      "  bugG();", // 5
      "};", // 6
    ].join("\n");
    expect(enclosingSymbol(arrows, 2)).toBe("f");
    expect(enclosingSymbol(arrows, 5)).toBe("g");
  });

  it("does not name a Python def line over the declaration bound (R4-N3)", () => {
    const params = "x".repeat(3_000);
    const python = ["class A:", `    def f(${params}):`, "        bug();"].join("\n");
    expect(python.split("\n")[1]?.length ?? 0).toBeGreaterThan(2_000);
    expect(python.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(enclosingSymbol(python, 3)).toBe("A");
  });

  it("strips a Rust where clause from a one-line or multi-line impl header (R3-N1)", () => {
    const oneLine = [
      "impl<T: Clone> Display for Vec2<T> where T: Debug {",
      "  fn fmt(&self) {",
      "    bug();",
      "  }",
      "}",
    ].join("\n");
    expect(enclosingSymbol(oneLine, 3)).toBe("Vec2.fmt");

    const multiLine = [
      "impl<T: Clone> Display for Wrapper<T>",
      "where",
      "  T: Debug,",
      "{",
      "  fn fmt(&self) {",
      "    bug();",
      "  }",
      "}",
    ].join("\n");
    expect(enclosingSymbol(multiLine, 6)).toBe("Wrapper.fmt");
  });

  it("uses the hunk context over the char cap and scans under it (R3-N1)", () => {
    const under = `function a() {${"x".repeat(399_980)}`; // 399,993 chars, one line
    const over = `function a() {${"x".repeat(399_990)}`; // 400,003 chars, one line
    expect(under.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(over.length).toBeGreaterThan(MAX_SYMBOL_SCAN_CHARS);

    symbolScanStats.scans = 0;
    expect(enclosingSymbol(over, 1, " over cap ")).toBe("over cap");
    expect(symbolScanStats.scans).toBe(0);

    expect(enclosingSymbol(under, 1, " under cap ")).toBe("");
    expect(symbolScanStats.scans).toBe(1);
  });

  it("finishes one 300,000-char line scan in under 500 ms (R3-B2)", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["a + spaces + b", "a" + " ".repeat(300_000) + "b"],
      ["spaces + x", " ".repeat(300_000) + "x"],
      ["python class + spaces + b", "class A" + " ".repeat(300_000) + "b"],
      ["tabs", "a" + "\t".repeat(300_000) + "b"],
    ];

    for (const [name, content] of cases) {
      expect(content.length, name).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
      const started = performance.now();
      const symbol = enclosingSymbol(content, 1);
      const elapsed = performance.now() - started;

      expect(elapsed, `${name}: ${elapsed.toFixed(1)}ms`).toBeLessThan(500);
      expect(symbol, name).toBe("");
    }
  });

  it("scans a 400k line of divisions in under 500 ms (R4-B1)", () => {
    const content = "a/".repeat(199_990);
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 1);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans a 400k line of unterminated regex classes in under 500 ms (R4-B1)", () => {
    const content = "/[".repeat(199_990);
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 1);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans 400k unterminated regex classes closed only at the end in under 500 ms (R5-N1)", () => {
    // The final `]` defeats the lastCloseBracket fast path, so every `/` scans
    // up to MAX_REGEX_LITERAL_CHARS; without that cap this is quadratic.
    const content = "/[".repeat(199_989) + "]";
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 1);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans 133k is{ repeats in under 500 ms (R4-B1)", () => {
    const content = "function f()\n" + "is{".repeat(133_000);
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(content.split("\n").length).toBeLessThan(MAX_SYMBOL_SCAN_LINES);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 2);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans a 133k <a> impl header in under 500 ms (R4-B1)", () => {
    const content = "impl A\n" + "<a>".repeat(133_000) + " {";
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(content.split("\n").length).toBeLessThan(MAX_SYMBOL_SCAN_LINES);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 2);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans a 390k minified line with thousands of divisions in under 500 ms (R4-B1)", () => {
    const content = minifiedLine();
    const divisions = (content.match(/\//g) ?? []).length;
    expect(content.length).toBeGreaterThan(380_000);
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(divisions).toBeGreaterThan(5_000);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 1);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms, ${divisions} divisions`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans 190 lines of is{ under the 2,000-char bound in under 500 ms (R4-B1)", () => {
    const content = Array.from(
      { length: 190 },
      () => "function f(): x " + "is{".repeat(650),
    ).join("\n");
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(content.split("\n")).toHaveLength(190);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 190);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("classifies a finding on the 390k minified line in under 1 s (R4-B1)", () => {
    const content = minifiedLine();
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["dist/bundle.min.js", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([1])]])],
    ]);
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    const started = performance.now();
    const result = classifyFindings(
      [finding({ file: "dist/bundle.min.js", line: 1, reason: "Minified bug." })],
      { changedLines: lines, contentFor: () => content },
    );
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(1_000);
    expect(result.post).toHaveLength(1);
    expect(result.post[0]?.symbol).toBe("");
  });

  it("scans 190 padded function lines without adjacent quantifiers in under 500 ms (R4-N1)", () => {
    const content = Array.from(
      { length: 190 },
      () => "function" + " ".repeat(1_970) + "*",
    ).join("\n");
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(content.split("\n")).toHaveLength(190);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 190);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans a 400k pub( apostrophe line in under 500 ms (R5-B1)", () => {
    const content = "pub(" + "'a' ".repeat(99_990);
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 1);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans a 400k whitespace-prefixed apostrophe line in under 500 ms (R5-B1)", () => {
    const content = " ".repeat(200_000) + "'a' ".repeat(49_990);
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 1);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans a 400k whitespace-prefixed Rust lifetime line in under 500 ms (R5-B1)", () => {
    const content = " ".repeat(199_000) + "impl" + " 'a".repeat(66_000);
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 1);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans 199 maximal Go receiver lines in under 500 ms (R6-B1)", () => {
    const content = Array(199).fill("func (" + "a".repeat(1989) + "*) f(").join("\n");
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(content.split("\n")).toHaveLength(199);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 199);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans 199 maximal impl header lines in under 500 ms (R6-B1)", () => {
    const content = Array(199).fill("impl " + "a".repeat(1993) + "!{").join("\n");
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(content.split("\n")).toHaveLength(199);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 199);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans 199 maximal impl headers of empty angle groups in under 500 ms (R6-B1)", () => {
    const content = Array(199).fill("pub impl " + "<>".repeat(995) + "{").join("\n");
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(content.split("\n")).toHaveLength(199);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 199);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("scans 199 maximal Go receivers of open brackets in under 500 ms (R6-B1)", () => {
    const content = Array(199).fill("func (" + "[".repeat(1985) + ") f(").join("\n");
    expect(content.length).toBeLessThan(MAX_SYMBOL_SCAN_CHARS);
    expect(content.split("\n")).toHaveLength(199);
    const started = performance.now();
    const symbol = enclosingSymbol(content, 199);
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(500);
    expect(symbol).toBe("");
  });

  it("reads a slash after a keyword as a regex and after an expression as division (R5-N2)", () => {
    // Each row is [name, probe, wrapper, slash starts a regex]. The probe's
    // /}/ hides its `}` from the scope count when the slash is a regex; read as
    // division, that `}` closes `a`, so TARGET is only inside `a` for a regex.
    type Wrapper = "function" | "block";
    const rows: ReadonlyArray<readonly [string, string, Wrapper, boolean]> = [
      ["return", "return /}/.test(s);", "function", true],
      ["typeof", "typeof /}/.test(s);", "function", true],
      ["instanceof", "x instanceof /}/;", "function", true],
      ["case", "case /}/:", "function", true],
      ["yield", "yield /}/;", "function", true],
      ["await", "await /}/;", "function", true],
      ["throw", "throw /}/;", "function", true],
      ["void", "void /}/;", "function", true],
      ["else", "else /}/.test(s);", "function", true],
      ["in", "x in /}/;", "function", true],
      ["of", "x of /}/;", "function", true],
      ["new", "new /}/.test(s);", "function", true],
      ["delete", "delete /}/.x;", "function", true],
      ["do", "do /}/.test(s);", "function", true],
      ["identifier", "x /}/.test(s);", "function", false],
      [")", "f() /}/.test(s);", "function", false],
      ["]", "a[0] /}/.test(s);", "function", false],
      ["number", "1 /}/.test(s);", "function", false],
      ["1e5", "1e5 /}/.test(s);", "function", false],
      ["block comment before regex", "/* c */ /}/.test(s);", "function", true],
      ["block comment before division", "/* c */ x /}/.test(s);", "function", false],
      ["=", "x = /}/.test(s);", "function", true],
      ["(", "(/}/).test(s);", "function", true],
      [",", "f(a, /}/);", "function", true],
      [":", "x ? y : /}/;", "function", true],
      ["&&", "x && /}/.test(s);", "function", true],
      ["!", "!/}/.test(s);", "function", true],
      ["?", "x ? /}/ : y;", "function", true],
      [";", "x; /}/.test(s);", "function", true],
      ["{", "{ /}}/.test(s);", "function", true],
      ["}", "} /}/.test(s);", "block", true],
      ["tab after return", "return\t/}/.test(s);", "function", true],
      ["NBSP after return", "return\u00a0/}/.test(s);", "function", true],
      ["xreturn", "xreturn /}/.test(s);", "function", false],
      ["$return", "$return /}/.test(s);", "function", false],
      ["return$", "return$ /}/.test(s);", "function", false],
      ["class containing / and }", "x = /[/}]/.test(s);", "function", true],
    ];
    expect(rows).toHaveLength(37);

    for (const [name, probe, wrapper, isRegex] of rows) {
      const content =
        wrapper === "function"
          ? ["function a() {", `  ${probe}`, "  TARGET", "}"].join("\n")
          : ["function a() {", "  {", `    ${probe}`, "    TARGET", "  }", "}"].join(
              "\n",
            );
      const line = wrapper === "function" ? 3 : 4;

      expect(enclosingSymbol(content, line), name).toBe(isRegex ? "a" : "");
    }
  });

  it("qualifies a function inside a TypeScript namespace (R2-N2)", () => {
    const content = [
      "namespace N {",
      "  function f() {",
      "    bug();",
      "  }",
      "  export function g() {",
      "    bug();",
      "  }",
      "}",
    ].join("\n");

    expect(enclosingSymbol(content, 3)).toBe("N.f");
    expect(enclosingSymbol(content, 6)).toBe("N.g");
  });

  it("does not let a regex literal with a brace open a scope (R2-N2)", () => {
    const content = [
      "function outer() {",
      "  const opening = /\\{/;",
      "  bugA();",
      "}",
      "function b() {",
      "  bugB();",
      "}",
    ].join("\n");

    expect(enclosingSymbol(content, 3)).toBe("outer");
    expect(enclosingSymbol(content, 6)).toBe("b");
  });

  it("ignores def and class lines inside a Python triple-quoted string (R2-N2)", () => {
    const python = [
      "def real():",
      '    """A docstring.',
      "    def fake():",
      "    class Fake:",
      '    """',
      "    bug();",
      "def after():",
      "    bug();",
    ].join("\n");

    expect(enclosingSymbol(python, 3)).toBe("real");
    expect(enclosingSymbol(python, 4)).toBe("real");
    expect(enclosingSymbol(python, 6)).toBe("real");
    expect(enclosingSymbol(python, 8)).toBe("after");
  });
});

describe("backward-scan helpers (R6-B1)", () => {
  /** The `replace(/<[^<>]*>\s*$/, "").trimEnd()` loop, kept as the oracle. */
  function stripTrailingAngleGroupsOracle(text: string): string {
    let previous = "";
    while (text !== previous) {
      previous = text;
      text = text.replace(/<[^<>]*>\s*$/, "").trimEnd();
    }
    return text;
  }

  const inputs: readonly string[] = [
    "",
    "   ",
    "\t \n",
    "impl<T> From<T> for app::Wrapper<T>",
    "&'a mut Vec<T>",
    "Stack[T]",
    "*Stack[K, V]",
    "Stack[T]   ",
    "\tWrapper<T>\t",
    "$foo",
    "a$b",
    "123abc",
    "_x9",
    "a1",
    "[]",
    "[T]",
    "impl A [T]",
    "<>",
    "<T>",
    "<a><b>",
    "a<b<c>>",
    "impl A",
    "é",
    "a\u00a0",
    "a\u2028",
    "a\ufeff",
  ];

  it("matches the regex each one replaces", () => {
    for (const text of inputs) {
      const label = JSON.stringify(text);

      expect(trimmedEnd(text, text.length), label).toBe(
        text.length - (/\s*$/.exec(text)?.[0].length ?? 0),
      );
      expect(trailingIdentifier(text), label).toBe(
        /([A-Za-z_]\w*)\s*$/.exec(text)?.[1] ?? "",
      );
      expect(stripTrailingBracketGroup(text), label).toBe(
        text.replace(/\[[^\]]*\]\s*$/, ""),
      );
      expect(stripTrailingAngleGroups(text), label).toBe(
        stripTrailingAngleGroupsOracle(text),
      );
    }
  });
});

describe("minConfidenceFromEnv", () => {
  it("uses 0.8 when the variable is absent or empty", () => {
    expect(minConfidenceFromEnv(undefined)).toBe(DEFAULT_MIN_CONFIDENCE);
    expect(minConfidenceFromEnv("")).toBe(DEFAULT_MIN_CONFIDENCE);
  });

  it("falls back to 0.8 for garbage and out-of-range values", () => {
    for (const raw of ["abc", "-1", "2", "0.1 ", " 0.1", "NaN", "Infinity", "1.5", "0.8.1"]) {
      expect(minConfidenceFromEnv(raw), raw).toBe(DEFAULT_MIN_CONFIDENCE);
      const result = classifyFindings([finding({ confidence: 0.5 })], {
        changedLines,
        minConfidence: minConfidenceFromEnv(raw),
      });
      expect(result.post, raw).toHaveLength(0);
      expect(result.summary.belowConfidence, raw).toBe(1);
    }
  });

  it("allows a deliberate lower value, including 0.1", () => {
    expect(minConfidenceFromEnv("0.1")).toBeCloseTo(0.1);
    expect(minConfidenceFromEnv("1")).toBe(1);

    const result = classifyFindings([finding({ confidence: 0.5 })], {
      changedLines,
      minConfidence: minConfidenceFromEnv("0.1"),
    });
    expect(result.post).toHaveLength(1);
    expect(result.summary.belowConfidence).toBe(0);
  });
});

describe("reasonSimilarity and the reason schema", () => {
  it("treats zero-token normalized reasons as dissimilar", () => {
    expect(reasonSimilarity("!!!", "???")).toBe(0);
    expect(reasonSimilarity("!!!", "bug")).toBe(0);
    expect(reasonSimilarity("😀", "??")).toBe(0);
  });

  it("rejects a reason with no letter or digit", () => {
    const parsed = FindingSchema.safeParse({ ...finding(), reason: "!!!" });

    expect(parsed.success).toBe(false);
  });
});

describe("classifyFindings", () => {
  function classify(
    items: readonly unknown[],
    options: {
      minConfidence?: number;
      maxComments?: number;
      existing?: readonly ExistingFinding[];
      contentFor?: (file: string, side: DiffSide) => string | undefined;
      hunkContextFor?: (
        file: string,
        line: number,
        side: DiffSide,
      ) => string | undefined;
      lineTextFor?: (
        file: string,
        line: number,
        side: DiffSide,
      ) => string | undefined;
      scope?: ScopeLines;
    } = {},
  ) {
    return classifyFindings(items, { changedLines, ...options });
  }

  it("never posts a below-threshold finding", () => {
    const result = classify([finding({ confidence: 0.79 })]);

    expect(result.post).toHaveLength(0);
    expect(result.summary.belowConfidence).toBe(1);
  });

  it("never posts low severity, a line outside the diff, or a LEFT/RIGHT mismatch", () => {
    const result = classify([
      finding({ severity: "low", confidence: 1 }),
      finding({ line: 99 }),
      finding({ side: "LEFT", line: 42 }),
      finding({ side: "RIGHT", line: 41 }),
    ]);

    expect(result.post).toHaveLength(0);
    expect(result.summary).toMatchObject({
      lowSeverity: 1,
      notInDiff: 3,
      posted: 0,
    });
  });

  it("drops a dismissed medium bug", () => {
    const result = classify([
      finding({ severity: "medium", triage: "dismiss", reason: "Naming only." }),
    ]);

    expect(result.post).toHaveLength(0);
    expect(result.summary.triageDismissed).toBe(1);
  });

  it("keeps a dismissed high finding and a dismissed security or data finding", () => {
    const result = classify([
      finding({ severity: "high", triage: "dismiss", reason: "High bug." }),
      finding({
        severity: "medium",
        category: "security",
        triage: "dismiss",
        reason: "Security bug.",
      }),
      finding({
        severity: "medium",
        category: "data",
        triage: "dismiss",
        reason: "Data bug.",
      }),
    ]);

    expect(result.post).toHaveLength(3);
    expect(result.summary.triageDismissed).toBe(0);
    expect(result.post.every((comment) => comment.triage === "dismiss")).toBe(true);
  });

  it("posts ask findings", () => {
    const result = classify([finding({ triage: "ask" })]);

    expect(result.post).toHaveLength(1);
    expect(result.summary.triageDismissed).toBe(0);
  });

  it("keeps the highest-confidence copy of an in-pass duplicate", () => {
    const result = classify([
      finding({ line: 42, confidence: 0.8, reason: "Same  bug." }),
      finding({ line: 43, confidence: 0.95, reason: "same bug" }),
    ]);

    expect(result.post).toHaveLength(1);
    expect(result.post[0]?.confidence).toBe(0.95);
    expect(result.summary.duplicate).toBe(1);
    expect(result.summary.posted).toBe(1);
  });

  it("dedupes the same line regardless of wording, and nearby only when the reason overlaps (S8D-B1)", () => {
    const existingAt = (line: number, reason: string): ExistingFinding[] => [
      {
        hash: "a".repeat(40),
        file: "src/billing.ts",
        category: "bug",
        symbol: "",
        reason,
        state: "open",
        line,
        originalLine: line,
        side: "RIGHT",
      },
    ];

    // The live case: same line, the model reworded it completely.
    const sameLine = classify(
      [finding({ line: 42, reason: "Totally new wording for the same defect." })],
      {
        existing: existingAt(
          42,
          "Something completely unrelated from an earlier pass.",
        ),
      },
    );
    expect(sameLine.post).toHaveLength(0);
    expect(sameLine.summary.duplicate).toBe(1);

    // A reworded repeat three lines away still dedupes.
    const nearbyReworded = classify(
      [finding({ line: 42, reason: "A reworded null check bug." })],
      {
        existing: existingAt(
          45,
          "The null check bug is reworded but still the same bug.",
        ),
      },
    );
    expect(
      reasonSimilarity(
        "A reworded null check bug.",
        "The null check bug is reworded but still the same bug.",
      ),
    ).toBeGreaterThanOrEqual(0.2);
    expect(nearbyReworded.post).toHaveLength(0);
    expect(nearbyReworded.summary.duplicate).toBe(1);

    // Two different bugs three lines apart both post.
    const nearbyDifferent = classify(
      [finding({ line: 42, reason: "A null check bug." })],
      {
        existing: existingAt(
          45,
          "Completely unrelated arithmetic overflow on another path.",
        ),
      },
    );
    expect(
      reasonSimilarity(
        "A null check bug.",
        "Completely unrelated arithmetic overflow on another path.",
      ),
    ).toBeLessThan(0.2);
    expect(nearbyDifferent.post).toHaveLength(1);
    expect(nearbyDifferent.summary.duplicate).toBe(0);

    // Four lines away is never a location duplicate, however similar.
    const tooFar = classify(
      [finding({ line: 42, reason: "A reworded null check bug." })],
      {
        existing: existingAt(
          46,
          "The null check bug is reworded but still the same bug.",
        ),
      },
    );
    expect(tooFar.post).toHaveLength(1);
    expect(tooFar.summary.duplicate).toBe(0);
  });

  it("keeps a nearby bug that names different code and still merges one that names the same code (S8D-R1-N1)", () => {
    const existingAt = (line: number, reason: string): ExistingFinding[] => [
      {
        hash: "a".repeat(40),
        file: "src/billing.ts",
        category: "bug",
        symbol: "",
        reason,
        state: "open",
        line,
        originalLine: line,
        side: "RIGHT",
      },
    ];

    // The sibling template: the same sentence written about different code.
    const differentCode = classify(
      [
        finding({
          line: 43,
          reason:
            "`order.customer` may be missing on this path, so reading a property throws a TypeError.",
        }),
      ],
      {
        existing: existingAt(
          42,
          "`user.profile` can be undefined here, so reading a property throws a TypeError.",
        ),
        lineTextFor: (_file, line) =>
          line === 42 ? "  return user.profile.name;" : "  return order.customer.email;",
      },
    );
    expect(differentCode.post).toHaveLength(1);
    expect(differentCode.summary.duplicate).toBe(0);

    // The same code named by both is a reword, not a sibling.
    const sameCode = classify(
      [
        finding({
          line: 43,
          reason:
            "`user.profile` can be undefined here, so reading `user.profile.name` throws.",
        }),
      ],
      {
        existing: existingAt(
          42,
          "`user.profile` can be undefined here, so reading `user.profile.name` throws a TypeError.",
        ),
      },
    );
    expect(sameCode.post).toHaveLength(0);
    expect(sameCode.summary.duplicate).toBe(1);

    // The live case: both reasons name `end`, `start`, `pageSize` and `slice`.
    const live = classify(
      [
        finding({
          line: 43,
          reason:
            "`slice` receives `start` and `pageSize`; the `end` bound is missing.",
        }),
      ],
      {
        existing: existingAt(
          42,
          "`slice` takes `start` and `pageSize`, but the `end` index is never passed.",
        ),
      },
    );
    expect(live.post).toHaveLength(0);
    expect(live.summary.duplicate).toBe(1);

    // Only one side naming code is not enough to veto: that is a reword.
    const oneSided = classify(
      [
        finding({
          line: 42,
          reason: "The profile lookup returns undefined, so the next read throws.",
        }),
      ],
      { existing: existingAt(42, "`user.profile` can be undefined here.") },
    );
    expect(oneSided.post).toHaveLength(0);
    expect(oneSided.summary.duplicate).toBe(1);

    // Identifier-like words that the diff line itself uses as code count too,
    // so two bare-word siblings naming different code are not merged.
    const bareSiblings = classify(
      [
        finding({
          line: 43,
          reason: "begin and finish bound the loop, so the tail is skipped.",
        }),
      ],
      {
        existing: existingAt(
          42,
          "end and start bound the slice, so the pageSize is ignored.",
        ),
        lineTextFor: (_file, line) =>
          line === 42
            ? "  const rows = items.slice(start, end); // pageSize"
            : "  const rows = items.slice(begin, finish);",
      },
    );
    expect(bareSiblings.post).toHaveLength(1);
    expect(bareSiblings.summary.duplicate).toBe(0);
  });

  it("dedupes a same-line reword regardless of the code it names (S8D-R2-N2)", () => {
    const existingAt = (line: number, reason: string): ExistingFinding[] => [
      {
        hash: "a".repeat(40),
        file: "src/billing.ts",
        category: "bug",
        symbol: "",
        reason,
        state: "open",
        line,
        originalLine: line,
        side: "RIGHT",
      },
    ];

    // The reviewer's probe: the first pass blames the callee, the reword the
    // variable. Same line, so it is the same finding.
    const calleeVsVariable = classify(
      [
        finding({
          line: 42,
          reason: "`user` is dereferenced after the lookup without a guard.",
        }),
      ],
      {
        existing: existingAt(
          42,
          "`getUser` can return `null`, which is then dereferenced on the next line.",
        ),
        lineTextFor: () => "  const user = getUser(id);",
      },
    );
    expect(calleeVsVariable.post).toHaveLength(0);
    expect(calleeVsVariable.summary.duplicate).toBe(1);

    // No diff line text at all: disjoint backticks are still the same finding
    // on the same line (reviewer probe MISS2).
    const noLineText = classify(
      [finding({ line: 42, reason: "`user` is dereferenced unguarded." })],
      { existing: existingAt(42, "`getUser` can return `null`.") },
    );
    expect(noLineText.post).toHaveLength(0);
    expect(noLineText.summary.duplicate).toBe(1);
  });

  it("computes identifier sets only at the veto, once per candidate and thread (S8D-R2-N1)", () => {
    const threadAt = (
      line: number,
      reason: string,
      hash: string,
    ): ExistingFinding => ({
      hash: hash.repeat(40),
      file: "src/billing.ts",
      category: "bug",
      symbol: "",
      reason,
      state: "open",
      line,
      originalLine: line,
      side: "RIGHT",
    });
    const lineTextFor = (_file: string, line: number, _side: DiffSide): string =>
      `  const other${line} = compute();`;

    let calls = 0;
    const counted = (
      _file: string,
      line: number,
      _side: DiffSide,
    ): string => {
      calls += 1;
      return lineTextFor(_file, line, _side);
    };

    // Outside the line window: no identifier scan.
    const far = classify(
      [finding({ line: 42, reason: "`slice` drops the bound." })],
      {
        existing: [threadAt(50, "`slice` drops `end`.", "a")],
        lineTextFor: counted,
      },
    );
    expect(far.summary.duplicate).toBe(0);
    expect(calls).toBe(0);

    // Inside the window but below the similarity bar: no identifier scan.
    const dissimilar = classify(
      [finding({ line: 42, reason: "`alpha` `beta` `gamma` are all ignored." })],
      {
        existing: [threadAt(43, "`one` `two` `three` are unrelated.", "a")],
        lineTextFor: counted,
      },
    );
    expect(dissimilar.summary.duplicate).toBe(0);
    expect(calls).toBe(0);

    // The same line: a duplicate without touching the diff text.
    const sameLine = classify(
      [finding({ line: 42, reason: "`alpha` `beta` are ignored here." })],
      {
        existing: [threadAt(42, "`one` `two` are missing here.", "a")],
        lineTextFor: counted,
      },
    );
    expect(sameLine.summary.duplicate).toBe(1);
    expect(calls).toBe(0);

    // Two nearby threads: the veto is reached, the candidate line is read
    // once and each thread line once, not once per candidate x thread pair.
    const nearby = classify(
      [
        finding({
          line: 42,
          reason: "`user` is dereferenced after the lookup without a guard.",
        }),
      ],
      {
        existing: [
          threadAt(
            43,
            "`getUser` can return `null`, so the result is dereferenced without a guard.",
            "a",
          ),
          threadAt(
            44,
            "`findUser` may return `null`, so the value is dereferenced without a guard.",
            "b",
          ),
        ],
        lineTextFor: counted,
      },
    );
    expect(nearby.summary.duplicate).toBe(0);
    expect(calls).toBe(3);
  });

  it("keeps two different bugs one line apart inside one pass (S8D-B1 probe P2a)", () => {
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/billing.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([42, 43, 45, 46])]])],
    ]);
    const distinct = classifyFindings(
      [
        finding({ line: 42, reason: "The cache is never invalidated." }),
        finding({ line: 43, reason: "Stale cache entries are served." }),
      ],
      { changedLines: lines },
    );
    expect(distinct.post.map((comment) => comment.line)).toEqual([42, 43]);
    expect(distinct.summary.duplicate).toBe(0);

    // Inside one pass the within-3-lines rule is gone: a model that lists two
    // findings in one response meant two findings (S8D-R1-N1).
    const rewordedNearby = classifyFindings(
      [
        finding({ line: 42, reason: "The cache is never invalidated after writes." }),
        finding({ line: 45, reason: "The cache is never invalidated after a write." }),
      ],
      { changedLines: lines },
    );
    expect(rewordedNearby.post.map((comment) => comment.line)).toEqual([42, 45]);
    expect(rewordedNearby.summary.duplicate).toBe(0);

    const sameLine = classifyFindings(
      [
        finding({ line: 42, reason: "The cache is never invalidated." }),
        finding({ line: 42, reason: "Stale cache entries are served." }),
      ],
      { changedLines: lines },
    );
    expect(sameLine.post).toHaveLength(1);
    expect(sameLine.summary.duplicate).toBe(1);

    const farther = classifyFindings(
      [
        finding({ line: 42, reason: "The cache is never invalidated after writes." }),
        finding({ line: 46, reason: "The cache is never invalidated after a write." }),
      ],
      { changedLines: lines },
    );
    expect(farther.post).toHaveLength(2);
    expect(farther.summary.duplicate).toBe(0);
  });

  it("does not dedupe a LEFT finding against a RIGHT comment on the same number (N5)", () => {
    const result = classify([finding({ side: "LEFT", line: 41 })], {
      existing: [
        {
          hash: "a".repeat(40),
          file: "src/billing.ts",
          category: "bug",
          symbol: "",
          reason: "Same words on the head side.",
          state: "open",
          line: 41,
          originalLine: 41,
          side: "RIGHT",
        },
      ],
    });

    expect(result.post).toHaveLength(1);
    expect(result.summary.duplicate).toBe(0);
  });

  it("does not dedupe the same line in a different category", () => {
    const result = classify(
      [finding({ line: 42, category: "security", reason: "Security wording." })],
      {
        existing: [
          {
            hash: "a".repeat(40),
            file: "src/billing.ts",
            category: "bug",
            symbol: "",
            reason: "Something completely unrelated.",
            state: "open",
            line: 42,
            originalLine: 42,
            side: "RIGHT",
          },
        ],
      },
    );

    expect(result.post).toHaveLength(1);
    expect(result.summary.duplicate).toBe(0);
  });

  it("does not dedupe the same line in a different path", () => {
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/billing.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([42])]])],
      ["src/other.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([42])]])],
    ]);
    const result = classifyFindings(
      [finding({ file: "src/other.ts", line: 42, reason: "Other file wording." })],
      {
        changedLines: lines,
        existing: [
          {
            hash: "a".repeat(40),
            file: "src/billing.ts",
            category: "bug",
            symbol: "",
            reason: "Something completely unrelated.",
            state: "open",
            line: 42,
            originalLine: 42,
            side: "RIGHT",
          },
        ],
      },
    );

    expect(result.post).toHaveLength(1);
    expect(result.summary.duplicate).toBe(0);
  });

  it("does not let a resolved thread at the same location block a new comment", () => {
    const result = classify([finding({ line: 42, reason: "A new wording." })], {
      existing: [
        {
          hash: "a".repeat(40),
          file: "src/billing.ts",
          category: "bug",
          symbol: "",
          reason: "Something completely unrelated.",
          state: "resolved",
          line: 42,
          originalLine: 42,
          side: "RIGHT",
        },
      ],
    });

    expect(result.post).toHaveLength(1);
    expect(result.summary.duplicate).toBe(0);
  });

  it("does not let a comment with an unknown side block a new comment (N5)", () => {
    const result = classify([finding({ line: 42, side: "RIGHT" })], {
      existing: [
        {
          hash: "a".repeat(40),
          file: "src/billing.ts",
          category: "bug",
          symbol: "",
          reason: "Something completely unrelated.",
          state: "open",
          line: 42,
          originalLine: 42,
        },
      ],
    });

    expect(result.post).toHaveLength(1);
    expect(result.summary.duplicate).toBe(0);
  });

  it("keeps an in-pass LEFT and RIGHT finding on the same line apart (N5)", () => {
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      [
        "src/billing.ts",
        new Map<DiffSide, ReadonlySet<number>>([
          ["RIGHT", new Set([42])],
          ["LEFT", new Set([42])],
        ]),
      ],
    ]);
    const result = classifyFindings(
      [
        finding({ line: 42, side: "RIGHT", reason: "The head line is wrong." }),
        finding({ line: 42, side: "LEFT", reason: "The base line is wrong." }),
      ],
      { changedLines: lines },
    );

    expect(result.post.map((comment) => comment.side).sort()).toEqual([
      "LEFT",
      "RIGHT",
    ]);
    expect(result.summary.duplicate).toBe(0);
  });

  it("uses originalLine when the thread is outdated", () => {
    const result = classify([finding({ line: 42, reason: "A reworded null check bug." })], {
      existing: [
        {
          hash: "a".repeat(40),
          file: "src/billing.ts",
          category: "bug",
          symbol: "",
          reason: "Something completely unrelated.",
          state: "open",
          line: null,
          originalLine: 42,
          side: "RIGHT",
        },
      ],
    });

    expect(result.post).toHaveLength(0);
    expect(result.summary.duplicate).toBe(1);
  });

  it("counts findings outside the incremental hunks as out of scope", () => {
    const scope = new Map([
      ["src/billing.ts", [{ side: "RIGHT" as const, start: 40, end: 42 }]],
    ]);
    const inside = classifyFindings([finding({ line: 42 })], {
      changedLines,
      scope,
    });
    expect(inside.post).toHaveLength(1);
    expect(inside.summary.outOfScope).toBe(0);

    const outside = classifyFindings([finding({ line: 43 })], {
      changedLines,
      scope,
    });
    expect(outside.post).toHaveLength(0);
    expect(outside.summary.outOfScope).toBe(1);

    // The scope range's side must match: a RIGHT hunk does not allow a LEFT
    // finding on the same number (N5).
    const bothSides = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      [
        "src/billing.ts",
        new Map<DiffSide, ReadonlySet<number>>([
          ["RIGHT", new Set([42])],
          ["LEFT", new Set([42])],
        ]),
      ],
    ]);
    const wrongSide = classifyFindings(
      [finding({ line: 42, side: "LEFT", reason: "A base-side bug." })],
      { changedLines: bothSides, scope },
    );
    expect(wrongSide.post).toHaveLength(0);
    expect(wrongSide.summary.outOfScope).toBe(1);
  });

  it("dedupes by hash against open, resolved and skipped comments", () => {
    for (const state of ["open", "resolved", "skipped"] as const) {
      const item = finding();
      const hash = findingHash(item);
      const existing: ExistingFinding[] = [
        {
          hash,
          file: item.file,
          category: item.category,
          symbol: "",
          reason: item.reason,
          state,
        },
      ];
      const result = classify([item], { existing });

      expect(result.post, state).toHaveLength(0);
      expect(result.summary.duplicate, state).toBe(1);
    }
  });

  it("dedupes a reworded reason only at or above the Jaccard threshold", () => {
    const shared19 = Array.from({ length: 19 }, (_value, index) => `shared${index}`);
    const alpha = [...shared19, ...Array.from({ length: 6 }, (_v, i) => `alpha${i}`)];
    const beta = [...shared19, ...Array.from({ length: 6 }, (_v, i) => `beta${i}`)];
    const similar = alpha.join(" ");
    const reworded = beta.join(" ");

    expect(reasonSimilarity(similar, reworded)).toBeCloseTo(19 / 31, 6);
    expect(reasonSimilarity(similar, reworded)).toBeGreaterThan(
      REASON_SIMILARITY_THRESHOLD,
    );

    const shared17 = Array.from({ length: 17 }, (_value, index) => `shared${index}`);
    const gamma = [...shared17, ...Array.from({ length: 6 }, (_v, i) => `gamma${i}`)];
    const delta = [...shared17, ...Array.from({ length: 6 }, (_v, i) => `delta${i}`)];
    const below = gamma.join(" ");
    const belowReworded = delta.join(" ");

    expect(reasonSimilarity(below, belowReworded)).toBeCloseTo(17 / 29, 6);
    expect(reasonSimilarity(below, belowReworded)).toBeLessThan(
      REASON_SIMILARITY_THRESHOLD,
    );

    const existing: ExistingFinding[] = [
      {
        hash: findingHash(finding({ reason: similar })),
        file: "src/billing.ts",
        category: "bug",
        symbol: "",
        reason: similar,
        state: "resolved",
      },
    ];

    const atThreshold = classify([finding({ reason: reworded })], { existing });
    expect(atThreshold.post).toHaveLength(0);
    expect(atThreshold.summary.duplicate).toBe(1);

    const belowThreshold = classify([finding({ reason: belowReworded })], {
      existing: [{ ...existing[0]!, reason: below }],
    });
    expect(belowThreshold.post).toHaveLength(1);
    expect(belowThreshold.summary.duplicate).toBe(0);
  });

  it("caps 20 postable findings at 15 and counts the rest, in a stable order", () => {
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      [
        "src/billing.ts",
        new Map<DiffSide, ReadonlySet<number>>([
          ["RIGHT", new Set(Array.from({ length: 20 }, (_value, index) => 100 + index * 4))],
        ]),
      ],
    ]);
    const items = Array.from({ length: 20 }, (_value, index) =>
      finding({
        line: 100 + index * 4,
        reason: `Bug number ${index}`,
        confidence: 0.8 + index * 0.001,
      }),
    );

    const first = classifyFindings(items, { changedLines: lines });
    const second = classifyFindings(items, { changedLines: lines });

    expect(first.post).toHaveLength(MAX_POSTED_COMMENTS);
    expect(first.summary.posted).toBe(MAX_POSTED_COMMENTS);
    expect(first.summary.overCap).toBe(5);
    expect(first.post.map((comment) => comment.reason)).toEqual(
      Array.from({ length: MAX_POSTED_COMMENTS }, (_value, index) => `Bug number ${19 - index}`),
    );
    expect(second.post.map((comment) => comment.hash)).toEqual(
      first.post.map((comment) => comment.hash),
    );
  });

  it("orders by severity before confidence and caps across both", () => {
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      [
        "src/billing.ts",
        new Map<DiffSide, ReadonlySet<number>>([
          [
            "RIGHT",
            new Set([
              ...Array.from({ length: 5 }, (_value, index) => 200 + index * 4),
              ...Array.from({ length: 15 }, (_value, index) => 100 + index * 4),
            ]),
          ],
        ]),
      ],
    ]);
    const medium = Array.from({ length: 5 }, (_value, index) =>
      finding({
        line: 200 + index * 4,
        severity: "medium",
        reason: `Medium ${index}`,
        confidence: 0.99,
      }),
    );
    const high = Array.from({ length: 15 }, (_value, index) =>
      finding({
        line: 100 + index * 4,
        severity: "high",
        reason: `High ${index}`,
        confidence: 0.8,
      }),
    );

    const result = classifyFindings([...medium, ...high], { changedLines: lines });

    expect(result.post).toHaveLength(15);
    expect(result.post.every((comment) => comment.severity === "high")).toBe(true);
    expect(result.summary.overCap).toBe(5);
  });

  it("uses the deterministic symbol for the hash and ignores the model symbol", () => {
    const content = "export function cartOwnerName(order: Order): string {\n  return order.name;\n}";
    const modelA = finding({ line: 2, reason: "Null deref.", symbol: "cartSubtotal" });
    const modelB = finding({ line: 2, reason: "Null deref.", symbol: "" });
    const lineTwo = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/billing.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([2])]])],
    ]);

    const result = classifyFindings([modelA, modelB], {
      changedLines: lineTwo,
      contentFor: () => content,
    });

    expect(result.post).toHaveLength(1);
    expect(result.post[0]?.symbol).toBe("cartOwnerName");
    expect(result.post[0]?.hash).toBe(findingHash(modelA, "cartOwnerName"));
    expect(result.summary.duplicate).toBe(1);
  });

  it("posts same-named methods in different classes instead of deduping them", () => {
    const content = [
      "class A {",
      "  render() {",
      "    bugA();",
      "  }",
      "}",
      "class B {",
      "  render() {",
      "    bugB();",
      "  }",
      "}",
    ].join("\n");
    const renderLines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/render.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([3, 8])]])],
    ]);
    const result = classifyFindings(
      [
        finding({ file: "src/render.ts", line: 3, reason: "Same bug." }),
        finding({ file: "src/render.ts", line: 8, reason: "Same bug." }),
      ],
      { changedLines: renderLines, contentFor: () => content },
    );

    expect(result.post).toHaveLength(2);
    expect(result.summary.duplicate).toBe(0);
    expect(result.post.map((comment) => comment.symbol).sort()).toEqual([
      "A.render",
      "B.render",
    ]);
  });

  it("posts both impl Trait for Type findings instead of deduping them (R2-B1)", () => {
    const content = [
      "impl Display for A {",
      "  fn fmt(&self) {",
      "    bugA();",
      "  }",
      "}",
      "impl Display for B {",
      "  fn fmt(&self) {",
      "    bugB();",
      "  }",
      "}",
    ].join("\n");
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/fmt.rs", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([3, 8])]])],
    ]);
    const result = classifyFindings(
      [
        finding({ file: "src/fmt.rs", line: 3, reason: "Same formatting bug." }),
        finding({ file: "src/fmt.rs", line: 8, reason: "Same formatting bug." }),
      ],
      { changedLines: lines, contentFor: () => content },
    );

    expect(result.post).toHaveLength(2);
    expect(result.summary.duplicate).toBe(0);
    expect(result.post.map((comment) => comment.symbol).sort()).toEqual([
      "A.fmt",
      "B.fmt",
    ]);
  });

  it("does not let an open A.fmt comment swallow a reworded B.fmt finding (R2-B1)", () => {
    const content = [
      "impl Display for A {",
      "  fn fmt(&self) {",
      "    bugA();",
      "  }",
      "}",
      "impl Display for B {",
      "  fn fmt(&self) {",
      "    bugB();",
      "  }",
      "}",
    ].join("\n");
    const existingReason = "Formatting differs from the trait contract.";
    const rewordedReason = "Formatting differs from the trait requirement.";
    expect(reasonSimilarity(existingReason, rewordedReason)).toBeGreaterThanOrEqual(
      REASON_SIMILARITY_THRESHOLD,
    );
    // The existing comment's symbol is what the code under test derives for
    // the A body, not a hardcoded string: the old code derives `Display.fmt`
    // for both bodies, which is exactly the false cross-pass duplicate.
    const symbolA = enclosingSymbol(content, 3);
    const existing: ExistingFinding[] = [
      {
        hash: findingHash(
          finding({ file: "src/fmt.rs", reason: existingReason }),
          symbolA,
        ),
        file: "src/fmt.rs",
        category: "bug",
        symbol: symbolA,
        reason: existingReason,
        state: "open",
      },
    ];
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/fmt.rs", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([8])]])],
    ]);
    const result = classifyFindings(
      [finding({ file: "src/fmt.rs", line: 8, reason: rewordedReason })],
      { changedLines: lines, existing, contentFor: () => content },
    );

    expect(result.post).toHaveLength(1);
    expect(result.post[0]?.symbol).toBe("B.fmt");
    expect(result.summary.duplicate).toBe(0);
  });

  it("posts different Promise<{...}> functions with the same reason (R2-B2)", () => {
    const content = [
      "async function load(): Promise<{ ok: boolean }> {",
      "  bugLoad();",
      "}",
      "",
      "// Second loader.",
      "async function save(): Promise<{ ok: boolean }> {",
      "  bugSave();",
      "}",
    ].join("\n");
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/api.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([2, 7])]])],
    ]);
    const result = classifyFindings(
      [
        finding({ file: "src/api.ts", line: 2, reason: "Same response bug." }),
        finding({ file: "src/api.ts", line: 7, reason: "Same response bug." }),
      ],
      { changedLines: lines, contentFor: () => content },
    );

    expect(result.post).toHaveLength(2);
    expect(result.summary.duplicate).toBe(0);
    expect(result.post.map((comment) => comment.symbol).sort()).toEqual([
      "load",
      "save",
    ]);
  });

  it("ignores dismiss for a category coerced from a misspelling (R2-N1)", () => {
    const misspelled = classify([
      {
        ...finding({
          severity: "medium",
          triage: "dismiss",
          reason: "Spelled the category wrong.",
        }),
        category: "securty",
      },
    ]);

    expect(misspelled.post).toHaveLength(1);
    expect(misspelled.post[0]?.category).toBe("bug");
    expect(misspelled.summary.triageDismissed).toBe(0);

    const realBug = classify([
      finding({
        severity: "medium",
        triage: "dismiss",
        reason: "A real medium bug.",
      }),
    ]);

    expect(realBug.post).toHaveLength(0);
    expect(realBug.summary.triageDismissed).toBe(1);

    const missingSeverity = classify([
      { ...finding({ reason: "No severity at all." }), severity: undefined },
    ]);

    expect(missingSeverity.post).toHaveLength(0);
    expect(missingSeverity.summary.schemaInvalid).toBe(1);
  });

  it("scans a file once per side, not once per finding (R2-N3)", () => {
    const content = [
      "class A {",
      "  render() {",
      "    bugA();",
      "  }",
      "}",
      "class B {",
      "  render() {",
      "    bugB();",
      "  }",
      "}",
      "class C {",
      "  render() {",
      "    bugC();",
      "  }",
      "}",
    ].join("\n");
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/render.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([3, 8, 13])]])],
    ]);
    let contentReads = 0;

    symbolScanStats.scans = 0;
    const result = classifyFindings(
      [
        finding({ file: "src/render.ts", line: 3, reason: "Bug A." }),
        finding({ file: "src/render.ts", line: 8, reason: "Bug B." }),
        finding({ file: "src/render.ts", line: 13, reason: "Bug C." }),
      ],
      {
        changedLines: lines,
        contentFor: () => {
          contentReads += 1;
          return content;
        },
      },
    );

    expect(result.post).toHaveLength(3);
    expect(contentReads).toBe(1);
    expect(symbolScanStats.scans).toBe(1);
  });

  it("skips symbol scanning on 32,000-line Python files and stays under 500 ms each (R2-N3)", () => {
    const flat = Array.from({ length: 32_000 }, () => "def a(").join("\n");
    const nestedLines: string[] = [];
    let indent = 0;
    for (let index = 0; index < 32_000; index += 1) {
      nestedLines.push(`${" ".repeat(indent)}def a${index}():`);
      indent = Math.min(indent + 2, 80);
    }
    const nested = nestedLines.join("\n");

    for (const [name, content] of [
      ["flat", flat],
      ["nested", nested],
    ] as const) {
      const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
        ["src/big.py", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([2])]])],
      ]);
      const started = performance.now();
      const result = classifyFindings(
        [finding({ file: "src/big.py", line: 2, reason: `Big ${name} file.` })],
        {
          changedLines: lines,
          contentFor: () => content,
          hunkContextFor: () => ` hunk ${name} `,
        },
      );
      const elapsed = performance.now() - started;

      expect(elapsed, `${name}: ${elapsed.toFixed(1)}ms`).toBeLessThan(500);
      expect(result.post[0]?.symbol).toBe(`hunk ${name}`);
    }
  });

  it("posts both generic methods with the same reason instead of deduping them (R3-B1)", () => {
    const content = [
      "class Http {",
      "  async get<T>(url: string): Promise<T> {",
      "    bugGet();",
      "  }",
      "",
      "  async post<T>(url: string): Promise<T> {",
      "    bugPost();",
      "  }",
      "}",
    ].join("\n");
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/http.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([3, 7])]])],
    ]);
    const result = classifyFindings(
      [
        finding({ file: "src/http.ts", line: 3, reason: "Same response bug." }),
        finding({ file: "src/http.ts", line: 7, reason: "Same response bug." }),
      ],
      { changedLines: lines, contentFor: () => content },
    );

    expect(result.post).toHaveLength(2);
    expect(result.summary.duplicate).toBe(0);
    expect(result.post.map((comment) => comment.symbol).sort()).toEqual([
      "Http.get",
      "Http.post",
    ]);
  });

  it("posts two generic arrow functions with the same reason (R3-B1)", () => {
    const content = [
      "const fetchA = <T>(url: string): Promise<T> => {",
      "  bugA();",
      "};",
      "",
      "// Second fetcher.",
      "const fetchB = <T>(url: string): Promise<T> => {",
      "  bugB();",
      "};",
    ].join("\n");
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/fetch.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([2, 7])]])],
    ]);
    const result = classifyFindings(
      [
        finding({ file: "src/fetch.ts", line: 2, reason: "Same fetch bug." }),
        finding({ file: "src/fetch.ts", line: 7, reason: "Same fetch bug." }),
      ],
      { changedLines: lines, contentFor: () => content },
    );

    expect(result.post).toHaveLength(2);
    expect(result.summary.duplicate).toBe(0);
    expect(result.post.map((comment) => comment.symbol).sort()).toEqual([
      "fetchA",
      "fetchB",
    ]);
  });

  it("does not let an open Http.get comment swallow a reworded Http.post finding (R3-B1)", () => {
    const content = [
      "class Http {",
      "  async get<T>(url: string): Promise<T> {",
      "    bugGet();",
      "  }",
      "",
      "  async post<T>(url: string): Promise<T> {",
      "    bugPost();",
      "  }",
      "}",
    ].join("\n");
    const existingReason = "Missing error handling when the response is not ok.";
    const rewordedReason = "Missing error handling when the response status is not ok.";
    expect(reasonSimilarity(existingReason, rewordedReason)).toBeGreaterThanOrEqual(
      REASON_SIMILARITY_THRESHOLD,
    );
    const symbolGet = enclosingSymbol(content, 3);
    const existing: ExistingFinding[] = [
      {
        hash: findingHash(finding({ file: "src/http.ts", reason: existingReason }), symbolGet),
        file: "src/http.ts",
        category: "bug",
        symbol: symbolGet,
        reason: existingReason,
        state: "open",
      },
    ];
    const lines = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/http.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([7])]])],
    ]);
    const result = classifyFindings(
      [finding({ file: "src/http.ts", line: 7, reason: rewordedReason })],
      { changedLines: lines, existing, contentFor: () => content },
    );

    expect(result.post).toHaveLength(1);
    expect(result.post[0]?.symbol).toBe("Http.post");
    expect(result.summary.duplicate).toBe(0);
  });

  it("classifies 300 findings on a 19,000-deep file in under 1 s (R3-N3)", () => {
    const depth = 19_000;
    const lines: string[] = [];
    for (let index = 0; index < depth; index += 1) {
      lines.push(`function f${index}() {`);
    }
    const bugLine = lines.length + 1;
    lines.push("  bug();");
    const content = lines.join("\n");
    const changedLinesNested = new Map<string, ReadonlyMap<DiffSide, ReadonlySet<number>>>([
      ["src/deep.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", new Set([bugLine])]])],
    ]);
    const items = Array.from({ length: 300 }, (_value, index) =>
      finding({ file: "src/deep.ts", line: bugLine, reason: `Deep bug number ${index}.` }),
    );

    symbolScanStats.scans = 0;
    const started = performance.now();
    const result = classifyFindings(items, {
      changedLines: changedLinesNested,
      contentFor: () => content,
    });
    const elapsed = performance.now() - started;

    expect(elapsed, `${elapsed.toFixed(1)}ms`).toBeLessThan(1_000);
    expect(symbolScanStats.scans).toBe(1);
    // 300 differently worded findings on one line share a location, so the
    // step 8c location rule keeps the first and counts the other 299.
    expect(result.summary.posted).toBe(1);
    expect(result.summary.duplicate).toBe(299);
    expect(result.summary.overCap).toBe(0);
    expect(result.post.length).toBeGreaterThan(0);
    for (const comment of result.post) {
      expect(comment.symbol.split(".").length).toBeLessThanOrEqual(MAX_SYMBOL_NAME_DEPTH);
    }
  });

  it("dedupes at exactly 0.6 Jaccard, and not at 0.59 or 0.61", () => {
    const existingFor = (reason: string): ExistingFinding[] => [
      {
        hash: findingHash(finding({ reason })),
        file: "src/billing.ts",
        category: "bug",
        symbol: "",
        reason,
        state: "resolved",
      },
    ];

    const shared = ["shared0", "shared1", "shared2"];
    const atA = [...shared, "alpha0"].join(" ");
    const atB = [...shared, "beta0"].join(" ");
    expect(reasonSimilarity(atA, atB)).toBeCloseTo(0.6, 10);
    const exact = classify([finding({ reason: atB })], { existing: existingFor(atA) });
    expect(exact.post).toHaveLength(0);
    expect(exact.summary.duplicate).toBe(1);

    const shared59 = Array.from({ length: 59 }, (_value, index) => `s${index}`);
    const belowA = [
      ...shared59,
      ...Array.from({ length: 41 }, (_value, index) => `a${index}`),
    ].join(" ");
    const belowB = shared59.join(" ");
    expect(reasonSimilarity(belowA, belowB)).toBeCloseTo(0.59, 10);
    const below = classify([finding({ reason: belowB })], {
      existing: existingFor(belowA),
    });
    expect(below.post).toHaveLength(1);
    expect(below.summary.duplicate).toBe(0);

    const shared61 = Array.from({ length: 61 }, (_value, index) => `t${index}`);
    const aboveA = [
      ...shared61,
      ...Array.from({ length: 39 }, (_value, index) => `b${index}`),
    ].join(" ");
    const aboveB = shared61.join(" ");
    expect(reasonSimilarity(aboveA, aboveB)).toBeCloseTo(0.61, 10);
    const above = classify([finding({ reason: aboveB })], {
      existing: existingFor(aboveA),
    });
    expect(above.post).toHaveLength(0);
    expect(above.summary.duplicate).toBe(1);
  });

  it("counts schema-invalid findings so the buckets sum to the input", () => {
    const items: unknown[] = [
      finding({ reason: "Dup bug." }),
      finding({ reason: "Dup bug." }),
      finding({ reason: "Extra bug." }),
      finding({ confidence: 0.5 }),
      finding({ severity: "low", confidence: 1 }),
      finding({ line: 99 }),
      finding({ severity: "medium", triage: "dismiss", reason: "Medium dismiss." }),
      { ...finding(), severity: "critical" },
      { ...finding(), reason: "!!!" },
      { ...finding(), file: "" },
    ];
    const result = classify(items);

    expect(result.summary).toMatchObject({
      posted: 1,
      belowConfidence: 1,
      lowSeverity: 1,
      notInDiff: 1,
      triageDismissed: 1,
      duplicate: 2,
      overCap: 0,
      schemaInvalid: 3,
    });
    expect(
      Object.values(result.summary).reduce((total, value) => total + value, 0),
    ).toBe(items.length);
  });

  it("picks the same lower line for an equal-confidence duplicate in either order", () => {
    const lower = finding({ line: 43, confidence: 0.9, reason: "Same bug." });
    const higher = finding({ line: 50, confidence: 0.9, reason: "Same bug." });

    for (const items of [
      [higher, lower],
      [lower, higher],
    ]) {
      const result = classify(items);
      expect(result.post).toHaveLength(1);
      expect(result.post[0]?.line).toBe(43);
      expect(result.summary.duplicate).toBe(1);
    }

    const withEnd = finding({
      line: 43,
      end_line: 43,
      confidence: 0.9,
      reason: "End bug.",
    });
    const withoutEnd = finding({ line: 43, confidence: 0.9, reason: "End bug." });
    for (const items of [
      [withoutEnd, withEnd],
      [withEnd, withoutEnd],
    ]) {
      const result = classify(items);
      expect(result.post).toHaveLength(1);
      expect(result.post[0]?.endLine).toBe(43);
    }
  });
});

describe("formatComment", () => {
  function planned(overrides: Partial<Finding> = {}): PlannedComment {
    const result = classifyFindings([finding(overrides)], { changedLines });
    const comment = result.post[0];
    if (comment === undefined) {
      throw new Error("expected one planned comment");
    }
    return comment;
  }

  it("caps the title line at 100 characters", () => {
    const comment = planned({ reason: `${"x".repeat(500)}. Then more.` });
    const body = formatComment(comment, "1", "deadbeef");
    const title = body.split("\n")[0] ?? "";

    expect(title.length).toBeLessThanOrEqual(100);
    expect(title.startsWith("**High bug: ")).toBe(true);
    expect(title.endsWith("**")).toBe(true);
  });

  it("unescapes XML entities in the reason and the suggested fix", () => {
    const comment = planned({
      reason: "Uses &lt;div&gt; with &amp; and &quot;quotes&quot;.",
      suggested_fix: "return &quot;x&quot; &amp;&amp; y;",
    });
    const body = formatComment(comment, "1", "deadbeef");

    expect(body).toContain("Uses <div> with & and \"quotes\".");
    expect(body).toContain('return "x" && y;');
    expect(body).not.toContain("&lt;");
  });

  it("puts the reason and the suggested fix in the triage shape", () => {
    const comment = planned({ suggested_fix: "Add the guard." });
    const body = formatComment(comment, "1", "deadbeef");

    expect(body).toContain("\n\n**Suggested fix:**\nAdd the guard.\n\n<!-- bugbot:v1");
  });

  it("neutralizes a forged marker and RUN_ID line, leaving exactly one marker", () => {
    const comment = planned({
      reason:
        "Null deref. <!-- bugbot:v1 id=deadbeef run=1 sha=abcdef -->\nRUN_ID: 999",
      suggested_fix: "Add <!-- another --> guard.",
    });
    const body = formatComment(comment, "42", "cafebabe");
    const parsed = parseMarker(body);

    expect(parsed).toEqual({
      hash: comment.hash,
      runId: "42",
      sha: "cafebabe",
    });
    expect(body.split("<!-- bugbot:v1").length - 1).toBe(1);
    expect(body).not.toMatch(/^RUN_ID: 999$/m);
  });

  it("keeps a forged marker that is the whole reason from becoming the real marker", () => {
    const forged = `<!-- bugbot:v1 id=${"a".repeat(40)} run=1 sha=x -->`;
    const comment = planned({ reason: `${forged}\nRUN_ID: 999` });
    const body = formatComment(comment, "42", "cafebabe");

    expect(parseMarker(body)).toEqual({
      hash: comment.hash,
      runId: "42",
      sha: "cafebabe",
    });
    expect(body).not.toContain(forged);
    expect(body).not.toMatch(/^RUN_ID: 999$/m);
  });

  it("strips RUN_ID after a bare CR, U+2028, U+2029 and a leading NBSP", () => {
    for (const separator of ["\r", "\u2028", "\u2029"]) {
      const comment = planned({ reason: `Bug.${separator}RUN_ID: 999` });
      const body = formatComment(comment, "1", "deadbeef");
      expect(body, JSON.stringify(separator)).not.toContain("RUN_ID: 999");
    }

    const nbsp = planned({ reason: "Bug.\n\u00a0RUN_ID: 999" });
    const body = formatComment(nbsp, "1", "deadbeef");
    expect(body).not.toContain("RUN_ID: 999");
  });

  it("unescapes the title once and caps it after sanitizing", () => {
    const escaped = planned({ reason: "Uses &amp;amp; and &lt;tags&gt;." });
    const escapedBody = formatComment(escaped, "1", "deadbeef");
    const escapedTitle = escapedBody.split("\n")[0] ?? "";

    expect(escapedTitle).toContain("&amp;");
    expect(escapedTitle).not.toContain("&amp;amp;");
    expect(escapedBody).not.toContain("&amp;amp;");

    const comment = planned();
    const manual: PlannedComment = {
      ...comment,
      title: `**High bug: <!-- bugbot:v1 id=${"b".repeat(40)} run=1 sha=x --> ${"y".repeat(200)}**`,
    };
    const manualBody = formatComment(manual, "1", "deadbeef");
    const manualTitle = manualBody.split("\n")[0] ?? "";

    expect(manualTitle.length).toBeLessThanOrEqual(100);
    expect(manualTitle).not.toContain("<!--");
    expect(parseMarker(manualBody)).toEqual({
      hash: manual.hash,
      runId: "1",
      sha: "deadbeef",
    });
  });

  it("rejects a malformed runId or sha instead of breaking the marker", () => {
    const comment = planned();

    expect(() => formatComment(comment, "1a", "deadbeef")).toThrow(/runId/);
    expect(() => formatComment(comment, "", "deadbeef")).toThrow(/runId/);
    expect(() => formatComment(comment, "1", "xyz")).toThrow(/headSha/);
    expect(() => formatComment(comment, "1", "abcdef")).toThrow(/headSha/);
    expect(() => formatComment(comment, "1", "a".repeat(41))).toThrow(/headSha/);
  });

  it("caps the visible body at 4000 characters before the marker", () => {
    const comment = planned({ reason: "a".repeat(6_000) });
    const body = formatComment(comment, "1", "deadbeef");
    const realMarker = marker(comment.hash, "1", "deadbeef");
    const markerIndex = body.lastIndexOf(realMarker);

    expect(markerIndex).toBeGreaterThan(0);
    expect(body.slice(0, markerIndex - 2).length).toBeLessThanOrEqual(
      MAX_COMMENT_BODY,
    );
    expect(body.endsWith(realMarker)).toBe(true);
  });

  it("keeps the title helper bounded independently", () => {
    expect(commentTitle("high", "security", "X".repeat(300)).length).toBeLessThanOrEqual(
      100,
    );
  });
});

describe("parseMarker", () => {
  it("round-trips with formatComment", () => {
    const result = classifyFindings([finding()], { changedLines });
    const comment = result.post[0];
    if (comment === undefined) {
      throw new Error("expected one planned comment");
    }

    const body = formatComment(comment, "987654321", "abcdef1234567890");
    expect(parseMarker(body)).toEqual({
      hash: comment.hash,
      runId: "987654321",
      sha: "abcdef1234567890",
    });
  });

  it("rejects malformed markers and markers that are not on their own line", () => {
    expect(parseMarker("")).toBeNull();
    expect(parseMarker("RUN_ID: 1")).toBeNull();
    expect(parseMarker("<!-- bugbot:v1 id=abc123 run=1 -->")).toBeNull();
    expect(parseMarker("see <!-- bugbot:v1 id=abc123 run=1 sha=x --> here")).toBeNull();
    expect(parseMarker("<!-- bugbot:v1 id=zzz run=1 sha=x -->")).toBeNull();
    expect(parseMarker("<!-- bugbot:v1 id=abc123 run=1 sha=x --> extra")).toBeNull();
  });

  it("requires a full 40-hex id", () => {
    expect(
      parseMarker(`<!-- bugbot:v1 id=${"a".repeat(39)} run=1 sha=x -->`),
    ).toBeNull();
    expect(
      parseMarker(`<!-- bugbot:v1 id=${"a".repeat(41)} run=1 sha=x -->`),
    ).toBeNull();
    expect(
      parseMarker(`<!-- bugbot:v1 id=${"a".repeat(40)} run=1 sha=x -->`),
    ).toEqual({ hash: "a".repeat(40), runId: "1", sha: "x" });
  });
});

describe("step 8c identifier scans (S8D-R2-N1)", () => {
  it("classifies the reviewer's 60 x 60 case on 390 KB lines under a second", () => {
    const lines = Array.from(
      { length: 40 },
      (_value, index) => `${minifiedLine()}${index}`,
    );
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- /dev/null",
      "+++ b/src/a.ts",
      "@@ -0,0 +1,40 @@",
      ...lines.map((line) => `+${line}`),
      "",
    ].join("\n");
    const lineTextFor = diffLineTexts(diff);
    const allLines = new Set(lines.map((_line, index) => index + 1));
    const linesByFile = new Map<
      string,
      ReadonlyMap<DiffSide, ReadonlySet<number>>
    >([["src/a.ts", new Map<DiffSide, ReadonlySet<number>>([["RIGHT", allLines]])]]);
    const existing: ExistingFinding[] = Array.from({ length: 60 }, (_, index) => ({
      hash: String(index).padStart(40, "0"),
      file: "src/a.ts",
      category: "bug",
      symbol: "",
      reason: `Existing reason number ${index} about the first thing.`,
      state: "open",
      line: 1 + (index % 20),
      originalLine: 1 + (index % 20),
      side: "RIGHT",
    }));
    const candidates = Array.from({ length: 60 }, (_, index) =>
      finding({
        file: "src/a.ts",
        line: 21 + (index % 20),
        reason: `Candidate reason number ${index} about a different thing entirely.`,
        symbol: "s",
      }),
    );

    const started = performance.now();
    const result = classifyFindings(candidates, {
      changedLines: linesByFile,
      existing,
      lineTextFor,
    });
    const elapsed = performance.now() - started;

    expect(result.summary.posted).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});
