import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");

function load(relativePath) {
  const filename = path.join(root, ...relativePath.split(/[\\/]/));
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const loaded = new Module(filename);
  loaded.require = nodeRequire;
  loaded._compile(compiled.outputText, filename);
  return loaded.exports;
}

const dates = load("src/lib/dates.ts");

test("current month follows Dhaka local time, not UTC", () => {
  // 01:00 on Nov 1 in Dhaka is still Oct 31 in UTC.
  assert.equal(dates.currentMonthYear(new Date("2026-10-31T19:00:00Z")), "2026-11");
  assert.equal(dates.currentMonthYear(new Date("2026-10-31T17:59:59Z")), "2026-10");
  assert.equal(dates.currentMonthYear(new Date("2026-12-31T18:00:00Z")), "2027-01");
});

test("explicit transaction dates must fall inside the month", () => {
  const ok = dates.resolveTransactionDate("2026-07", "2026-07-15");
  assert.equal(ok.ok, true);
  assert.equal(ok.date.toISOString(), "2026-07-15T12:00:00.000Z");
  assert.equal(dates.resolveTransactionDate("2026-07", "2026-08-01").ok, false);
});

test("past months default to their last day", () => {
  const r = dates.resolveTransactionDate("2020-02");
  assert.equal(r.ok, true);
  assert.equal(r.date.toISOString(), "2020-02-29T23:59:59.999Z");
});
