import assert from "node:assert/strict";
import test from "node:test";

import { compile } from "ppegjs";
import {
  findError,
  generateGrammarCompileErrorOutput,
  generateTraceOutput,
  generateTreeOutput,
} from "../src/lib/generate-output.ts";

const jsonGrammar = String.raw`
json   = _ value _
value  =  Str / Arr / Obj / num / lit
Obj    = '{'_ (memb (_','_ memb)*)? _'}'
memb   = Str _':'_ value
Arr    = '['_ (value (_','_ value)*)? _']'
Str    = '"' chars* '"'
chars  = ~[\u0000-\u001F"\]+ / '\' esc
esc    = ["\/bfnrt] / 'u' [0-9a-fA-F]*4
num    = _int _frac? _exp?
_int   = '-'? ([1-9] [0-9]* / '0')
_frac  = '.' [0-9]+
_exp   = [eE] [+-]? [0-9]+
lit    = 'true' / 'false' / 'null'
_      = [ \t\n\r]*
`;

test("findError highlights the inner array error for the malformed JSON example", () => {
  const input = `{
    "answer": 42,
    "mixed": [,
}`;

  const parser = compile(jsonGrammar);
  assert.equal(parser.ok, true);

  const parsed = parser.parse(input);
  assert.equal(parsed.ok, false);
  const badComma = input.indexOf(",", input.indexOf("["));
  assert.equal(parsed.max_pos, badComma);
  assert.deepEqual(parsed.expected, ["quote", "]", false]);

  const errorRange = findError(parsed.trace, input.length, input);
  assert.deepEqual(errorRange, {
    start: badComma,
    end: badComma,
  });
  assert.equal(input.slice(errorRange.start, errorRange.end + 1), ",");
});

test("findError still highlights unconsumed suffixes after successful top-level parses", () => {
  const parser = compile("start = 'a'");
  assert.equal(parser.ok, true);

  const input = "ab";
  const parsed = parser.parse(input);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.fell_short, true);

  assert.deepEqual(findError(parsed.trace, input.length, input), {
    start: 1,
    end: 1,
  });
});

test("generateTraceOutput renders rule names instead of numeric ids", () => {
  const parser = compile(`
date = year '-' month '-' day
year =: [0-9]*4
month =: [0-9]*2
day =: [0-9]*2
`);
  assert.equal(parser.ok, true);

  const parsed = parser.parse("2021-02-03");
  assert.equal(parsed.ok, true);

  assert.equal(
    generateTraceOutput(parsed).text,
    [
      "0..10 date 2021-02-03",
      "0..4  │ year 2021",
      "4..5  │ -",
      "5..7  │ month 02",
      "7..8  │ -",
      "8..10 │ day 03",
      "",
    ].join("\n"),
  );
});

test("generateTreeOutput formats structured parse errors", () => {
  const parser = compile(`
date = year '-' month '-' day
year =: [0-9]*4
month =: [0-9]*2
day =: [0-9]*2
`);
  const parsed = parser.parse("2021-02-0d");

  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.errors(), {
    kind: "parse",
    offset: 9,
    end: 10,
    location: {
      offset: 9,
      line: 1,
      column: 10,
      lineStart: 0,
      lineEnd: 10,
      lineText: "2021-02-0d",
    },
    fellShort: false,
    rule: "day",
  });
  assert.match(
    generateTreeOutput(parsed).text,
    /\*\*\* parse failed at: 9 of: 10\nline 1 \| 2021-02-0d\n                  \^ failed/,
  );
  const output = generateTreeOutput(parsed);
  assert.deepEqual(
    output.errors.map((range) => output.text.slice(range.start, range.end + 1)),
    ["d"],
  );
});

test("generateTraceOutput highlights appended parse errors at the shifted output position", () => {
  const parser = compile(`
date = year '-' month '-' day
year =: [0-9]*4
month =: [0-9]*2
day =: [0-9]*2
`);
  const parsed = parser.parse("2021-02-0d");

  assert.equal(parsed.ok, false);
  const output = generateTraceOutput(parsed);
  assert.equal(output.text.includes("*** parse failed at: 9 of: 10"), true);
  assert.deepEqual(
    output.errors.map((range) => output.text.slice(range.start, range.end + 1)),
    ["date", "day", "d", "d"],
  );
});

test("generateGrammarCompileErrorOutput formats thrown compile errors", () => {
  let compileError: unknown = null;
  try {
    compile("date = ");
  } catch (error) {
    compileError = error;
  }

  const output = generateGrammarCompileErrorOutput(
    "date = ",
    compileError as Parameters<typeof generateGrammarCompileErrorOutput>[1],
  );

  assert.deepEqual(output.highlights, [{ start: 7, end: 7 }]);
  assert.match(output.text, /Grammar compile error/);
  assert.match(output.text, /\*\*\* parse failed at: 7 of: 7/);
  assert.match(output.text, /failed, expected: alt/);
});
