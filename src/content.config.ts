/**
 * This file parses our examples from the filesystem and provides them to Astro.
 *
 * As a dogfooding exercise, the examples are parsed using our pPEG parser.
 * Examples are expected to be in src/examples, in this format:
 *
 * title: Example Title
 * ---
 * (grammar)
 * ---
 * (input)
 */

import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { ppeg } from "ppegjs";
import { formatParseError } from "./lib/generate-output";

const grammar = `
File    = Fields _sep grammar _sep input
grammar = _line*
input   = _ln*
Fields  = (field / comment)*
comment = '#' _ln
field   = key ':' _ value _
key     = [a-zA-Z0-9_]+
value   = ~[\\n\\r]*
_sep    = '---' _ln
_line   = !'---' _ln
_ln     = ~[\\n\\r]* _
_       = [ \\t\\n\\r]*
`;

type Field = ["field", ["key", string], ["value", string]];

type PTree = [
  "File",
  [["Fields", Field[]], ["grammar", string], ["input", string]],
];

type ParseTree = [string, string | ParseTree[]];

type TranslatedValue = string | TranslatedNode[] | Record<string, unknown>;

type TranslatedNode = [string, TranslatedValue];

type TransformFn = (tree: ParseTree, transform: TransformMap) => TranslatedNode;

type TransformMap = Record<string, TransformFn>;

const parser = ppeg.compile(grammar);

export const examples = defineCollection({
  loader: async () => {
    const files = import.meta.glob<string>("./examples/*.txt", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const examples = Object.values(files).map((contents) => {
      const parsed = parser.parse(contents);
      if (!parsed.ok) throw new Error(formatParseError(parsed.errors()).error);
      const ptree = parsed.ptree() as PTree;
      const transform = {
        File: obj,
        Fields: obj,
      };
      // @ts-ignore
      const { grammar, input, Fields } = translate(ptree, transform)[1];
      return {
        grammar,
        input,
        ...Fields,
        id: Fields.title,
        highlighted: Fields.highlighted === "true",
      };
    });
    console.log(`Parsing ${examples.length} examples`);
    return examples;
  },
  // This schema ensures that the data read in the collection above is valid, by parsing it with Zod
  schema: z.object({
    title: z.string(),
    grammar: z.string(),
    input: z.string(),
    highlighted: z.boolean().optional(),
  }),
});

function translate(tree: ParseTree, transform: TransformMap): TranslatedNode {
  const [id, val] = tree;
  const fn = transform[id];
  if (fn) return fn(tree, transform);
  if (typeof val === "string") return tree;
  const result: TranslatedNode[] = [];
  for (let i = 0; i < val.length; i += 1) {
    result.push(translate(val[i], transform));
  }
  return [id, result];
}

function obj(tree: ParseTree, transform: TransformMap): TranslatedNode {
  // expect child arr
  const [id, val] = tree;
  if (typeof val === "string") return [id, { id: val }];
  if (!Array.isArray(val)) throw new Error(`Expected array, got ${tree}`);
  const result: Record<string, TranslatedValue> = {};
  for (let i = 0; i < val.length; i += 1) {
    const [k, w] = translate(val[i], transform);
    if (typeof w === "string") {
      result[k] = w;
    } else if (Array.isArray(w) && w.length === 2) {
      const [[_key, key], [_val, val]] = w;
      result[key] = val;
    } else {
      // err
      result[k] = w;
    }
  }
  return [id, result];
}

export const collections = { examples };
