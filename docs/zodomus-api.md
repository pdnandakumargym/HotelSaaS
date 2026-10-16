# Zodomus API notes (from the authenticated backoffice, 16 Oct 2026)

Source: `https://www.zodomus.com/swagger.json` (OpenAPI 3.0.0, "Zodomus channel manager API 1.0.0", 76 paths) and the
backoffice Documentation page, read in the owner's signed-in session. Only the facts StaySync relies on are summarised here.
Where the spec and the live sandbox disagree, **the sandbox wins** (see "Spec vs sandbox").

## Basics

- Base URL `https://api.zodomus.com`, HTTP Basic auth (API User / API Password from Development tab), JSON, TLS ≥ 1.2.
- Every response: `{ status: { returnCode, returnMessage, channelLogId, channelOtherMessages, timestamp }, ... }`.
  Sandbox success = HTTP 200 with `returnCode` 200 / `"OK"`. 400 = validation errors, 401 = bad credentials.
- Separate "API Password CC" unlocks `GET /reservations-cc` (card data). **StaySync never uses it (Phase 1: no card data).**

## Test mode

- `channelId` **1 = Booking.com** (only Booking and Expedia are available in tests).
- `propertyId`: **any integer you choose** for tests.
- Most test responses are **fixed** and do not depend on the request (e.g. `GET /availability` always returns the same data).
- Test reservations are created with `POST /reservations-createtest` (`status`: `new` | `modified` | `cancelled`).

## Pricing models (`priceModelId`, chosen at property activation; must match the channel property)

| id | Model | Channels |
|---|---|---|
| 1 | Maximum / single: `prices.price` (max occupancy) + `prices.priceSingle` (single adult; omit for single rooms) | Booking |
| 2 | Derived (Booking's recommendation): `POST /rates` with `prices.price` only, then `POST /rates-derived` with `baseOccupancy` and `occupancy[]` offsets (`persons`, `percentage` or `additional`, `round`) | Booking |
| 3 | Occupancy (`prices[]` with `guests`) | Expedia |
| 4 | Per day / length of stay | Expedia, Airbnb |

StaySync Milestone 5 supports models **1 and 2** (Booking.com).

## Dates

- `YYYY-MM-DD`. **`dateTo` is exclusive** ("up to and not including"): `2019-08-27` → `2019-09-02` covers 27 Aug – 1 Sep.
- Channels recommend sending availability and rates **for one year**; after a channel-manager switch the channel clears future data.

## Endpoints used by StaySync

| Call | Request | Notes |
|---|---|---|
| `POST /property-activation` | `channelId` int*, `propertyId` string*, `priceModelId` int* | Activates a channel property with Zodomus |
| `POST /property-check` | `channelId` int, `propertyId` string | In test mode moves the property to the next state; call before and after rooms activation |
| `GET /room-rates` | query `channelId`*, `propertyId`* | → `rooms: [{ id: int, name, rates: [{ id: string, name, active, maxPersons: int, policy, policyId: int }] }]` |
| `POST /rooms-activation` | `channelId`*, `propertyId`*, `rooms`*: `[{ roomId: string, roomName, quantity: int, status: int (1), rates: [rateId string] }]` | Tells Zodomus which channel rooms/rates are mapped |
| `POST /availability` | `channelId`, `propertyId`, `roomId`, `dateFrom`, `dateTo` (exclusive), `availability` int | Units left to sell per day |
| `POST /rates` | `channelId`, `propertyId`, `roomId`, `rateId`, `dateFrom`, `dateTo`, `currencyCode`, `prices: { price, priceSingle? }` (strings `###.##`) + optional restrictions | Restrictions (strings): `closed` 0/1, `minimumStay`/`maximumStay`/`minimumStayArrival`/`maximumStayArrival`/`exactStayArrival` 0–31, `closedOnArrival`/`closedOnDeparture` 0/1, `minAdvanceRes`/`maxAdvanceRes` (`4D`, `4D4H`), `weekDays {sun..sat: "true"/"false"}` |
| `POST /rates-derived` | `channelId`, `propertyId`, `roomId`, `rateId`, `baseOccupancy`, `occupancy: [{ persons, percentage | additional, round }]` | Model 2 only; dates/currency not used; `persons` ≤ room `maxPersons` |
| `GET /availability` | query `channelId`, `propertyId`, `dateFrom`, `dateTo` | Read-back (fixed data in test mode) |

Reservations (Milestone 6): `GET /reservations-queue` → `reservations: [{ id, status: 1 new | 2 modified | 3 cancelled, date }]`;
`GET /reservations?channelId&propertyId&reservationId` → `reservations: [{ reservation{id,status,currencyCode,totalPrice,remarks,RUID}, customer{...PII}, rooms{...} }]`
(a reservation can be retrieved only once — store it). Webhook (optional, HTTPS): POST `{ webhookKey, token, channelId, propertyId, reservationId, reservationStatus }`, retried 3×.

## Certification (needed before production)

Zodomus support confirms manually that each of these succeeded at least once in test mode: GET /channels, POST /property-activation,
POST /property-check, POST /rooms-activation, POST /property-check, GET /room-rates, POST /availability, POST /rates,
GET /reservations-summary, GET /reservations-queue (or webhook), GET /reservations, GET /reservations-cc.
**Open point:** StaySync does not retrieve card data in Phase 1; ask Zodomus support whether step 12 can be waived.

Production go-live for Booking.com (summary of Zodomus' steps): activate the property → owner selects Zodomus as channel manager in the
Booking.com Extranet (talk to Zodomus support first) → map rooms/rates → Zodomus accepts → owner confirms in the Extranet → send one year of
availability and rates.

## Spec vs sandbox

| Spec says | Sandbox returned |
|---|---|
| `account.postalCode`, `telephone`, `webhookKey`, `apiStatus`, `reservationType` | `postalcode`, `phone`, `webhook_key`, `api_status` (no `reservationType`) |
| price-model list under `channels` | under `models` |
| currencies list under `channels` | under `currencies` |
