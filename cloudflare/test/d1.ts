import type { Database } from "bun:sqlite";

/** A D1Database over an in-memory bun:sqlite, enough for repository tests. */
export function sqliteD1(sqlite: Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = sqlite.query(sql);
      let values: unknown[] = [];
      const prepared = {
        bind(...bound: unknown[]) {
          values = bound;
          return prepared;
        },
        async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
          const row = statement.get(...values as never[]) as Record<string, unknown> | null;
          if (!row) return null;
          return (columnName ? row[columnName] : row) as T;
        },
        async all<T = Record<string, unknown>>() {
          return {
            results: statement.all(...values as never[]) as T[],
            success: true,
            meta: {},
          };
        },
        async run() {
          const result = statement.run(...values as never[]);
          return {
            results: [],
            success: true,
            meta: { changes: result.changes },
          };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
}
