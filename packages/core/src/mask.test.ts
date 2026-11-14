import { describe, expect, it } from 'vitest';
import type { LogLine } from './log-format.js';
import { createMasker } from './mask.js';

/** A stand-in keyed hash: the same input always gives the same hex. */
function fakeHash(salt: string) {
  return (text: string) => {
    let h = 0x811c9dc5;
    for (const char of `${salt}|${text}`) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193) >>> 0;
    return (h.toString(16).padStart(8, '0') + 'abcdef0123456789').repeat(2);
  };
}

const line = (
  direction: LogLine['direction'],
  frame: unknown[],
  station = 'SITE-7-CP1',
): LogLine => ({
  at: '2026-11-15T09:00:00.000Z',
  station,
  direction,
  frame,
});

describe('masking', () => {
  it('gives identifiers stable pseudonyms that fit their fields', () => {
    const masker = createMasker(fakeHash('salt'));
    const start = masker.line(
      line('cp-to-csms', [
        2,
        '1',
        'StartTransaction',
        { connectorId: 1, idTag: 'CARD-12345', meterStart: 0 },
      ]),
    );
    const again = masker.line(line('cp-to-csms', [2, '2', 'Authorize', { idTag: 'CARD-12345' }]));
    const pseudonym = (start.frame?.[3] as { idTag: string }).idTag;
    expect(pseudonym).toMatch(/^T[A-Z2-7]{10}$/);
    expect((again.frame?.[3] as { idTag: string }).idTag).toBe(pseudonym);
    expect(start.station).toMatch(/^CP-[A-Z2-7]{10}$/);
    expect(start.station).toBe(masker.station('SITE-7-CP1'));
    const other = createMasker(fakeHash('pepper')).line(
      line('cp-to-csms', [2, '1', 'Authorize', { idTag: 'CARD-12345' }]),
    );
    expect((other.frame?.[3] as { idTag: string }).idTag).not.toBe(pseudonym);
  });

  it('masks serial numbers and SIM ids, and keeps info and vendor error codes', () => {
    const masker = createMasker(fakeHash('salt'));
    const boot = masker.line(
      line('cp-to-csms', [
        2,
        '1',
        'BootNotification',
        {
          chargePointVendor: 'V',
          chargePointModel: 'M',
          chargePointSerialNumber: 'SN-0001',
          meterSerialNumber: 'MTR-9',
          iccid: '8964000000000000001',
          imsi: '530010000000001',
        },
      ]),
    );
    expect(boot.frame?.[3]).toEqual({
      chargePointVendor: 'V',
      chargePointModel: 'M',
      chargePointSerialNumber: expect.stringMatching(/^S[A-Z2-7]{10}$/),
      meterSerialNumber: expect.stringMatching(/^S[A-Z2-7]{10}$/),
      iccid: expect.stringMatching(/^SIM[A-Z2-7]{10}$/),
      imsi: expect.stringMatching(/^SIM[A-Z2-7]{10}$/),
    });
    const status = masker.line(
      line('cp-to-csms', [
        2,
        '2',
        'StatusNotification',
        {
          connectorId: 1,
          status: 'Faulted',
          errorCode: 'GroundFailure',
          info: 'GND',
          vendorErrorCode: 'E101',
        },
      ]),
    );
    expect(status.frame?.[3]).toMatchObject({ info: 'GND', vendorErrorCode: 'E101' });
  });

  it('removes secrets and opaque data, also in answers matched to their CALL', () => {
    const masker = createMasker(fakeHash('salt'));
    const masked = [
      masker.line(line('cp-to-csms', [2, 'd1', 'DataTransfer', { vendorId: 'X', data: 'secret' }])),
      masker.line(line('csms-to-cp', [3, 'd1', { status: 'Accepted', data: 'reply' }])),
      masker.line(
        line('csms-to-cp', [
          2,
          'c1',
          'ChangeConfiguration',
          { key: 'AuthorizationKey', value: '0123456789abcdef' },
        ]),
      ),
      masker.line(
        line('csms-to-cp', [
          2,
          'f1',
          'UpdateFirmware',
          { location: 'ftp://user:pw@files.example.com/fw.bin', retrieveDate: 'x' },
        ]),
      ),
      masker.line(
        line('csms-to-cp', [
          2,
          'i1',
          'InstallCertificate',
          { certificateType: 'X', certificate: 'PEM' },
        ]),
      ),
      masker.line(line('cp-to-csms', [2, 's1', 'SignCertificate', { csr: 'CSR' }])),
    ].map((l) => l.frame?.[l.frame[0] === 3 ? 2 : 3]);
    expect(masked).toEqual([
      { vendorId: 'X', data: '<removed>' },
      { status: 'Accepted', data: '<removed>' },
      { key: 'AuthorizationKey', value: '***' },
      { location: 'ftp://user:***@files.example.com/fw.bin', retrieveDate: 'x' },
      { certificateType: 'X', certificate: '<removed>' },
      { csr: '<removed>' },
    ]);
  });

  it('masks more paths and keeps listed ones, and drops text that is not a message', () => {
    const masker = createMasker(fakeHash('salt'), {
      paths: ['DataTransfer.vendorId', '*.messageId'],
      keep: ['Authorize.idTag'],
    });
    const data = masker.line(
      line('cp-to-csms', [2, '1', 'DataTransfer', { vendorId: 'ACME', messageId: 'm' }]),
    );
    expect(data.frame?.[3]).toEqual({
      vendorId: expect.stringMatching(/^X[A-Z2-7]{10}$/),
      messageId: expect.stringMatching(/^X[A-Z2-7]{10}$/),
    });
    const kept = masker.line(line('cp-to-csms', [2, '2', 'Authorize', { idTag: 'CARD-1' }]));
    expect(kept.frame?.[3]).toEqual({ idTag: 'CARD-1' });
    const list = masker.line(
      line('csms-to-cp', [
        2,
        '3',
        'SendLocalList',
        {
          listVersion: 1,
          updateType: 'Full',
          localAuthorizationList: [
            { idTag: 'CARD-2', idTagInfo: { status: 'Accepted', parentIdTag: 'P-1' } },
          ],
        },
      ]),
    );
    const entry = (
      list.frame?.[3] as {
        localAuthorizationList: { idTag: string; idTagInfo: { parentIdTag: string } }[];
      }
    ).localAuthorizationList[0]!;
    expect(entry.idTag).toMatch(/^T/);
    expect(entry.idTagInfo.parentIdTag).toMatch(/^T/);
    const text: LogLine = {
      at: '2026-11-15T09:00:00.000Z',
      station: 'SITE-7-CP1',
      direction: 'cp-to-csms',
      text: 'CARD-1 broke',
    };
    expect(masker.line(text).text).toBe('<removed>');
  });
});
