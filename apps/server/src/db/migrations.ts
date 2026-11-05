// Ordered list of schema migrations. Never edit a migration that has shipped: add a new one.
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: 'app_meta',
    sql: `CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  },
];
