# Charging session UI: requirements

Status: agreed on 2026-11-15, not started. Requirements carry an id and a priority: P0 must, P1 should, P2 later.

This page describes a new view of the Web UI that follows one charging session from start to end: how it started, which OCPP version the station speaks, the messages and logs, the energy delivered, what is known about the EV, and what a third party would charge for it. It also records what each OCPP version can tell a CSMS about the vehicle.

## 1. Goals and users

**Users**: people who build or test a CSMS; people who integrate a third party with one, for example a mobile app that starts sessions through its backend and the CSMS; people who demo the simulator. A driver-facing app is out of scope.

**Problem**: the current Web UI shows stations, connector status, kWh, power and frames, but not what happened in one charging session from start to end. The session view answers five questions:

1. How did the session start: a local card (idTag), or a remote start sent by the CSMS? A third-party app goes through the remote start.
2. Which OCPP version does the station use?
3. Which messages and log lines belong to the session?
4. How much energy has been delivered, what is the power now, what is the EV's state of charge, and when will it be full?
5. What price would a third party calculate from this data?

**Principle**: always keep apart what the CSMS and third parties can see (the values reported over OCPP) and what only the simulator knows (the EV model's ground truth). Comparing the two is what makes the view useful when testing a CSMS: how far its estimated time to full and its price are from the truth.

**Today**: the engine has no notion of a session. A station snapshot holds the current transactionId, idTag, energyWh, powerW, the EV's SoC and profile, and the power limit. It has no start source, timeline, past sessions or cost.

## 2. How a session started

A charge point cannot tell whether a remote start came from an app, an SMS or a web page; it only knows the command came from the CSMS. The UI therefore shows broad classes only.

| Start | OCPP 1.6 messages | OCPP 2.0.1 messages |
| --- | --- | --- |
| Local card (idTag) | Authorize(idTag) → StartTransaction; no Authorize when the local list or cache accepts the tag | TransactionEvent with triggerReason Authorized and an idToken (type usually ISO14443 / ISO15693); when the cable is plugged in first, the transaction starts with CablePluggedIn and Authorized follows in an Updated event |
| Remote start by the CSMS (the path a third-party app takes) | The CSMS sends RemoteStartTransaction(idTag, connectorId?) → Accepted → Authorize when AuthorizeRemoteTxRequests is true → StartTransaction. StartTransaction has **no field** that marks a remote start; a CSMS can only match idTag and time | The CSMS sends RequestStartTransaction(remoteStartId, idToken, evseId?) → TransactionEvent with triggerReason RemoteStart and transactionInfo.remoteStartId. The idToken type is often Central |
| No authorization (plug and charge without a card) | Vendor configuration (FreeVend and the like) with a fixed idTag | idToken type NoAuthorization |
| Plug & Charge (ISO 15118) | Not supported | idToken type eMAID. **Out of scope**; the type is only reserved |

Starts added in OCPP 2.1 (checked against the 2.1 JSON schemas and appendices):

- Payment terminal: idToken type DirectPayment; the settlement (amount, receipt) is reported with NotifySettlement.
- QR code / web payment: NotifyWebPaymentStarted marks the start of the payment; a variant of the remote start.
- Start by vehicle identity: idToken type VIN or EVCCID. In 2.1 the idToken type is an open string whose values are listed in the appendix.

Requirements:

- **R-START-1 (P0)** The engine records the start source of every session. It knows the source when it handles RemoteStartTransaction / RequestStartTransaction, so nothing has to be inferred from frames. Sources: local, remote, noAuth; reserved: payment (2.1), vehicle (Autocharge / VIN), plugAndCharge.
- **R-START-2 (P0)** Session cards and the session page show the start source as a badge, with the idTag / idToken and its type (2.0.1), and the remoteStartId for remote starts (2.0.1).
- **R-START-3 (P0)** The top of the session page shows a start timeline: the start messages in order, for example for a 1.6 remote start RemoteStartTransaction → Accepted → Authorize → StartTransaction → transactionId. Each step opens its frame and shows how long it took.
- **R-START-4 (P1)** Remote starts that are rejected or fail on the way are recorded too: Rejected, connector busy, authorization refused, cable not plugged in before the timeout. These are the cases most often looked into when integrating a third party.
- **R-START-5 (P1)** The UI simulates two starts: presenting a card (an idTag, through the existing `POST …/id-tag`) and plugging in. Against an external CSMS a remote start must come from that CSMS; the simulator never sends commands on its behalf.
- **R-START-6 (P1)** When the station is connected to the built-in CSMS, the UI offers a "simulate a third-party remote start" button: the built-in CSMS sends RemoteStartTransaction / RequestStartTransaction, so the whole remote start can be demonstrated.

## 3. Protocol version

The version follows the WebSocket subprotocol (ocpp1.6, ocpp2.0.1, and ocpp2.1 for 2.1). Snapshots and frame records already carry an `ocpp` field.

- **R-VER-1 (P0)** Stations, sessions and every frame show a version badge, one colour per version.
- **R-VER-2 (P0)** Labels follow the version: 1.6 says connector / idTag / transactionId (a number); 2.0.1 says EVSE / idToken (with its type) / transactionId (a string). Statuses too: 1.6 Charging / SuspendedEV correspond to 2.0.1 Occupied plus chargingState.
- **R-VER-3 (P0)** The UI does not hard-code version checks. A version capability table lists, per version, the terms, the vehicle fields it can carry, and whether it has remoteStartId, totalCost and tariffs. Adding 2.1 means adding a row of data, not changing components.
- **R-VER-4 (P1)** A field the current version cannot carry shows "not available in this version" instead of a blank, so it is clear what a newer protocol would add.

The fleet overview counts "charging" stations by 1.6 status names only and misses 2.0.1's Occupied; R-VER-2 fixes this too.

## 4. Logs

The current MessageLog shows the frames of a station. The log section turns it into a per-session view.

- **R-LOG-1 (P0)** A separate log section that can be collapsed and resized, showing the frames of the current session by default: from the RemoteStart or Authorize before the start to the answer to StopTransaction or TransactionEvent Ended. It can switch to the whole station.
- **R-LOG-2 (P0)** Each row shows the time, direction (station → CSMS / CSMS → station), version, action and a summary. A CALL is paired with its CALLRESULT / CALLERROR, with the response time. A row opens the full JSON.
- **R-LOG-3 (P0)** Filters by action, by direction, and errors only: CALLERROR, frames with schemaErrors, frames changed or dropped by fault injection.
- **R-LOG-4 (P1)** Station log lines (connect, disconnect and reconnect, faults, behaviour switches, EV plugged in or out) share one timeline with the frames, styled differently.
- **R-LOG-5 (P1)** Selecting a MeterValues or TransactionEvent frame highlights its moment on the energy chart, and the other way round.
- **R-LOG-6 (P1)** Export the session's frames in one click, as the recorder's JSONL, so they can be replayed or turned into a scenario.
- **R-LOG-7 (P2)** Search the log by idTag, transactionId or remoteStartId.

## 5. Energy view

A dedicated energy panel in the main area of the session page.

- **R-NRG-1 (P0)** Large figures:
  - energy delivered in this session (kWh): the meter reading minus meterStart;
  - power now (kW);
  - state of charge now (%);
  - session duration, with charging time and suspended time (SuspendedEV / SuspendedEVSE) apart.
- **R-NRG-2 (P0)** A chart of power and SoC over time, with the power the station offers (Power.Offered, or the smart charging limit) on top, so a limited session is obvious.
- **R-NRG-3 (P0)** The expected time to full or to the target SoC, as two values:
  - **truth**: the EV model is solved analytically, so the moment it is full under the current limit is known exactly, including the taper above 80 %;
  - **estimate**: computed from the reported values only (below). This is what a third party can achieve.
- **R-NRG-4 (P1)** Three-phase sessions show current and voltage per phase (Current.Import / Voltage on L1, L2, L3).
- **R-NRG-5 (P1)** A finished session keeps its chart and summary: total kWh, peak power, start and end SoC, stop reason.

How the estimate is computed (the third party's point of view):

1. With 2.1 and an ISO 15118-20 EV, use the reported Display.RemainingTimeToTargetSOC and Display.BatteryEnergyCapacity; nothing to estimate.
2. Battery capacity: for a 2.0.1 DC session with NotifyEVChargingNeeds, evEnergyCapacity. Otherwise from two readings: capacity ≈ Δenergy ÷ ΔSoC. SoC is reported as an integer, so this only settles after a few percent.
3. Energy left = (target SoC − SoC now) × capacity, with a target of 100 % when unknown.
4. Time left = energy left ÷ power now, corrected for the taper above 80 %. Without SoC there is no estimate: "cannot estimate: no SoC reported".
5. With a departureTime (2.0.1, 2.1), also show whether the target will be reached before departure.

## 6. Vehicle information by OCPP version

**In short**: what is known about the vehicle depends mostly on **whether the EV and the station talk digitally**, and only then on the OCPP version.

- **1.6**: meter values plus an SoC. The SoC is only reported when the station knows it: common for DC fast charging, rare for plain AC. No battery capacity, target SoC or departure time, so the time to full can only be estimated.
- **2.0.1**: nearly all extra vehicle information comes from ISO 15118, reported by the station with NotifyEVChargingNeeds. An AC EV without ISO 15118 gives about as much over 2.0.1 as over 1.6.
- **2.1** (checked against the JSON schemas and appendices of the OCPP 2.1 Edition 1 package): three additions over 2.0.1.
  - A set of Display.\* measurands in the meter values, matching ISO 15118-20's display parameters: PresentSOC, TargetSOC, MinimumSOC, MaximumSOC, the remaining time to each of them, BatteryEnergyCapacity, ChargingComplete. Also EnergyRequest.Target / Minimum / Maximum / Bulk. **With an ISO 15118-20 EV, the remaining time and battery capacity come straight from MeterValues / TransactionEvent.**
  - ChargingNeeds gains v2xChargingParameters: targetSoC, evTargetEnergyRequest, and charge and discharge power and current limits.
  - TransactionEvent gains preconditioningStatus (battery preconditioning).

| Information | 1.6 | 2.0.1 | 2.1 |
| --- | --- | --- | --- |
| Energy, power, current, voltage | Yes: MeterValues | Yes: TransactionEvent / MeterValues | Yes |
| State of charge | SoC measurand, only when the station knows it: common for DC, rare for AC | As 1.6; DC ChargingNeeds also carry stateOfCharge | As 2.0.1, plus Display.PresentSOC |
| Battery capacity | No | ISO 15118 DC only: evEnergyCapacity | As 2.0.1, plus Display.BatteryEnergyCapacity |
| Energy still needed | No | ISO 15118: energyAmount (AC and DC) | As 2.0.1, plus EnergyRequest.\* and V2X evTargetEnergyRequest |
| Target / full SoC | No | ISO 15118 DC: fullSoC, bulkSoC (end of fast charging) | As 2.0.1, plus Display.TargetSOC and V2X targetSoC |
| Time left to charge | No | No | Display.RemainingTimeToTargetSOC, and to the minimum / maximum SoC |
| Departure time | No | ISO 15118: departureTime | As 2.0.1 |
| EV maximum power, current, voltage | No; only the actual current | AC: evMinCurrent / evMaxCurrent / evMaxVoltage; DC: evMaxCurrent / evMaxVoltage / evMaxPower | As 2.0.1, plus V2X charge and discharge power and current limits |
| Whether the EV draws power (full or paused by the EV) | Status SuspendedEV | chargingState SuspendedEV | As 2.0.1, plus Display.ChargingComplete |
| Phases in use | No field; only the per-phase currents | TransactionEvent.numberOfPhasesUsed | As 2.0.1 |
| Battery preconditioning | No | No | TransactionEvent.preconditioningStatus |
| Vehicle identity | No standard field; Autocharge uses the EV's MAC as idTag, a vendor practice | idToken type MacAddress (Autocharge) or eMAID (Plug & Charge) | As 2.0.1, plus VIN and EVCCID |

**Gap in the simulator today**: with an EV model and the SoC measurand configured, the simulator reports SoC, on AC too. That is better than reality and lets CSMS tests miss the "no SoC" case.

- **R-EV-1 (P0)** A vehicle card shows every item of the table with its value, its source (reported / truth / estimate), and whether the current version can carry it.
- **R-EV-2 (P1)** The EV settings gain an "EV communication" option that decides whether SoC is reported. **Without it the behaviour stays as it is** (an EV reports SoC), so existing scenarios and personas do not change; new personas use the realistic setting. Values:
  - `basic`: AC with the PWM signal only, no SoC;
  - `dc`: DIN / CHAdeMO, reports SoC;
  - `iso15118`: reports SoC and sends ChargingNeeds.
- **R-EV-3 (P1)** A 2.0.1 station with an `iso15118` EV sends NotifyEVChargingNeeds when a session starts, with values from the EV model:
  - capacityKWh → evEnergyCapacity;
  - targetSoc → fullSoC;
  - taperSoc → bulkSoC;
  - maxPowerW → evMaxPower;
  - a configurable departure time.

  The message is already in the schemas; the ISO 15118 link itself is out of scope.
- **R-EV-4 (P2)** Once 2.1 is supported, ISO 15118-20 EVs also report the Display.\* measurands (capacity, target SoC, time left) from the EV model.

## 7. Third-party pricing

Who calculates the price:

- **1.6**: the CSMS alone; the station knows no prices. OCA's California pricing whitepaper for 1.6 sends the unit price, running cost and final cost to the station for display with DataTransfer; it is not part of the core protocol.
- **2.0.1**: still the CSMS, but the protocol has two places to send the cost back:
  - TransactionEventResponse.totalCost: the running cost during the session, the final cost on Ended;
  - CostUpdated: the CSMS pushes the running cost.

  Currency and fallback texts are TariffCostCtrlr variables.
- **2.1** (checked): the station can calculate the cost itself.
  - The CSMS sends a tariff with SetDefaultTariff, ChangeTransactionTariff, or in the AuthorizeResponse. A tariff has parts: fixedFee (per session), energy (per kWh), chargingTime, idleTime, reservationTime / reservationFixed, plus minCost / maxCost and tax rates.
  - The station reports the cost in TransactionEvent costDetails: an amount per part, the total with and without tax, split into chargingPeriods. transactionInfo carries the tariffId.
  - New cost-related trigger reasons: RunningCost, CostLimitReached, TariffChanged. totalCost and CostUpdated remain.

Data a third party can price from, all reported over OCPP and usually passed on by the CSMS through an interface such as OCPI:

| Price component | Data used |
| --- | --- |
| Per kWh | 1.6: meterStop − meterStart, cross-checked with transactionData when StopTxnSampledData is set. 2.0.1: meter values in the Transaction.Begin / Transaction.End contexts |
| Per minute | Start and end times; for charging time only, split by status or chargingState changes |
| Idle fee | Time the EV stays after it is full: SuspendedEV or Finishing in 1.6, chargingState SuspendedEV or EVConnected in 2.0.1 |
| Session fee | Whether the session started |
| Time-of-use | The timestamp of each meter value, to split the energy by period |

Requirements:

- **R-PRICE-1 (P0)** Show the cost the CSMS sends: 2.0.1 totalCost and CostUpdated, in time order. The 1.6 whitepaper's DataTransfer can come later.
- **R-PRICE-2 (P1)** Reference price: the user sets a tariff in the UI, the simulator prices the session from the reported values only and shows the result next to the CSMS's cost. This is for **checking whether a CSMS or third party bills correctly**. The tariff follows 2.1's TariffType: fixedFee, energy, chargingTime, idleTime, optional minCost / maxCost, so the same tariff can later be sent as a 2.1 tariff.
- **R-PRICE-3 (P1)** The reference price is itemised (session fee, energy, time, idle), and each item points to the frames it used.
- **R-PRICE-4 (P2)** Time-of-use prices.
- **R-PRICE-5 (P2)** Once 2.1 is supported, the station prices sessions from the tariff it was sent and reports costDetails, reusing the reference price calculation.

## 8. Data sources: reported, truth, estimate

Every figure in the session view is one of three kinds, and the UI says which.

| Source | Meaning | Examples |
| --- | --- | --- |
| Reported | Values in frames actually sent to the CSMS: what the CSMS and third parties see | Integer SoC, meter readings, ChargingNeeds |
| Truth | The simulator's EV model and meter state; in reality only the EV knows them | Fractional SoC, battery capacity, exact moment of full |
| Estimate | Computed from reported values only: what a third party can achieve | Estimated capacity, estimated time to full, reference price |

- **R-SRC-1 (P0)** Every figure carries a small label or icon for its source. The default is the CSMS's point of view: reported values and estimates only. "Show truth" adds the true values.
- **R-SRC-2 (P1)** An estimate that differs from the truth beyond a threshold is highlighted, for example a time to full off by more than 10 minutes, or a reference price that does not match the CSMS's cost.
- **R-SRC-3 (P1)** A reported value links back to its frame in the log section.

Engine changes (detailed when implemented):

- A session record: start source, idTag / idToken, remoteStartId, timeline, reported samples, true samples, CSMS cost, stop reason.
- API: list sessions, get one session, live session updates.
- Sessions are stored in the existing SQLite database and survive restarts. Each station keeps its latest N sessions (N configurable); older ones are pruned.

## 9. Layout

A running 2.0.1 session started remotely; all figures are made up.

```
┌ Top bar: station picker · [OCPP 2.0.1] · connected · view: CSMS / show truth
│
├ Left: sessions
│   ● running   EVSE 1  [remote]   12.4 kWh
│   ○ finished  EVSE 2  [card]     30.1 kWh
│   ✕ not started EVSE 1 [remote]  Rejected
│
├ Main
│   Header: [remote] idToken AA000012 (Central) · remoteStartId 42 · started 10:02
│   Start timeline: RequestStartTransaction → Accepted (80 ms) → TransactionEvent Started (RemoteStart)
│
│   Energy: 12.4 kWh · 7.2 kW · SoC 63 % · 1:42 elapsed
│           80 % at 10:58 (estimate) / 10:51 (truth)
│   Chart: power + SoC + power limit
│
│   Vehicle                                 Price
│   Capacity  64 kWh (estimate)             CSMS cost  9.32 (totalCost)
│   Target    — (not in this version/EV)    Reference  9.30 = energy 8.68 + time 0.62
│
└ Bottom: log section (collapsible, resizable, current session by default)
```

- **R-UI-1 (P0)** A new "Sessions" view in the existing Web UI, reachable from the station page and the fleet overview, reusing the API and the MessageLog and TransactionEvents components.
- **R-UI-2 (P0)** Live updates within 1 second.
- **R-UI-3 (P1)** On narrow screens the left column folds away and the panels stack.
- **R-UI-4 (P2)** A fleet-wide view of running sessions, counted by start source and version.

## 10. Out of scope and decisions

Out of scope:

- A real ISO 15118 link, TLS and Plug & Charge certificate chains; only the station's resulting messages to the CSMS are simulated.
- Real payments.
- OCPI; the simulator only sees OCPP.
- Implementing OCPP 2.1 itself; this work only leaves room for it in the data model and the version capability table.
- A driver-facing app.

Decisions (2026-11-15):

1. **Where**: a "Sessions" view in the existing Web UI, reusing its API, log components and live updates (R-UI-1).
2. **SoC reporting**: a new "EV communication" setting; without it the behaviour stays as it is, and new personas use the realistic setting (R-EV-2).
3. **NotifyEVChargingNeeds**: yes, sent at the start of a session by 2.0.1 stations with an `iso15118` EV (R-EV-3).
4. **Reference price**: session fee, per kWh, charging time and idle fee first, shaped like 2.1's TariffType; time-of-use later (R-PRICE-2, R-PRICE-4).
5. **Session history**: stored in the existing SQLite database, latest N per station (section 8).
6. **Simulated third-party remote start**: yes, only with the built-in CSMS; against an external CSMS the simulator never sends commands on its behalf (R-START-6).
7. **OCPP 2.1**: the 2.1 content of sections 2, 5, 6 and 7 was checked against the JSON schemas and appendices of the OCPP 2.1 Edition 1 package, not line by line against the specification text.
8. **Fleet view**: P2 (R-UI-4).
