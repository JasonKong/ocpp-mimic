import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUILT_IN_PERSONAS_DIR, loadPersonas } from './personas.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function dirWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ocpp-mimic-personas-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

describe('persona registry', () => {
  it('loads the built-in generic-1.6 persona', async () => {
    const registry = await loadPersonas();
    expect(registry.errors).toEqual([]);
    expect(registry.warnings).toEqual([]);
    expect(registry.get('generic-1.6')?.options).toMatchObject({
      boot: { chargePointVendor: 'ocpp-mimic', chargePointModel: 'Generic-AC' },
      connectors: 1,
      offeredPowerW: 7360,
      timing: { resetDowntimeMs: { Soft: 30_000, Hard: 180_000 } },
    });
  });

  it('lets a persona in another directory extend a built-in one', async () => {
    const dir = await dirWith({
      'vendor-x.yaml': [
        'persona: vendorX-fw2.5',
        'extends: generic-1.6',
        'boot: { chargePointVendor: VendorX, firmwareVersion: "2.5.0" }',
        'connectors: 2',
        'timing:',
        '  commandDelays: { RemoteStopTransaction: 800ms }',
      ].join('\n'),
    });
    const registry = await loadPersonas([BUILT_IN_PERSONAS_DIR, dir]);
    expect(registry.errors).toEqual([]);
    expect(registry.list().map((p) => p.id)).toEqual([
      'generic-1.6',
      'generic-2.0.1',
      'generic-2.1',
      'generic-dual-1.6',
      'generic-dual-2.0.1',
      'generic-dual-2.1',
      'vendorX-fw2.5',
    ]);
    // generic-2.1 is generic-2.0.1 with the 2.1 version.
    expect(registry.get('generic-2.1')).toMatchObject({
      ocpp: '2.1',
      options: { ocpp: '2.1', boot: { model: 'Generic-AC-2.1' }, connectors: 1 },
    });
    // The dual-port personas are the generic ones with two ports.
    for (const [id, ocpp] of [
      ['generic-dual-1.6', '1.6'],
      ['generic-dual-2.0.1', '2.0.1'],
      ['generic-dual-2.1', '2.1'],
    ] as const) {
      expect(registry.get(id), id).toMatchObject({
        ocpp,
        options: { connectors: 2, offeredPowerW: 7360, stationPowerW: 11040 },
      });
    }
    expect(registry.get('vendorX-fw2.5')?.options).toMatchObject({
      boot: {
        chargePointVendor: 'VendorX',
        chargePointModel: 'Generic-AC',
        firmwareVersion: '2.5.0',
      },
      connectors: 2,
      timing: { actionDelaysMs: { RemoteStopTransaction: 800 } },
    });
  });

  it('reports unreadable YAML and invalid personas with their file', async () => {
    const dir = await dirWith({
      'broken.yaml': 'persona: [unclosed',
      'invalid.yml':
        'persona: bad\nboot: { chargePointVendor: V, chargePointModel: M }\nconnectors: two\n',
      'notes.txt': 'not a persona',
    });
    const registry = await loadPersonas([dir]);
    expect(registry.list()).toEqual([]);
    expect(registry.errors).toHaveLength(2);
    expect(registry.errors[0]).toMatch(/broken\.yaml: invalid YAML/);
    expect(registry.errors[1]).toBe(
      `${join(dir, 'invalid.yml')}: $.connectors: expected integer, got string`,
    );
  });

  it('reports a directory that cannot be read', async () => {
    const registry = await loadPersonas([join(tmpdir(), 'ocpp-mimic-no-such-dir')]);
    expect(registry.errors[0]).toMatch(/ocpp-mimic-no-such-dir/);
  });
});
