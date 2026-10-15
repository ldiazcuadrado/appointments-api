# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-15

### Added

- Availability engine that computes bookable slots from weekly working hours, time off,
  existing appointments, service buffers, minimum notice, booking horizon and slot
  granularity, with DST-correct time zone handling.
- Appointment booking with a PostgreSQL exclusion constraint that prevents double
  booking, automatic staff assignment, and `Idempotency-Key` support.
- Cancellation window, rescheduling and appointment status transitions.
- JWT access tokens and rotating refresh tokens with reuse detection; admin, staff and
  customer roles with per-route authorization.
- Reminder emails sent 24 hours ahead through pg-boss and a pluggable mail transport,
  with an iCalendar attachment and a `GET /appointments/:id/ics` endpoint.
- OpenAPI 3.1 document generated from Zod schemas, with Swagger UI at `/docs`.
- RFC 7807 problem responses, request IDs, structured logging, health and readiness
  probes, graceful shutdown, rate limiting on auth routes, CORS and security headers.
- Docker image, Docker Compose stack with PostgreSQL and Mailpit, GitHub Actions CI.

[Unreleased]: https://github.com/ldiazcuadrado/appointments-api/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ldiazcuadrado/appointments-api/releases/tag/v0.1.0
