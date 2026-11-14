/**
 * The Local Authorization List (OCPP 1.6 sections 3.5.2 and 5.15): a list of
 * idTags with their IdTagInfo that only the CSMS changes, through
 * SendLocalList. Entries take priority over the authorization cache.
 */
import type { IdTagInfo, RequestOf } from './ocpp16-messages.js';

export interface LocalAuthList {
  /** The version the CSMS gave with the last accepted update. */
  readonly version: number;
  readonly entries: Readonly<Record<string, IdTagInfo>>;
}

export const EMPTY_LOCAL_LIST: LocalAuthList = { version: 0, entries: {} };

export type SendLocalListStatus = 'Accepted' | 'Failed' | 'VersionMismatch';

/** GetLocalListVersion: 0 for an empty list. */
export function localListVersion(list: LocalAuthList): number {
  return Object.keys(list.entries).length === 0 ? 0 : list.version;
}

/**
 * Applies SendLocalList. A Full update replaces the list (every entry needs
 * idTagInfo); a Differential update adds or updates entries with idTagInfo
 * and deletes those without, and needs a version above the current one.
 * Too many entries in the request or in the result leave the list as it was.
 */
export function applySendLocalList(
  list: LocalAuthList,
  request: RequestOf<'SendLocalList'>,
  limits: { sendMax: number; listMax: number },
): { list: LocalAuthList; status: SendLocalListStatus } {
  const changes = request.localAuthorizationList ?? [];
  if (changes.length > limits.sendMax) return { list, status: 'Failed' };
  let entries: Record<string, IdTagInfo>;
  if (request.updateType === 'Full') {
    if (changes.some((entry) => entry.idTagInfo === undefined)) return { list, status: 'Failed' };
    entries = Object.fromEntries(
      changes.map((entry) => [entry.idTag, entry.idTagInfo as IdTagInfo]),
    );
  } else {
    if (request.listVersion <= list.version) return { list, status: 'VersionMismatch' };
    entries = { ...list.entries };
    for (const entry of changes) {
      if (entry.idTagInfo === undefined) delete entries[entry.idTag];
      else entries[entry.idTag] = entry.idTagInfo;
    }
  }
  if (Object.keys(entries).length > limits.listMax) return { list, status: 'Failed' };
  return { list: { version: request.listVersion, entries }, status: 'Accepted' };
}
