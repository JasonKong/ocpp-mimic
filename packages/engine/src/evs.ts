/** EV lookup shared by the API and the scenario runner. */
import { evProfileProblems, type EvProfile, type PluggedEv } from '@ocpp-mimic/core';
import type { VirtualStation } from './fleet.js';

/**
 * The EV for a plug-in: a profile name from the station's persona, or an
 * inline profile. Undefined plugs in without an EV. Throws an Error with a
 * readable message for unknown names and unusable profiles.
 */
export function resolveEv(station: VirtualStation, value: unknown): PluggedEv | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const profile = station.persona.definition.evs?.[value];
    if (profile === undefined) {
      const known = Object.keys(station.persona.definition.evs ?? {});
      throw new Error(
        `persona ${station.persona.id} has no EV "${value}"${known.length > 0 ? ` (known: ${known.join(', ')})` : ''}`,
      );
    }
    return { name: value, profile: profile as EvProfile };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('"ev" must be an EV profile name or an EV profile');
  }
  const problems = evProfileProblems(value as EvProfile);
  if (problems.length > 0) throw new Error(`invalid EV profile: ${problems.join('; ')}`);
  return { profile: value as EvProfile };
}
