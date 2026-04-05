import type { Exp, TraceHistory, TraceElement } from "ppegjs/pPEG.mjs";

type GrammarCompileError = {
  type?: string;
  message?: string;
  line?: number;
  column?: number;
  fault_rule?: string;
  expected?: unknown;
  found?: unknown;
  location?: string;
  rule?: string;
};

type GrammarCompileFailure = {
  ok: false;
  error?: GrammarCompileError;
  rules?: string[];
  trace_history?: TraceHistory;
};

type Error = {
  column: number;
  line: number;
  message: string;
  type: string;
};

export type Range = {
  start: number;
  end: number;
};

export type TraceOptions = { showAnonymous: boolean; showEmpty: boolean };

export function generateTreeOutput(
  tree: Exp | string,
  error: Error | null,
  indent = 0,
): string {
  const prefix = "│ ".repeat(indent);
  const [label, value] = tree;

  // Leaf node
  if (typeof value === "string") {
    return `${prefix}${label} "${value}"`;
  }

  // Internal node
  let result = `${prefix}${label}`;

  for (const child of value) {
    result += "\n" + generateTreeOutput(child, null, indent + 1);
  }

  if (error) {
    result += "\n\n" + printError(error);
  }

  return result;
}

function printError(error: Error) {
  return (
    "Error '" +
    error.type +
    "' at line " +
    error.line +
    ", column " +
    error.column +
    ":\n" +
    error.message
  );
}

const SPAN_SEPARATOR = "..";

/**
 * We display spans of each trace like this:
 * 0..6
 * 0..1
 * 10..11
 * The UI needs to know the maximum columns for these lines.
 */
function calculateMaxSpanWidth({ start, end, children }: TraceElement) {
  const length = `${start}${SPAN_SEPARATOR}${end}`.length;
  return Math.max(0, length, ...children.map(calculateMaxSpanWidth))
}

const formatCentered = (
  left: string | number,
  right: string | number,
  width: number,
) => {
  const l = String(left);
  const r = String(right);

  const sepStart = Math.floor((width - SPAN_SEPARATOR.length) / 2);

  const leftWidth = sepStart;
  const rightWidth = width - sepStart - SPAN_SEPARATOR.length;

  return (
    l.padStart(leftWidth, " ") + SPAN_SEPARATOR + r.padEnd(rightWidth, " ")
  );
};

/**
 * Generates a tree diagram of the trace output, with a row for every node,
 * while also adding rows for anonymous matches and appending error information
 * @param input - string input to parser
 * @param rules - array of rules, which will be indexed into upon failed rules
 * @param trace - trace history
 * @param { showEmpty, showAnonymous} - limit possibly unwanted output
 * @param error
 */
export function generateTraceOutput(
  input: string,
  trace: TraceElement,
  error: Error | null
): { text: string; spans: Range[]; errors: Range[]; captures: Range[] } {
  let text = "";
  const errors: Range[] = [];
  const spans: Range[] = [];
  const captures: Range[] = [];
  let previousEnd = 0;
  let depth = 0;

  const spanWidth = calculateMaxSpanWidth(trace);

  function buildOutput({ rule, success, start, end, children }: TraceElement) {
    // Skip successful anonymous rules
    if (success && rule[0] === "_") {
      return "";
    }

    // Output literals
    if (start > previousEnd) {
      const literal = input.slice(previousEnd, start);
      const span = formatCentered(previousEnd, start, spanWidth) + " ";
      spans.push({ start: text.length, end: text.length + spanWidth });
      const prefix = "│ ".repeat(depth);
      text += `${span}${prefix}`;
      const escapedLiteral = escapeTraceInput(literal);
      captures.push({
        start: text.length,
        end: text.length + escapedLiteral.length,
      });
      text += escapedLiteral + "\n"
    }
    previousEnd = end;

    // Output '0..10'
    spans.push({ start: text.length, end: text.length + spanWidth });
    text += formatCentered(start, end, spanWidth) + " ";

    // Output leading lines
    const prefix = "│ ".repeat(depth);
    const escapedInput = escapeTraceInput(input.substring(start, end));
    let line = `${prefix}${rule} `;
    captures.push({
      start: text.length + line.length,
      end: text.length + line.length + escapedInput.length,
    });
    line += escapedInput;
    const lineStart = text.length;
    text += line;

    if (!success) {
      const start = lineStart + prefix.length;
      const end = lineStart + prefix.length + rule.length - 1;
      errors.push({ start, end });
    }

    text += "\n";

    depth++;
    children.map(buildOutput);
    depth--;
  }

  buildOutput(trace)

  if (error?.type === "incomplete_parse") {
    const remainder = input.slice(previousEnd, input.length)
    text += " ".repeat(spanWidth) + "..."
    errors.push({start: text.length, end: text.length + remainder.length})
    text += remainder
  }

  if (error) {
    text += "\n\n" + printError(error)
  }

  return { text, errors, spans, captures };
}

function escapeTraceInput(value: string): string {
  return value.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t");
}

export function generateGrammarCompileErrorOutput(
  grammarText: string,
  compiled: GrammarCompileFailure,
): {
  text: string;
  highlights: Range[];
} {
  const error = compiled.error ?? {};
  const message = error.message ?? "Unknown grammar compile error.";
  const lines: string[] = [
    "Grammar compile error",
    `${error.type}: ${message}`,
  ];
  const highlights: Range[] = [];

  if (error.fault_rule) lines.push(`Fault rule: ${error.fault_rule}`);
  if (typeof error.rule === "string" && error.rule.length > 0) {
    lines.push(`In rule: ${error.rule}`);
    const ruleRange = findRuleDefinitionRange(grammarText, error.rule);
    if (ruleRange) {
      highlights.push(ruleRange);
    }
  }

  if (error.column && error.line) {
    lines.push(`Location: Line ${error.line}, col ${error.column}`);
    const offset = extractOffsetFromLineColumn(
      grammarText,
      error.line,
      error.column,
    );
    highlights.push({ start: offset, end: offset });
  }

  const text = lines.join("\n");

  return { text, highlights };
}

/**
 * Find the error in a TraceHistory most likely to be at fault for bad input
 * Returns { start, end } or null if none.
 */
export function findError(
  trace: TraceHistory,
  inputLength: number,
  inputText: string,
): { end: number; start: number } | null {
  // In incomplete parses, the top-level rule succeeds but leaves trailing
  // input. Highlight the remaining suffix directly.
  const trailing = findTrailingInput(trace, inputLength);
  if (trailing) return trailing;

  let best: {
    start: number;
    end: number;
    depth: number;
  } | null = null;

  for (const e of splitTraces(trace)) {
    if (e.ok) continue;
    if (!best) {
      best = e;
      continue;
    }
    // prefer further end
    if (e.end > best.end) {
      best = e;
      continue;
    }
    // on a tie, prefer deeper
    if (e.end === best.end && e.depth > best.depth) {
      best = e;
    }
  }

  if (!best) return null;
  const pos = best.end;
  return expandTokenFromPos(inputText, pos);
}

function findTrailingInput(
  trace: TraceHistory,
  inputLength: number,
): Range | null {
  let topLevelEnd = -1;
  for (let i = 0; i < trace.length; i += 4) {
    const ruleId = trace[i];
    const depth = trace[i + 1];
    const end = trace[i + 3];
    if (ruleId >= 0 && depth === 0 && end > topLevelEnd) {
      topLevelEnd = end;
    }
  }

  if (topLevelEnd < 0 || topLevelEnd >= inputLength) return null;
  return { start: topLevelEnd, end: inputLength - 1 };
}

function splitTraces(
  trace: TraceHistory,
): { ok: boolean; depth: number; start: number; end: number }[] {
  const result: {
    ok: boolean;
    depth: number;
    start: number;
    end: number;
  }[] = [];
  for (let i = 0; i < trace.length; i += 4) {
    result.push({
      ok: trace[i] >= 0,
      depth: trace[i + 1],
      start: trace[i + 2],
      end: trace[i + 3],
    });
  }
  return result;
}

function extractOffsetFromLineColumn(
  inputText: string,
  line: number,
  column: number,
): number {
  const targetLine = Math.max(1, line);
  const targetColumn = Math.max(1, column);

  let currentLine = 1;
  let i = 0;
  while (i < inputText.length && currentLine < targetLine) {
    if (inputText[i] === "\n") {
      currentLine += 1;
    }
    i += 1;
  }
  return Math.max(0, Math.min(i + targetColumn - 1, inputText.length));
}

function findRuleDefinitionRange(
  grammarText: string,
  ruleName: string,
): { start: number; end: number } | null {
  if (!ruleName) return null;

  const escapedRuleName = escapeRegExp(ruleName);
  const pattern = new RegExp(
    `(^|\\r?\\n)([ \\t]*)(${escapedRuleName})([ \\t]*)=`,
    "m",
  );
  const match = pattern.exec(grammarText);
  if (!match) {
    return null;
  }

  const prefix = match[1] ?? "";
  const indentation = match[2] ?? "";
  const name = match[3] ?? ruleName;
  const start = match.index + prefix.length + indentation.length;
  const end = start + Math.max(0, name.length - 1);
  return { start, end };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Do the best we can to try to guess the length of the "bad" token.
// This is hackish... but I think the experience is OK.
// An alternative would be not expanding, and just highlighting the first bad
// token.
function expandTokenFromPos(
  inputText: string,
  pos: number,
): { start: number; end: number } {
  if (pos < 0 || pos >= inputText.length) return { start: pos, end: pos };
  if (inputText[pos] == "\n" || inputText[pos] == "\r") {
    // newline? try to highlight char before to after
    return {
      start: Math.max(0, pos - 1),
      end: Math.min(inputText.length, pos + 1),
    };
  }
  if (!isTokenChar(inputText[pos])) return { start: pos, end: pos };

  let end = pos;
  while (end + 1 < inputText.length && isTokenChar(inputText[end + 1])) {
    end += 1;
  }
  return { start: pos, end };
}

function isTokenChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

export function highlight(
  element: HTMLElement,
  ranges: Range[],
  highlightName: string,
) {
  const textNode = element.firstChild;
  if (!CSS.highlights || textNode?.nodeType !== Node.TEXT_NODE) {
    return;
  } else if (!element.id) {
    console.warn("No id element on " + element + "; will skip highlighting");
  }

  const text = element.textContent ?? "";

  const highlight = new Highlight();

  for (const error of ranges) {
    const range = {
      start: Math.max(0, error.start),
      end: Math.max(0, error.end),
    };
    if (range.end < range.start) {
      return;
    }

    const start = Math.min(range.start, text.length);
    const endExclusive = Math.min(range.end + 1, text.length);

    if (start < text.length && endExclusive > start) {
      const domRange = document.createRange();
      domRange.setStart(textNode, start);
      domRange.setEnd(textNode, endExclusive);
      highlight.add(domRange);
    }
  }

  CSS.highlights.set(highlightName, highlight);
}
