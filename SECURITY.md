# Security

## Reporting a vulnerability

Please do not report security problems in public issues. Use GitHub's private vulnerability reporting instead: on the repository's **Security** tab, choose **Report a vulnerability**. You will get an answer within a week.

Please include the version (`ocpp-mimic --version`), how to reproduce the problem, and what an attacker could do with it.

## What to expect from ocpp-mimic

ocpp-mimic is a test tool. Keep these defaults in mind when you run it:

- The engine (`serve`) and the built-in CSMS (`csms`) listen on 127.0.0.1 unless `--host` says otherwise. Their HTTP APIs control every station and accept no credentials unless an API token is set. Do not expose them on a network you do not trust.
- Stations connect only to CSMS addresses on this machine unless `--allow-csms` allows others. Only test a CSMS you operate or have permission to test.
- The test PKI in `packages/engine/test-pki/` is public and for tests only. Never use its keys or certificates for anything else.
- Logs can contain identifiers from the stations and CSMSs they come from. `ocpp-mimic import` masks them by default; keep unmasked logs out of shared places.

## Supported versions

Security fixes go into the latest release.
