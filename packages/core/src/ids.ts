/**
 * Produces OCPP-J uniqueIds (at most 36 characters). core cannot reach a
 * random source, so the engine passes a random-UUID generator and tests pass
 * {@link sequentialIds}.
 */
export type IdGenerator = () => string;

/** Deterministic ids `<prefix>1`, `<prefix>2`, ... for tests and replays. */
export function sequentialIds(prefix = 'id-'): IdGenerator {
  let next = 0;
  return () => `${prefix}${++next}`;
}
