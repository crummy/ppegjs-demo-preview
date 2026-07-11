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

const exampleDataSchema = z
  .object({
    title: z.string(),
    grammar: z.string(),
    input: z.string(),
  })
  .catchall(z.string());

type Pair = [string, string];
type FieldValue = { key: string; value: string };

const transforms = {
  // A parsed field starts as just two pairs: ["key", fieldname], ["value", capture]
  // Parse these arrays into { key: fieldname, value: capture }
  field: (value: [Pair, Pair]): FieldValue => {
    const [[, key], [, fieldValue]] = value;
    return { key, value: fieldValue };
  },
  // Then, turn [{key: 'a', value: 'b'}, { key: 'c', value: 'd' }] into:
  // { a: 'b', c: 'd' }
  Fields: (value: FieldValue[]): Record<string, string> =>
    Object.fromEntries(
      value.filter(({ key }) => key).map(({ key, value }) => [key, value]),
    ),
  // Finally, after parsing the grammar and input as well, return:
  // { a: 'b', c: 'd', grammar: grammar, input: input }
  File: (
    value: [Record<string, string>, Pair, Pair],
  ): z.infer<typeof exampleDataSchema> => {
    const [{ title, ...fields }, [, grammar], [, input]] = value;
    return { ...fields, title, grammar, input };
  },
};

const parser = ppeg.compile(grammar, transforms);

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
      const { grammar, input, ...Fields } = exampleDataSchema.parse(value);
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
