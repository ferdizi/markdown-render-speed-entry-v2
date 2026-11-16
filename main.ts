// Driver for the markdown-render-speed-02 entry: read every case from
// /input/cases.json (or $MAKEFUN_INPUT_DIR), render each one alone with
// parse() from ./parse.js, and write /output/html.json (or
// $MAKEFUN_OUTPUT_DIR) as a JSON array of HTML strings in case order.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  html[k] = parse(cases[k].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
