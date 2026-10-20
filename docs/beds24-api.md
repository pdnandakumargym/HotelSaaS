# Beds24 integration (second channel manager)

StaySync can connect a property to **Beds24** as well as to Booking.com through Zodomus. Each channel connection names its
channel manager (`channel_connections.provider`), and every call goes to that provider's adapter. Connections made through
Zodomus behave exactly as before. A connection request without a `provider` field is a Zodomus connection.

Source: Beds24 API v2 reference `https://beds24.com/api/v2/apiV2.yaml`, read 20 Oct 2026.

## What is synchronised

| Data | Direction | Beds24 call |
|---|---|---|
| Rooms and price slots (for mapping) | Beds24 → StaySync | `GET /properties?id=…&includeAllRooms=true&includePriceRules=true` |
| Rooms to sell | StaySync → Beds24 | `POST /inventory/rooms/calendar` `numAvail` |
| Prices: each mapped rate plan → one price slot `price1` … `price16` | StaySync → Beds24 | same call, `priceN` |
| Min/max stay, closed to arrival/departure (from the rate plan mapped to `price1`; Beds24 keeps these per room) | StaySync → Beds24 | `minStay`, `maxStay`, `override` (`noCheckIn`, `noCheckOut`, `noCheckInOrCheckOut`, `none`) |
| Closed rate plan on a date | StaySync → Beds24 | that slot's price is set to `null` ("set a field to null to remove it") |
| Bookings (new, changed, cancelled) | Beds24 → StaySync | `GET /bookings?propertyId=…&modifiedFrom=…&status=confirmed&status=request&status=new&status=cancelled` |
| Bookings made before connecting | Beds24 → StaySync | `GET /bookings?propertyId=…` (upcoming, once) |

These are **not** synchronised: room descriptions, photos, amenities, promotions and derived occupancy prices. Edit them in
Beds24. A rate update can set `override` back to `none`, and Beds24 then recomputes `numAvail`. For that reason every Beds24 rate
job is followed at once by the current availability for the same dates.

Beds24 sends updates on to Booking.com, Airbnb and other channels **only on a paid Beds24 account**. During the free trial you
can test StaySync ↔ Beds24 in full, but nothing reaches an OTA.

## Safety rules

- **Live account:** Beds24 has no sandbox. Calendar writes are refused unless `BEDS24_ALLOW_WRITES=true`.
- **Date-range rule not guessed:** the reference does not say whether the calendar `to` date is included. Writes are refused
  until `BEDS24_CALENDAR_TO_INCLUSIVE` is set to the value reported by `npm run beds24:check`, which only reads data.
- **Credentials:**
  - The refresh token is kept only in the server environment and is never stored in the database, logs or browser.
  - The short-life access token is kept only in memory and renewed before it expires, or after a 401.
  - Call logs record metadata only.
- **No card data:** the booking fields `stripeToken` and `pcibookingToken` are deleted before anything is stored.
  `invoiceItems` is never requested. Guest details are encrypted like Zodomus bookings.
- **Credits:** Beds24 limits API use per five minutes (`X-FiveMinCreditLimit-*` headers). When the budget is used up, StaySync
  stops calling until it resets, and the job retries later. Bookings read by the poll are reused instead of being fetched again.
- **Tests:** `BEDS24_ENABLED=true` is refused when `NODE_ENV=test`. Tests use a fake API and never touch real inventory.

## Setup (local PC)

1. **Beds24:** go to **Marketplace → API** (`control3.php?pagetype=apiv2`) and generate an **invite code**
   with these scopes:
   - read: bookings, bookings-personal (guest names), bookings-financial (totals)
   - read + write: inventory
   - read: properties
2. Run `npm run beds24:setup -w @staysync/api` and paste the invite code when asked. The code is not shown on screen; don't paste
   it into chats. The command prints a refresh token. Add it to `apps/api/.env` yourself:
   ```
   BEDS24_ENABLED=true
   BEDS24_REFRESH_TOKEN=<printed value>
   ```
3. Run `npm run beds24:check -w @staysync/api -- <Beds24 property id>`. It only reads data and shows:
   - the token's scopes
   - the rooms and price slots
   - upcoming bookings (ids and dates only)
   - credits
   - the value to use for `BEDS24_CALENDAR_TO_INCLUSIVE`

   If there isn't enough evidence yet, give one single night a different number of rooms in the Beds24 calendar and run the check
   again.
4. In `apps/api/.env`, set `BEDS24_CALENDAR_TO_INCLUSIVE=true` (or `false`, as reported) and `BEDS24_ALLOW_WRITES=true`. Then
   restart the API.
5. In StaySync, open **Room & Rate Mapping**, choose **Beds24**, enter the Beds24 property id, and link each Beds24
   room to a room type and each price slot to a rate plan. Then **Save mapping**. StaySync sends one year of availability and
   prices.
6. Check the Beds24 calendar. Then create a test booking in Beds24. Within a minute it appears in **Bookings**, and
   availability drops by one.

**Admin → System Health** shows the Beds24 status, write switch, date-range rule and credits, and has a **Test connection**
button.
