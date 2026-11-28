# Scenarios against CitrineOS

OCPP 2.0.1 scenarios with CitrineOS v2.1.0 as the CSMS
(`tools/citrineos/docker-compose.yml`). ocpp-mimic plays the charging
station, so each scenario follows the Part 6 test case for a CSMS
(`TC_…_CSMS`) named at the start of its name. Commands come from CitrineOS
through its REST API: an `http` step gets a local-dev token from
`POST /dev/token`, then calls `POST /ocpp/2.0.1/<module>/<action>?identifier=<station>&tenantId=1`.
That answer only says the CALL was sent; the scenario then expects the CALL at
the station and checks the station's answer.

Run them locally:

```bash
docker compose -f tools/citrineos/docker-compose.yml up -d
tools/citrineos/register.sh $(grep -v '^#' scenarios/citrineos/tokens.txt)
pnpm build
node packages/cli/dist/main.js run scenarios/citrineos --personas scenarios/personas
```

`register.sh` adds the scenarios' idTokens (`tokens.txt`) to CitrineOS's database: CitrineOS
answers Authorize from its Authorizations and only sends tokens it knows in a
local list, and it has no REST endpoint to create them. A scenario that starts
a transaction uses a token of its own: CitrineOS answers ConcurrentTx for a
token whose transaction another scenario left open. CitrineOS keeps state
between runs (local list versions per station, for example), so start a rerun
from a fresh stack: `docker compose -f tools/citrineos/docker-compose.yml down`
first.

With other ports, pass `--csms ws://localhost:<ws port>` and
`--var CITRINE=http://localhost:<http port>`. CI runs them in
`.github/workflows/citrineos.yml`.

## Coverage

The suite follows the Part 6 CSMS test cases of the certification profiles
ocpp-mimic implements (Part 5: Core, Advanced Security, Local Authorization
List Management, Smart Charging and Reservation), one scenario per test case
or per group of related ones, as far as CitrineOS's REST API can start them:

| File                  | Test cases (`TC_…_CSMS`)                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `provisioning.yaml`   | B_01, B_06, B_07, B_09, B_10, B_12, B_13, B_14, G_03 to G_08, G_11, G_14, G_17                                     |
| `authorization.yaml`  | C_02, C_06, C_07, C_37, C_39, D_01 to D_04, D_08, D_09, E_04                                                       |
| `transactions.yaml`   | E_01, E_02, E_03, E_07 to E_10, E_14, E_15, E_17, E_22, E_30, E_34, E_39, E_53, J_01 to J_03, J_07, J_09, J_10     |
| `remote-control.yaml` | B_20 to B_22, B_25 to B_27, F_01, F_02, F_04, F_06, F_11 to F_15, F_18, F_20, F_23, F_24, F_27, N_27 to N_32, P_02 |
| `security.yaml`       | B_42, L_01, L_05 to L_07, L_10, M_01 to M_04, M_12, M_13, M_16 to M_20, N_25, N_35, N_36                           |
| `smart-charging.yaml` | K_01, K_03 to K_06, K_08, K_10, K_19, K_29 to K_37, K_43, K_44, K_60, K_70                                         |
| `reservation.yaml`    | H_01, H_07, H_08, H_14, H_15, H_17, H_19, H_20, H_22                                                               |
| `failures.yaml`       | B_44, G_20, L_08, M_05, M_21, N_34: station failures from behaviour switches and a persona (T141)                  |

`transactions.yaml` also has a scenario beyond the five profiles: a station with an ISO 15118 EV sends NotifyEVChargingNeeds (T82); it only checks that CitrineOS takes the message.

`ocpp21.yaml` is the OCPP 2.1 suite (M7, T111). A 2.1 station connects with `ocpp2.1`, and commands come through CitrineOS's 2.1 REST API (`/ocpp/2.1/<module>/<action>`). It covers:

- boot and connector availability by NotifyEvent (B_01);
- a local session (E_01);
- a default tariff from CitrineOS, the station's own cost (costDetails) and CostUpdated (I07, I12, I03);
- a remote start and stop through the 2.1 API (F_02);
- a payment terminal session with its NotifySettlement (C18, C21);
- a charging profile (K_01) and a 2.1 variable read (B_06).

The rest of 2.1 is covered against the built-in CSMS in `scenarios/regression/ocpp21-*.yaml`.

Not covered, and why:

- **Security Profiles 1 to 3 and certificate renewal** (A_01 to A_04, A_06, A_07, A_09 to A_14, A_19): the test stack serves only security profile 0. The built-in CSMS covers them in `scenarios/regression/ocpp201-security.yaml`.
- **Test cases where the station must fail or refuse** in ways ocpp-mimic does not simulate: B_44 (SetNetworkProfile Failed), G_20 (unlock failure), L_08 (install verification failed), M_05 and M_21 (install or delete Failed), N_34 (GetLog Rejected).
- **Offline queueing cases** (E_29, E_31, E_33: transaction messages still queued when the CSMS asks), and those that need a CSMS reply CitrineOS does not give through its API (C_08, C_20, C_38, C_40, C_43, C_47 to C_49, E_16, E_21, E_38, F_03, K_02, K_15).

## CitrineOS behaviour the scenarios allow for

None of these is a deviation from OCPP 2.0.1; they are how CitrineOS works.

- **Tokens:** CitrineOS answers Authorize and builds local lists from its Authorizations table, which has no REST endpoint, so `register.sh` adds `tokens.txt`. It answers ConcurrentTx for a token whose transaction is still open, so each scenario that starts a transaction has a token of its own.
- **Reservations:** it stores a reservation only for an EVSE it knows from a base report, so the reservation scenarios ask for a FullInventory report first. Without one, the REST call fails with "Reservation could not be stored" and nothing is sent.
- **Charging profiles:**
  - It keeps chargingSchedule ids unique per station, so each profile of a scenario has its own schedule id.
  - It enforces K09.FR.03 (GetChargingProfiles names a criterion), so "every profile" is asked as `chargingLimitSource: [CSO]`.
- **Customer information:** it records a CustomerInformationRequest after sending it. ocpp-mimic sends NotifyCustomerInformation after the persona's command delay, like a station gathering the data.

## Known CitrineOS deviations

None in OCPP 2.0.1. When a scenario has to work around CitrineOS behaviour
that differs from OCPP, it is listed here with the scenario and how it copes;
nothing is reported upstream without asking first.

OCPP 2.1 (CitrineOS v2.1.0, `ocpp21.yaml`):

- **No answer to VatNumberValidation.** Its 2.1 handler receives the request but sends no answer, so the station's check times out. The payment scenario leaves the VAT check out; the built-in CSMS covers it in `scenarios/regression/ocpp21-payment.yaml`.
- **2.0.1 idToken types only in its 2.1 REST API.** `requestStartTransaction` refuses `type: DirectPayment` (HTTP 400, "must be equal to one of the allowed values"), although 2.1 idToken types are open. A web payment's remote start therefore cannot go through it. The remote start scenario uses an ISO14443 token, and the built-in CSMS covers web payments.
