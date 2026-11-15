# OCA OCPP JSON Schemas

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

## Security Whitepaper schemas

`ocpp16-security/` holds the official JSON Schema files of the OCPP 1.6
Security Whitepaper, one request and one response schema for each of its 11
messages (draft-06, unlike the draft-04 files above).

- **Work:** the JSON schemas of "Improved security for OCPP 1.6-J" (OCPP 1.6
  Security Whitepaper), edition 4, 2026-02-05: `JSON_schemas.zip`, folder
  `schema/`, inside the OCA download "OCPP 1.6 Security Whitepaper (4th
  edition)".
- **Source:**
  https://openchargealliance.org/wp-content/uploads/2025/08/OCPP-1.6-security-whitepaper-edition-4.zip
  (downloaded 2026-11-14; archive SHA-256
  `158b883e8ee712fd80fad3610b69fad355f7831d7a0ccdd996ce6b5452ce6859`).
- **Copyright:** © 2026 Open Charge Alliance. All rights reserved.
- **Licence:** Creative Commons Attribution-NoDerivatives 4.0 International
  Public License, https://creativecommons.org/licenses/by-nd/4.0/legalcode, as
  stated in the whitepaper shipped in the same download.
- **Changes:** none. `SHA256SUMS-security` lists their checksums
  (`shasum -a 256 *.json > ../SHA256SUMS-security` inside `ocpp16-security/`),
  and the same test checks them. The same rules apply.

## OCPP 2.0.1 schemas

`ocpp201/` holds the official OCPP 2.0.1 JSON Schema files, one request
(`<Action>Request.json`) and one response schema for each of the 64 OCPP 2.0.1
actions (draft-06).

- **Work:** `OCPP-2.0.1_part3_JSON_schemas` (dated 2020-03-31), folder
  `OCPP-2.0.1_part3_JSON_schemas/` of `OCPP-2.0.1_part3_JSON_schemas.zip`,
  inside the OCA download "OCPP 2.0.1 (all files)" (Edition 3 with the errata
  of 2025-09). The download's ReadMe states that the errata do not affect any
  schemas.
- **Source:** https://openchargealliance.org/my-oca/ocpp/ (download archive
  SHA-256 `af8201347c81d8308e4af85fe154ea55388894846adb6e0d3e1cc9dfe3e93bf3`;
  inner `OCPP-2.0.1_part3_JSON_schemas.zip` SHA-256
  `6279c40b74929cce7fca439622194a8890a0d250de5665f3e4d80ef8529c51ce`).
- **Copyright:** © 2010 – 2024 Open Charge Alliance. All rights reserved.
- **Licence:** Creative Commons Attribution-NoDerivatives 4.0 International
  Public License, https://creativecommons.org/licenses/by-nd/4.0/legalcode, as
  stated in the OCPP 2.0.1 specification parts shipped in the same download
  (for example Part 4, the OCPP-J specification).
- **Changes:** none. `SHA256SUMS-ocpp201` lists their checksums
  (`shasum -a 256 *.json > ../SHA256SUMS-ocpp201` inside `ocpp201/`), and the
  same test checks them. The same rules apply.

Action names repeat between 1.6 and 2.0.1 with different payloads, so the
engine loads one set per version (`OCA_SCHEMA_DIRS` in `src/oca-schemas.ts`).
