import type { Clock } from '../lib/clock.js';
import type { Database } from '../repositories/index.js';

export interface ServiceDeps {
  db: Database;
  clock: Clock;
}
