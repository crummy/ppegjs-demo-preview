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
 * ---
 * (optional notes)
 */

import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { ppeg } from "ppegjs";
import { formatParseError } from "./lib/generate-output";

const grammar = `
File    = Fields _sep grammar _sep input (_sep notes)?
grammar = _line*
input   = _line*
notes   = _ln*
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
  notes?: string;
  notesHtml?: string;
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
  "notes:": String,
});

export const examples = defineCollection({
  loader: {
    name: "examples",
    load: async ({ parseData, renderMarkdown, store }) => {
      const files = import.meta.glob<string>("./examples/*.txt", {
        query: "?raw",
        import: "default",
        eager: true,
      });
      const examples = await Promise.all(
        Object.values(files).map(async (contents) => {
          const parsed = parser.parse(contents);
          if (!parsed.ok)
            throw new Error(formatParseError(parsed.errors()).error);
          const [ok, value] = parsed.transform();
          if (!ok) throw new Error(formatParseError(parsed.errors()).error);
          const { Fields, grammar, input, notes } = value as Schema;
          // When notes are present, input has a trailing newline, which is often unexpected.
          const inputWithoutNotesSeparatorNewline =
            notes === undefined ? input : input.replace(/\r?\n$/, "");
          const notesHtml =
            notes === undefined
              ? undefined
              : (await renderMarkdown(notes)).html;
          return {
            grammar,
            input: inputWithoutNotesSeparatorNewline,
            notes,
            notesHtml,
            ...Fields,
            id: Fields.title,
            highlighted: Fields.highlighted === "true",
          };
        }),
      );
      console.log(`Parsing ${examples.length} examples`);
      const highlightedExamples = examples.filter((e) => e.highlighted).length;
      if (highlightedExamples !== 1) {
        console.error(
          "Expected exactly one highlighted example but found " +
            highlightedExamples,
        );
      }
      store.clear();
      for (const example of examples) {
        store.set({
          id: example.id,
          data: await parseData({ id: example.id, data: example }),
        });
      }
    },
  },
  // This schema ensures that the data read in the collection above is valid, by parsing it with Zod
  schema: z.object({
    title: z.string(),
    grammar: z.string(),
    input: z.string(),
    notes: z.string().optional(),
    notesHtml: z.string().optional(),
    highlighted: z.boolean().optional(),
  }),
});

export const collections = { examples };
