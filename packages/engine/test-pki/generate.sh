#!/bin/sh
# Regenerates the test PKI used by the TLS tests and scenarios (Security
# Profiles 2 and 3). TEST ONLY: the private keys are committed on purpose and
# protect nothing. Needs OpenSSL 3.
#
#   ca.crt / ca.key                 test CA (O=ocpp-mimic)
#   server.crt / server.key         CSMS server certificate, CN=localhost,
#                                   SAN localhost and 127.0.0.1
#   client.crt / client.key         charge point certificate, CN=ocpp-mimic-test-cp
#   other-ca.crt                    a second CA nobody trusts
#   other-client.crt / .key         a client certificate signed by other-ca
set -eu
cd "$(dirname "$0")"
DAYS=7300
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ca() { # name, CN
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days "$DAYS" \
    -keyout "$1.key" -out "$1.crt" -subj "/O=ocpp-mimic/CN=$2" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}

leaf() { # name, CA name, CN, extensions
  openssl req -newkey rsa:2048 -nodes -sha256 -keyout "$1.key" -out "$TMP/$1.csr" \
    -subj "/O=ocpp-mimic/CN=$3" 2>/dev/null
  printf '%s\n' "$4" > "$TMP/$1.ext"
  openssl x509 -req -in "$TMP/$1.csr" -CA "$2.crt" -CAkey "$2.key" -set_serial "0x$(openssl rand -hex 8)" \
    -days "$DAYS" -sha256 -extfile "$TMP/$1.ext" -out "$1.crt" 2>/dev/null
}

ca ca "ocpp-mimic Test CA"
leaf server ca localhost "basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1"
leaf client ca ocpp-mimic-test-cp "basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth"

ca other-ca "Untrusted Test CA"
leaf other-client other-ca ocpp-mimic-test-cp "basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth"
rm other-ca.key
