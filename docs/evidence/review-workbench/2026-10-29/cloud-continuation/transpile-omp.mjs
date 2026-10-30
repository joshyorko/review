// Test loader for the already-installed TypeScript compiler. Upstream source
// stays unchanged; Node 26 cannot strip TypeScript parameter properties.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '/workspace/.review-dev/sdk/node_modules/typescript/lib/typescript.js';

const root = pathToFileURL(`${process.env.REVIEW_OMP_SOURCE}/`).href;
registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith(root) || !url.endsWith('.ts')) return nextLoad(url, context);
    const output = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
      fileName: fileURLToPath(url),
    });
    return { format: 'module', source: output.outputText, shortCircuit: true };
  },
});
