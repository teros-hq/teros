import type { Db } from 'mongodb';

export interface Migration {
  /** Human-readable description of what this migration does */
  description: string;
  /** Apply the migration */
  up(db: Db): Promise<void>;
  /** Revert the migration (optional but strongly recommended) */
  down?(db: Db): Promise<void>;
}
