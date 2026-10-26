import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

// Real SQLite SQL semantics with the small async D1 interface used by the Worker.
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  const stats = { queries: 0 };
  sqlite.exec(readFileSync(new URL("../research-schema.sql", import.meta.url), "utf8"));
  return {
    sqlite,
    stats,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = values => ({
        bind: (...next) => { if (next.length > 100) throw new Error("D1 parameter limit exceeded"); return bound(next); },
        async first() { stats.queries++; return statement.get(...values) ?? null; },
        async all() { stats.queries++; return { results: statement.all(...values) }; },
        async run() { stats.queries++; return { meta: { changes: Number(statement.run(...values).changes) } }; },
      });
      return bound([]);
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT"); return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
}
