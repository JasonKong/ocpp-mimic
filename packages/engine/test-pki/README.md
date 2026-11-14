# Test PKI

Certificates for the TLS tests and scenarios (Security Profiles 2 and 3).
**Test only:** the private keys are committed on purpose, so these
certificates protect nothing. Never use them outside tests.

| File                                   | What                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `ca.crt`, `ca.key`                     | Test CA, `O=ocpp-mimic, CN=ocpp-mimic Test CA`                           |
| `server.crt`, `server.key`             | CSMS server certificate, `CN=localhost`, SAN `localhost` and `127.0.0.1` |
| `client.crt`, `client.key`             | Charge point certificate, `CN=ocpp-mimic-test-cp`                        |
| `other-ca.crt`                         | A second CA nobody trusts                                                |
| `other-client.crt`, `other-client.key` | A client certificate signed by the untrusted CA                          |

All are valid for 20 years. `./generate.sh` (OpenSSL 3) regenerates them.
