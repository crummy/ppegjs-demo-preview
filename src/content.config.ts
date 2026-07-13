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

type Schema = {
  Fields: {
    [key: string]: string | undefined;
    title: string;
    highlighted?: "true" | "false";
  };
  grammar: string;
  input: string;
};

const object: (value: unknown) => unknown = (value) =>
  Object.fromEntries(value as Iterable<readonly [PropertyKey, unknown]>);
const identity = <T>(value: T) => value;

const parser = ppeg.compile(grammar, {
  File: object,
  "Fields:": object,
  field: identity,
  key: String,
  value: String,
  "grammar:": String,
  "input:": String,
});

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
      const [ok, value] = parsed.transform();
      if (!ok) throw new Error(formatParseError(parsed.errors()).error);
      const { Fields, grammar, input } = value as Schema;
      return {
        grammar,
        input,
        ...Fields,
        id: Fields.title,
        highlighted: Fields.highlighted === "true",
      };
    });
    console.log(`Parsing ${examples.length} examples`);
    const highlightedExamples = examples.filter((e) => e.highlighted).length;
    if (highlightedExamples !== 1) {
      console.error(
        "Expected exactly one highlighted example but found " +
          highlightedExamples,
      );
    }
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

export const collections = { examples };
