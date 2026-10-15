# Contributing

Bug reports and pull requests are welcome.

## Setup

```sh
npm ci
docker compose up -d postgres mailpit
cp .env.example .env
npm run db:generate
npm run db:deploy
npm run dev
```

## Before opening a pull request

```sh
npm run lint
npm run format:check
npm run typecheck
npm run coverage          # unit tests; src/domain must stay at or above 85%
npm run test:integration  # needs Docker, or TEST_DATABASE_URL
npm run build
```

## Guidelines

- Keep business rules in `src/domain` as pure functions with unit tests. Services
  orchestrate, repositories talk to Prisma, routes translate HTTP.
- Schema changes need a Prisma migration (`npm run db:migrate -- --name <change>`).
  Rules Prisma cannot express, such as the exclusion constraint, are written as SQL
  inside the migration.
- A change to behavior or the HTTP contract needs a test and a `CHANGELOG.md` entry
  under `Unreleased`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).
