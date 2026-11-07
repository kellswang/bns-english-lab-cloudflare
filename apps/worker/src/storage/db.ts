/** D1 轻量访问层 —— 只做最少封装,保持 SQL 可见、可测试。 */

export type Row = Record<string, unknown>;

/** D1 拒绝 undefined 绑定:统一转成 NULL(SQL 语义等价,防绑定泄漏)。 */
function safeParams(params: unknown[]): unknown[] {
  return params.map((p) => (p === undefined ? null : p));
}

export async function all<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await db.prepare(sql).bind(...safeParams(params)).all<T>();
  return results ?? [];
}

export async function one<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  const rows = await all<T>(db, sql, ...params);
  return rows[0] ?? null;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...safeParams(params)).run();
}

/** 在事务内执行多条语句(D1 batch 保证单连接顺序执行;失败整体回滚)。 */
export async function batch(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  return db.batch(stmts);
}

export function stmt(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...safeParams(params));
}

/** 原子条件更新并返回受影响行数(claim/消费/限流的关键原语)。 */
export async function changes(db: D1Database, sql: string, ...params: unknown[]): Promise<number> {
  const res = await run(db, sql, ...params);
  return res.meta.changes ?? 0;
}

export function nowIso(): string {
  return new Date().toISOString();
}
