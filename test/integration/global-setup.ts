import { execFileSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Uses TEST_DATABASE_URL when set (CI, or a local docker-compose database);
 * otherwise starts a disposable PostgreSQL container with Testcontainers.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    container = await new PostgreSqlContainer('postgres:17-alpine').start();
    url = container.getConnectionUri();
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  project.provide('databaseUrl', url);
  return async () => {
    await container?.stop();
  };
}
