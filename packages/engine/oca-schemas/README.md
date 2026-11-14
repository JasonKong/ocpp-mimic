# OCA OCPP 1.6 JSON Schemas

`ocpp16/` holds the official OCPP 1.6 JSON Schema files published by the
Open Charge Alliance (OCA), one request and one response schema for each of the
28 OCPP 1.6 actions.

- **Work:** OCPP 1.6 JSON Schema files, part of the OCA download "OCPP 1.6 (all
  files & errata)", folder `OCPP_1.6_documentation/schemas/json/`.
- **Source:** https://openchargealliance.org/my-oca/ocpp/ (downloaded
  2026-11-14; archive SHA-256
  `2a1d80284ca60449e85951fc55bc0538b5d45bd6f97c6d9228745acacb52c11b`).
- **Copyright:** © 2010 – 2025 Open Charge Alliance. All rights reserved.
- **Licence:** made available under the Creative Commons
  Attribution-NoDerivatives 4.0 International Public License,
  https://creativecommons.org/licenses/by-nd/4.0/legalcode, as stated in the
  OCPP-J 1.6 specification and errata sheet shipped in the same download.
- **Changes:** none. The files are byte-for-byte copies of the published
  files, line endings included. `SHA256SUMS` lists their checksums, and a test
  in `packages/engine` fails if any file differs.

## Rules

- Never edit, reformat or rename these files. They are excluded from Prettier
  (`.prettierignore`) and from line-ending conversion (`.gitattributes`).
- ocpp-mimic only reads them as data and passes them to a generic JSON Schema
  validator (`src/oca-schemas.ts`). Nothing is generated from them; core's own
  message definitions are written from the specification text.
- To update, replace the folder with the files from a newer OCA download,
  regenerate `SHA256SUMS` (`shasum -a 256 *.json > ../SHA256SUMS` inside
  `ocpp16/`), and update the source and date above.
