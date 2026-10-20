import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path = ':memory:'): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return new Database(path);
}
