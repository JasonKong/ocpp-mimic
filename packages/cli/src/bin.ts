#!/usr/bin/env node
// The `ocpp-mimic` command. It checks the Node.js version before loading the
// rest, whose imports would otherwise fail with an error about a missing export.
import { nodeVersionProblem } from './node-version.js';

const problem = nodeVersionProblem(process.versions.node);
if (problem !== undefined) {
  console.error(problem);
  process.exit(1);
}
await import('./main.js');
