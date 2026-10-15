# appointments-api

REST API for appointment booking at small service businesses such as clinics, salons and repair shops. It models services, staff schedules and customers, computes free slots, and books them without ever double-booking a staff member.

- Availability engine that honors working hours, time off, buffers, minimum notice, booking horizon and slot granularity, with correct handling of time zones and DST transitions
- Double-booking prevention enforced by a PostgreSQL exclusion constraint
- Cancellation window, rescheduling, status workflow, `Idempotency-Key` on booking
- JWT access tokens, rotating refresh tokens, `admin` / `staff` / `customer` roles
- Reminder emails 24 hours ahead (pg-boss queue, SMTP via nodemailer) with an iCalendar attachment
- OpenAPI 3.1 generated from the Zod route schemas, Swagger UI at `/docs`
- RFC 7807 errors, request IDs, structured logs, health probes, graceful shutdown

Stack: Node 24, TypeScript (strict), Fastify 5, Prisma and PostgreSQL 17, Zod, Luxon, Vitest.

## Architecture

```mermaid
flowchart LR
    client([Client]) --> routes

    subgraph api [Fastify process]
        routes["Routes<br/>validation, auth, serialization"] --> services["Services<br/>use cases, transactions"]
        services --> domain["Domain<br/>availability, booking rules,<br/>policy, iCalendar"]
        services --> repos["Repositories<br/>Prisma"]
        jobs["pg-boss worker"] --> reminders["Reminder service"]
        reminders --> repos
        reminders --> mail["Mail transport"]
    end

    repos --> pg[("PostgreSQL<br/>exclusion constraint")]
    jobs <--> pg
    mail --> smtp["SMTP / Mailpit"]
```

| Layer        | Path                   | Responsibility                                                                          |
| ------------ | ---------------------- | --------------------------------------------------------------------------------------- |
| Routes       | `src/http`             | Zod request and response schemas, authentication, RFC 7807 mapping, OpenAPI metadata    |
| Services     | `src/services`         | Use cases: load data, call the domain, open transactions, translate to repository calls |
| Domain       | `src/domain`           | Pure functions with no I/O: availability, booking and cancellation rules, policy, ICS   |
| Repositories | `src/repositories`     | The only code that touches Prisma                                                       |
| Jobs / mail  | `src/jobs`, `src/mail` | pg-boss worker and the `MailTransport` interface                                        |

The domain layer is covered by fast unit tests (85% coverage gate); everything above it is exercised by integration tests against a real PostgreSQL.

## Quickstart

### Docker

```sh
docker compose up --build
```

This starts the API on <http://localhost:3000>, PostgreSQL, and Mailpit (web UI on <http://localhost:8025>, where reminder emails appear). Migrations are applied on container start. If a port is taken, override it: `POSTGRES_PORT`, `MAILPIT_SMTP_PORT`, `MAILPIT_UI_PORT`, `API_PORT`.

Load the fictitious demo business (idempotent, refuses to run when `NODE_ENV=production`):

```sh
DATABASE_URL=postgresql://appointments:appointments@localhost:5432/appointments npm run db:seed
```

Demo accounts, all with password `demo-password-123`: `admin@demo.example.com`, `avery@demo.example.com` and `jordan@demo.example.com` (staff), `casey@demo.example.com` and `riley@demo.example.com` (customers).

Interactive docs: <http://localhost:3000/docs>. Raw spec: `/docs/json`.

### Local

Requires Node 24 and a PostgreSQL database.

```sh
npm ci
docker compose up -d postgres mailpit   # or point DATABASE_URL at your own server
cp .env.example .env                    # set JWT_ACCESS_SECRET
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

### Scripts

| Script                     | Purpose                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `npm run lint`             | ESLint with `typescript-eslint` strict, type-checked rules |
| `npm run format:check`     | Prettier                                                   |
| `npm run typecheck`        | `tsc --noEmit`                                             |
| `npm run test:unit`        | Domain unit tests                                          |
| `npm run coverage`         | Unit tests with a coverage gate (85%) on `src/domain`      |
| `npm run test:integration` | API tests against PostgreSQL                               |
| `npm run build`            | Generate the Prisma client and compile to `dist/`          |

Integration tests start a disposable PostgreSQL with Testcontainers, so Docker must be running. To use an existing database instead (CI does this), set `TEST_DATABASE_URL`; the suite applies migrations to it and truncates tables between tests, so never point it at data you care about.

## API overview

Every route except `/health/*` and the `/auth` endpoints needs `Authorization: Bearer <accessToken>`. Lists are paginated with `page` and `pageSize` and return `{ "data": [...], "meta": { "page", "pageSize", "total", "totalPages" } }`.

| Area         | Routes                                                                                                                                          | Access                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Auth         | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; `GET /auth/me`                                                           | public (rate limited); `me` any role                      |
| Organization | `GET /organization`; `PATCH /organization`                                                                                                      | any role; admin                                           |
| Services     | `GET /services`, `GET /services/:id`; `POST /services`, `PATCH /services/:id`                                                                   | any role; admin                                           |
| Staff        | `GET /staff`, `GET /staff/:id`; `POST /staff`, `PATCH /staff/:id`, `PUT /staff/:id/services`                                                    | any role; admin                                           |
| Schedules    | `GET /staff/:id/working-hours`; `PUT /staff/:id/working-hours`                                                                                  | any role; admin or that staff member                      |
| Time off     | `GET /time-off`; `POST /time-off`; `DELETE /time-off/:id`                                                                                       | admin, staff (own entries; closures admin only)           |
| Customers    | `GET /customers`, `POST /customers`; `GET /customers/:id`, `PATCH /customers/:id`                                                               | admin, staff; a customer reads and edits their own record |
| Availability | `GET /availability?serviceId&staffId&from&to`                                                                                                   | any role                                                  |
| Appointments | `POST /appointments`; `GET /appointments`, `GET /appointments/:id`; `POST /appointments/:id/cancel`, `/reschedule`; `GET /appointments/:id/ics` | owner, assigned staff, admin                              |
| Status       | `POST /appointments/:id/status` (`confirmed`, `completed`, `no_show`)                                                                           | admin, assigned staff                                     |
| Health       | `GET /health/live`, `GET /health/ready`                                                                                                         | public                                                    |

Examples (assuming the demo data and `jq`):

```sh
API=http://localhost:3000

# Sign in as a customer
TOKEN=$(curl -s $API/auth/login -H 'content-type: application/json' \
  -d '{"email":"casey@demo.example.com","password":"demo-password-123"}' | jq -r .tokens.accessToken)

# Pick a service and look at next week's slots (dates are local to the business)
SERVICE=$(curl -s $API/services -H "authorization: Bearer $TOKEN" | jq -r '.data[] | select(.name=="Standard treatment") | .id')
curl -s "$API/availability?serviceId=$SERVICE&from=2026-11-02&to=2026-11-06" \
  -H "authorization: Bearer $TOKEN" | jq '.slots[0]'

# Book it; the Idempotency-Key makes the request safe to retry
curl -s $API/appointments -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'idempotency-key: 6f1d2c9e-booking-1' \
  -d "{\"serviceId\":\"$SERVICE\",\"startsAt\":\"2026-11-02T14:00:00Z\"}"

# Download the calendar entry, then cancel
curl -s $API/appointments/$ID/ics -H "authorization: Bearer $TOKEN"
curl -s -X POST $API/appointments/$ID/cancel -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"reason":"Schedule change"}'

# Admin: set a weekly schedule (wall-clock times in the business time zone)
curl -s -X PUT $API/staff/$STAFF_ID/working-hours -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"intervals":[{"weekday":1,"start":"09:00","end":"12:00"},{"weekday":1,"start":"13:00","end":"17:00"}]}'
```

### Errors

All errors are `application/problem+json` ([RFC 7807](https://www.rfc-editor.org/rfc/rfc7807)):

```json
{
  "type": "urn:appointments-api:problem:slot-unavailable",
  "title": "Conflict",
  "status": 409,
  "detail": "The requested time is no longer available",
  "instance": "/appointments",
  "requestId": "399c32d0-56d9-4cda-a851-769c4f2f0536"
}
```

Validation failures add an `errors` array of `{ path, message }`. The `type` tail is a stable code (`slot-unavailable`, `cancellation-window-closed`, `idempotency-key-reuse`, ...). Send `X-Request-Id` to propagate your own correlation ID; it is echoed on the response and attached to every log line.

## Configuration

All configuration is read from the environment and validated at startup (`src/config/env.ts`); the process exits with a readable message if anything is invalid. See `.env.example`.

| Variable                         | Default                               | Description                                        |
| -------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `DATABASE_URL`                   | required                              | PostgreSQL connection string                       |
| `JWT_ACCESS_SECRET`              | required, at least 32 characters      | HS256 signing key for access tokens                |
| `JWT_ACCESS_TTL_SECONDS`         | `900`                                 | Access token lifetime                              |
| `REFRESH_TOKEN_TTL_DAYS`         | `30`                                  | Refresh token lifetime                             |
| `NODE_ENV`                       | `development`                         | `development` enables pretty logs                  |
| `HOST`, `PORT`                   | `0.0.0.0`, `3000`                     | Listen address                                     |
| `LOG_LEVEL`                      | `info`                                | pino level                                         |
| `TRUST_PROXY`                    | `false`                               | Trust `X-Forwarded-*` (set behind a reverse proxy) |
| `CORS_ORIGINS`                   | empty (CORS off)                      | Comma-separated allowed origins                    |
| `AUTH_RATE_LIMIT_MAX`            | `10`                                  | Requests per window per IP on `/auth/*`            |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | `60`                                  | Rate limit window                                  |
| `DOCS_ENABLED`                   | `true`                                | Serve `/docs`                                      |
| `MAIL_TRANSPORT`                 | `smtp`                                | `smtp` or `log` (writes to the log, sends nothing) |
| `MAIL_FROM`                      | `Appointments <no-reply@example.com>` | Sender address                                     |
| `SMTP_HOST`, `SMTP_PORT`         | `localhost`, `1025`                   | SMTP server                                        |
| `SMTP_SECURE`                    | `false`                               | Use TLS from connect                               |
| `SMTP_USER`, `SMTP_PASSWORD`     | unset                                 | SMTP credentials                                   |
| `REMINDERS_ENABLED`              | `true`                                | Run the reminder worker in this process            |
| `REMINDER_LEAD_HOURS`            | `24`                                  | How far ahead of the start a reminder is sent      |

The container entrypoint runs `prisma migrate deploy` before starting; set `SKIP_MIGRATIONS=true` if migrations are a separate release step.

## Design decisions

### Availability algorithm

`computeSlots` in `src/domain/availability.ts` is a pure function: it receives the organization time zone, a date range, the service timing, the booking rules, and for each candidate staff member their weekly hours, time off and already-claimed ranges. It performs no I/O and takes `now` as a parameter, so it is deterministic and cheap to test.

1. For each local calendar day in the range and each working interval on that weekday, resolve the interval's wall-clock start and end to instants in the organization zone.
2. Walk candidate start times from the first multiple of the slot granularity at or after the interval start, in steps of the granularity.
3. Keep a candidate when the service ends inside the working interval, the start is at least `minNoticeMinutes` away and no more than `maxAdvanceDays` ahead, the service does not overlap time off, and `[start, start + duration + buffer)` does not overlap an active appointment's blocked range.

The buffer is time after a service. It blocks following bookings but may extend past closing time, and it does not apply against time off. Booking reuses the same function: a requested start must appear in the computed slots for its day, so the HTTP availability view and the write path cannot disagree. Rescheduling does the same with the appointment's own range excluded.

### Concurrency

The guarantee lives in the database, not in application locking:

```sql
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
  "staffId" WITH =,
  tstzrange("startsAt", "blockedUntil", '[)') WITH &&
) WHERE ("status" IN ('pending', 'confirmed'));
```

`blockedUntil` is the end of the service plus its buffer. The service layer checks availability first so users get a clean answer in the common case; when two requests race past that check, the constraint rejects the loser with SQLSTATE `23P01`, which is mapped to `409 slot-unavailable`. Cancelled, completed and no-show rows leave the constraint, so their slot is free again. When the API chooses the staff member, a lost race triggers a bounded retry against fresh data, so concurrent requests fill every free staff member before any gets a conflict.

The test suite proves this three ways: 12 parallel API requests for one slot yield exactly one `201`; 10 parallel raw inserts that bypass the service layer yield exactly one success; and partial overlaps, buffer overlaps, updates and cancellations are checked directly against the constraint.

### Idempotency

`POST /appointments` accepts an `Idempotency-Key` header. The key, a hash of the request and the resulting appointment ID are stored in the same transaction that creates the appointment. A repeat with the same key and body returns the original appointment with `Idempotent-Replayed: true`; the same key with a different body is `422`. Keys are scoped to the caller. If concurrent retries race, the loser re-reads the winner's record and replays it. Records are not expired yet (see limitations).

### Time zones and DST

Instants are stored as `timestamptz` and exchanged as ISO 8601 with offsets. Business rules that are about the wall clock, such as "09:00 to 17:00" or "the next calendar day", are evaluated in the organization's IANA zone with Luxon. Concretely:

- Working hours are minutes since local midnight, not UTC offsets, so a 09:00 start stays 09:00 across a DST change.
- Slot candidates are generated on a wall-clock grid but advance in elapsed time. On a spring-forward day the skipped hour produces no slots; on a fall-back day both occurrences of the repeated hour do, as distinct instants. A 24-hour working window yields 23 and 25 hourly slots on those days respectively.
- A working-hours boundary that lands inside a gap resolves forward to the first valid instant; an ambiguous one resolves to its first occurrence.
- Date ranges in the availability endpoint are local calendar dates; a range may cover at most 31 days.

### Authentication

Access tokens are short-lived HS256 JWTs carrying only the subject and role. The caller's current role and profile are reloaded from the database on every request, so deleting or demoting a user takes effect immediately. Refresh tokens are 256-bit random values stored as SHA-256 hashes, rotated on every use and grouped in a family. Presenting a token that was already rotated revokes the whole family, which limits the damage of a stolen token. Passwords use argon2id. Login performs a hash verification even for unknown emails to keep timing uniform.

### Reminders

A pg-boss schedule runs every minute, finds active appointments starting within `REMINDER_LEAD_HOURS` with no reminder sent, and queues one job per appointment (deduplicated by a singleton key). The job loads the appointment, re-checks it is still active and in the future, sends the email through the `MailTransport` interface, then records `reminderSentAt`. Delivery is at-least-once with retries and exponential backoff; the `reminderSentAt` check makes redelivery after success a no-op. Appointments booked less than the lead time ahead are reminded on the next sweep. Rescheduling clears `reminderSentAt`. pg-boss keeps its state in the `pgboss` schema of the same database, so no Redis is needed.

### Other choices

- Prisma's `relationJoins` preview feature is enabled so included relations load in a single query; without it Prisma issues concurrent queries on a transaction's single connection, which `pg` 8 deprecates.
- Lists use offset pagination. It is simple and adequate at this scale; keyset pagination would be the next step for very large histories.
- Identifiers are UUIDv7, so they sort by creation time.

## Limitations

- Single tenant: one `Organization` row per deployment. Multi-tenancy would add an organization key to every table and to the exclusion constraint's scope.
- Customers book as themselves; there is no guest checkout. Staff and admins can create customer records without a login, which a customer later claims by registering with the same email.
- Staff and customer accounts have no password reset or email verification flow.
- Staff creation does not send an invitation; the admin sets the initial password.
- Services have no per-staff duration or price overrides, no multi-service bundles and no capacity above one customer per slot.
- Time-off and working-hours edits do not touch existing appointments; conflicting bookings are not flagged.
- Idempotency records and finished pg-boss jobs are not purged by the application (pg-boss maintains its own archive).
- Only reminder emails are sent. Booking and cancellation confirmations are not.
- HS256 with a shared secret; there is no key rotation or JWKS endpoint.

## License

[MIT](LICENSE)
