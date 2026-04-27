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

  // Internal node
  let result = `${prefix}${label}`;

  // Leaf node
  if (typeof value === "string") {
    result += ` "${value}"`;
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      result += "\n" + generateTreeOutput(child, null, indent + 1);
    }
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
  return Math.max(0, length, ...children.map(calculateMaxSpanWidth));
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
 * @param error
 */
export function generateTraceOutput(
  input: string,
  trace: TraceElement,
  error: Error | null,
): { text: string; spans: Range[]; errors: Range[]; captures: Range[] } {
  let text = "";
  // These ranges store indexes of start..end into the returned text for highlighting
  const errors: Range[] = [];
  const spans: Range[] = [];
  const captures: Range[] = [];
  let lastLiteralRange: Range | null = null;
  let depth = 0;

  const spanWidth = calculateMaxSpanWidth(trace);

  function outputLine(
    start: number,
    depth: number,
    spanStart: number,
    spanEnd: number,
    literal: string,
    rule?: string,
    success: boolean = true,
  ) {
    if (!success && spanStart === spanEnd) {
      return "";
    }

    const span = formatCentered(spanStart, spanEnd, spanWidth) + " ";
    const verticalLines = "│ ".repeat(depth);
    const escapedLiteral = escapeTraceInput(literal);
    const ruleSubstitute = rule ? `${rule} ` : "";
    const literalRange = {
      start: start + span.length + verticalLines.length + ruleSubstitute.length,
      end:
        start +
        span.length +
        verticalLines.length +
        ruleSubstitute.length +
        escapedLiteral.length,
    };
    captures.push(literalRange);
    lastLiteralRange = literalRange;
    spans.push({
      start,
      end: start + spanWidth,
    });

    if (!success && rule) {
      errors.push({
        start: start + span.length + verticalLines.length,
        end: start + span.length + verticalLines.length + rule.length - 1,
      });
    }

    return `${span}${verticalLines}${ruleSubstitute}${escapedLiteral}\n`;
  }

  function buildOutput({ rule, success, start, end, children }: TraceElement) {
    // Skip successful anonymous rules
    if (success && rule[0] === "_") {
      return "";
    }

    // Output the rule line itself.
    const literal = input.substring(start, end);
    text += outputLine(text.length, depth, start, end, literal, rule, success);

    const visibleChildren = children.filter(
      (child: TraceElement) => !(child.success && child.rule[0] === "_"),
    );

    if (visibleChildren.length > 0) {
      let childStart = start;
      depth++;

      for (const child of visibleChildren) {
        if (child.start > childStart) {
          const childGap = input.slice(childStart, child.start);
          text += outputLine(
            text.length,
            depth,
            childStart,
            child.start,
            childGap,
          );
        }

        buildOutput(child);
        childStart = child.end;
      }

      if (childStart < end) {
        const trailingChildGap = input.slice(childStart, end);
        text += outputLine(
          text.length,
          depth,
          childStart,
          end,
          trailingChildGap,
        );
      }

      depth--;
    }
  }

  if (trace.start > 0) {
    text += outputLine(text.length, depth, 0, trace.start, input.slice(0, trace.start));
  }

  buildOutput(trace);

  // trailing literal
  if (trace.end < input.length) {
    const literal = input.substring(trace.end);
    text += outputLine(text.length, depth + 1, trace.end, input.length, literal);
  }

  if (error) {
    // if there's an error, highlight the last literal, as though it's not an error node, it's probably relevant
    if (lastLiteralRange) {
      errors.push(lastLiteralRange);
    }
    text += "\n\n" + printError(error);
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
