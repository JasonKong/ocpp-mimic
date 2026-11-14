/** A calibrated persona as YAML, for `ocpp-mimic calibrate`. */
import { stringify } from 'yaml';

export function personaYaml(persona: Record<string, unknown>, header: string): string {
  return `${header
    .split('\n')
    .map((line) => `# ${line}`)
    .join('\n')}\n${stringify(persona, { lineWidth: 0 })}`;
}
