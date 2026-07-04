import type {
  Code,
  CodeError,
  Expected,
  Node,
  Parse,
  ParseError,
  PtreeNode,
  RuntimeExpr,
} from "ppegjs/pPEG.js";

export type Range = {
  start: number;
  end: number;
};

export type TraceOptions = { showAnonymous: boolean; showEmpty: boolean };

export function generateTreeOutput(parse: Parse): {
  text: string;
  errors: Range[];
} {
  return generateTreeNodeOutput(
    parse.ptree(),
    parse.ok ? null : formatParseError(parse.errors()),
  );
}

function generateTreeNodeOutput(
  ptree: PtreeNode | [],
  parseErrorText: string | null = null,
  indent = 0,
): { text: string; errors: Range[] } {
  const errors: Range[] = [];

  if (ptree.length === 0) {
    return { errors, text: parseErrorText ?? "" };
  }

  const prefix = "│ ".repeat(indent);
  const [label, value] = ptree;

  // Internal node
  let result = `${prefix}${label}`;

  // Leaf node
  if (typeof value === "string") {
    result += ` ${JSON.stringify(value)}`;
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      const recursion = generateTreeNodeOutput(child, null, indent + 1);
      errors.push(...recursion.errors);
      result += "\n" + recursion.text;
    }
  }

  if (parseErrorText && indent === 0) {
    result += "\n\n" + parseErrorText;
  }

  return { errors, text: result };
}

const SPAN_SEPARATOR = "..";
const TRACE_FAIL = 0x2000;
const TRACE_DROP = 0x1000;
const LEGACY_TRACE_FAIL = 1;
const LEGACY_TRACE_DROP = 2;
const LEGACY_TRACE_RULE_SHIFT = 2;

function readLegacyTraceNode(trace: number[], index: number) {
  const id = trace[index];
  return {
    depth: trace[index + 1],
    dropped: (id & LEGACY_TRACE_DROP) !== 0,
    end: trace[index + 3],
    failed: (id & LEGACY_TRACE_FAIL) !== 0,
    rule: String(id >> LEGACY_TRACE_RULE_SHIFT),
    ruleId: id >> LEGACY_TRACE_RULE_SHIFT,
    start: trace[index + 2],
  };
}

function isNodeTrace(trace: Node[] | number[]): trace is Node[] {
  return trace.length === 0 || typeof trace[0] === "object";
}

/**
 * We display spans of each trace like this:
 * 0..6
 * 0..1
 * 10..11
 * The UI needs to know the maximum columns for these lines.
 */
function calculateMaxSpanWidth(trace: Node[]): number {
  return Math.max(
    0,
    ...trace.map(({ start, end }) => `${start}${SPAN_SEPARATOR}${end}`.length),
  );
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
 * @param parse - parser output
 */
export function generateTraceOutput(parse: Parse): {
  text: string;
  spans: Range[];
  errors: Range[];
  captures: Range[];
} {
  const { code, input, trace } = parse;
  const error = parse.ok ? null : formatParseError(parse.errors());
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
    failed: boolean = false,
  ) {
    if (failed && spanStart === spanEnd) {
      return "";
    }

    let span = formatCentered(spanStart, spanEnd, spanWidth) + " ";
    // why? otherwise we get column offset for e.g. extra input to date.
    span = span.slice(0, spanWidth + 1);
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

    if (failed && rule) {
      errors.push({
        start: start + span.length + verticalLines.length,
        end: start + span.length + verticalLines.length + rule.length - 1,
      });
    }

    return `${span}${verticalLines}${ruleSubstitute}${escapedLiteral}\n`;
  }

  function buildOutput(trace: Node[]) {
    const [node] = trace;
    if (!node) return;

    const failed = (node.id & TRACE_FAIL) !== 0;
    const rule = code.id_name(node.idx());
    // Skip successful anonymous rules
    if (!failed && rule[0] === "_") {
      return "";
    }

    // Output the rule line itself.
    const literal = input.substring(node.start, node.end);
    text += outputLine(
      text.length,
      depth,
      node.start,
      node.end,
      literal,
      rule,
      failed,
    );

    const visibleChildren: Node[][] = [];
    const childDepth = node.depth + 1;
    let cursor = 1;
    while (cursor < trace.length) {
      const child = trace[cursor];
      if (child.depth <= node.depth) break;
      const childStart = cursor;
      cursor++;
      while (cursor < trace.length && trace[cursor].depth > child.depth) {
        cursor++;
      }

      if (
        child.depth === childDepth &&
        ((child.id & TRACE_FAIL) !== 0 || code.id_name(child.idx())[0] !== "_")
      ) {
        visibleChildren.push(trace.slice(childStart, cursor));
      }
    }

    if (visibleChildren.length > 0) {
      let childStart = node.start;
      depth++;

      for (const child of visibleChildren) {
        const [childNode] = child;
        const childTraceStart = childNode.start;
        if (childTraceStart > childStart) {
          const childGap = input.slice(childStart, childTraceStart);
          text += outputLine(
            text.length,
            depth,
            childStart,
            childTraceStart,
            childGap,
          );
        }

        buildOutput(child);
        childStart = childNode.end;
      }

      if (childStart < node.end) {
        const trailingChildGap = input.slice(childStart, node.end);
        text += outputLine(
          text.length,
          depth,
          childStart,
          node.end,
          trailingChildGap,
        );
      }

      depth--;
    }
  }

  const [rootNode] = trace;

  if (rootNode && rootNode.start > 0) {
    text += outputLine(
      text.length,
      depth,
      0,
      rootNode.start,
      input.slice(0, rootNode.start),
    );
  }

  buildOutput(trace);

  // trailing literal
  if (rootNode && rootNode.end < input.length) {
    const literal = input.substring(rootNode.end);
    text += outputLine(
      text.length,
      depth + 1,
      rootNode.end,
      input.length,
      literal,
    );
  }

  if (error) {
    // if there's an error, highlight the last literal, as though it's not an error node, it's probably relevant
    if (lastLiteralRange) {
      errors.push(lastLiteralRange);
    }
    text += "\n\n" + error;
  }

  return { text, errors, spans, captures };
}

function escapeTraceInput(value: string): string {
  return value.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t");
}

export function generateGrammarCompileErrorOutput(
  grammarText: string,
  errorSource: Code | CodeError | ParseError | null,
): {
  text: string;
  highlights: Range[];
} {
  const error = readGrammarError(errorSource);
  const lines = formatGrammarError(error).split("\n");
  const highlights: Range[] = [];
  if (error?.kind === "parse") {
    highlights.push({ start: error.offset, end: error.offset });
  }
  //
  // if (error.fault_rule) lines.push(`Fault rule: ${error.fault_rule}`);
  // if (typeof error.rule === "string" && error.rule.length > 0) {
  //   lines.push(`In rule: ${error.rule}`);
  //   const ruleRange = findRuleDefinitionRange(grammarText, error.rule);
  //   if (ruleRange) {
  //     highlights.push(ruleRange);
  //   }
  // }
  //
  // if (error.column && error.line) {
  //   lines.push(`Location: Line ${error.line}, col ${error.column}`);
  //   const offset = extractOffsetFromLineColumn(
  //     grammarText,
  //     error.line,
  //     error.column,
  //   );
  //   highlights.push({ start: offset, end: offset });
  // }

  const text = lines.join("\n");

  return { text, highlights };
}

type GrammarError = CodeError | ParseError | null;

function readGrammarError(errorSource: Code | GrammarError): GrammarError {
  if (!errorSource) return null;
  if ("kind" in errorSource) return errorSource;
  return errorSource.errors();
}

export function formatGrammarError(error: GrammarError): string {
  if (error?.kind === "parse") {
    return ["Grammar compile error", formatParseError(error)].join("\n");
  }
  return formatCodeError(error);
}

export function formatCodeError(error: CodeError | null): string {
  const lines = ["Grammar compile error"];
  if (!error || error.messages.length === 0) {
    lines.push("Unknown grammar compile error.");
  } else {
    lines.push(...error.messages);
  }
  return lines.join("\n");
}

export function formatParseError(error: ParseError | null): string {
  if (!error) return "";

  const atPos = `at: ${error.offset} of: ${error.end}`;
  const title = `*** parse failed ${atPos}${formatEmptyAlternative(error)}`;
  return `${title}\n${formatLocation(error)}`;
}

function formatLocation(error: ParseError): string {
  const lines: string[] = [];
  const { location } = error;
  if (location.previousLineText !== undefined && location.previousLine) {
    lines.push(
      `line ${location.previousLine} | ${cleanErrorChars(location.previousLineText)}`,
    );
  }

  const beforeCaret = cleanErrorChars(
    location.lineText.slice(0, error.offset - location.lineStart),
  );
  const afterCaret =
    error.offset === error.end
      ? ""
      : location.lineText.slice(error.offset - location.lineStart);
  const left = `line ${location.line} | ${beforeCaret}`;
  const note = formatParseNote(error);
  lines.push(`${left}${afterCaret}`);
  lines.push(`${" ".repeat(left.length)}^ ${note}`);
  return lines.join("\n");
}

function formatParseNote(error: ParseError): string {
  if (error.fellShort) return "unexpected input, parse ok on input before this";
  if (error.expected) {
    return `failed, expected: ${formatExpected(error.expected)}`;
  }
  return "failed";
}

function formatExpected(expected: Expected): string {
  if (expected.kind === "literal") {
    return `'${expected.value}'${expected.caseInsensitive ? "i" : ""}`;
  }
  if (expected.kind === "rule") {
    return expected.name;
  }
  return formatExpression(expected.expression);
}

function formatExpression(expression: RuntimeExpr): string {
  return JSON.stringify(expression);
}

function formatEmptyAlternative(error: ParseError): string {
  const emptyAlternative = error.emptyAlternative;
  if (!emptyAlternative) return "";

  const detail = emptyAlternative.rule
    ? `alternative '${emptyAlternative.rule}' was an empty '' match!`
    : `alternative ${emptyAlternative.index} was an empty '' match!`;
  return `\n*** in: ${JSON.stringify(emptyAlternative.alternatives)}\n    ${detail}`;
}

function cleanErrorChars(value: string): string {
  return value.replace(/[^\S\r\n]|[\u0000-\u001F]/g, (char) =>
    char < " " ? " " : char,
  );
}

/**
 * Find the error in a TraceHistory most likely to be at fault for bad input
 * Returns { start, end } or null if none.
 */
export function findError(
  trace: Node[] | number[],
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
    if (!e.failed) continue;
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
  trace: Node[] | number[],
  inputLength: number,
): Range | null {
  let topLevelEnd = -1;
  if (isNodeTrace(trace)) {
    for (const node of trace) {
      if (
        (node.id & TRACE_FAIL) === 0 &&
        (node.id & TRACE_DROP) === 0 &&
        node.depth === 0 &&
        node.end > topLevelEnd
      ) {
        topLevelEnd = node.end;
      }
    }
  } else {
    for (let i = 0; i < trace.length; i += 4) {
      const { depth, dropped, end, failed } = readLegacyTraceNode(trace, i);
      if (!failed && !dropped && depth === 0 && end > topLevelEnd) {
        topLevelEnd = end;
      }
    }
  }

  if (topLevelEnd < 0 || topLevelEnd >= inputLength) return null;
  return { start: topLevelEnd, end: inputLength - 1 };
}

function splitTraces(
  trace: Node[] | number[],
): { failed: boolean; depth: number; start: number; end: number }[] {
  const result: {
    failed: boolean;
    depth: number;
    start: number;
    end: number;
  }[] = [];
  if (isNodeTrace(trace)) {
    for (const node of trace) {
      result.push({
        failed: (node.id & TRACE_FAIL) !== 0,
        depth: node.depth,
        start: node.start,
        end: node.end,
      });
    }
  } else {
    for (let i = 0; i < trace.length; i += 4) {
      const { depth, end, failed, start } = readLegacyTraceNode(trace, i);
      result.push({ failed, depth, start, end });
    }
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
  if (!CSS.highlights) {
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
      const domRange = rangeForTextOffsets(element, start, endExclusive);
      if (domRange) {
        highlight.add(domRange);
      }
    }
  }

  CSS.highlights.set(highlightName, highlight);
}

function rangeForTextOffsets(
  root: HTMLElement,
  start: number,
  endExclusive: number,
) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let current = 0;
  let startSet = false;
  let node: Node | null;

  while ((node = walker.nextNode())) {
    const textLength = node.textContent?.length ?? 0;
    const next = current + textLength;

    if (!startSet && start <= next) {
      range.setStart(node, Math.max(0, start - current));
      startSet = true;
    }

    if (startSet && endExclusive <= next) {
      range.setEnd(node, Math.max(0, endExclusive - current));
      return range;
    }

    current = next;
  }

  return null;
}
