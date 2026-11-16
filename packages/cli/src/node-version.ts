/** The oldest Node.js major version ocpp-mimic runs on. */
export const MIN_NODE_MAJOR = 24;

/** Why this Node.js version cannot run ocpp-mimic, or undefined when it can. */
export function nodeVersionProblem(version: string): string | undefined {
  const major = Number(version.split('.')[0]);
  if (Number.isInteger(major) && major >= MIN_NODE_MAJOR) return undefined;
  return `ocpp-mimic needs Node.js ${MIN_NODE_MAJOR} or later; this is Node.js ${version}. Install a newer version from https://nodejs.org or with a version manager such as fnm or nvm.`;
}
