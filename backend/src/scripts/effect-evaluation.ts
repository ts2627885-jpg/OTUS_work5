/**
 * Оценка эффектов ценовых рекомендаций (PRICE-*). Только чтение: в базу ничего не пишется.
 *
 *  1. ОЖИДАЕМЫЙ эффект активных рекомендаций по модели эластичности станции:
 *       Δвыручки/день = q₀·p₀·((1+Δp)^(1+e) − 1),   Δобъёма = (1+Δp)^e − 1
 *     где p₀ — последняя цена станции, q₀ — средний объём за 7 дней, Δp — переход к рекомендованной цене,
 *     e — эластичность станции (только надёжная: иначе эффект не оценивается).
 *  2. ФАКТИЧЕСКИЙ эффект выполненных рекомендаций: средние значения за 14 дней до и 14 дней после
 *     отметки «выполнено» (объём, цена, выручка в день). Без контрольной группы: сезонность,
 *     акции и действия конкурентов в результат попадают.
 *
 * Запуск (из папки backend):
 *   npx ts-node -r tsconfig-paths/register src/scripts/effect-evaluation.ts
 */
import type { PoolClient } from 'pg';
import { getRawPool, closeDatabasePool } from '@config/database';
import { requestScope } from '@config/request-context';
import { computeRules, priceChangeEffect, volumeChangeShare } from '@services/rules.service';

const WINDOW_DAYS = 14;

/** Цель из текста действия: «Установить цену 71.45 ₽/л» или «Ориентир 71.45 ₽/л (...)» */
export function targetFromAction(action: string | null): number | null {
  const m = action?.match(/(?:Установить цену|Ориентир) ([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const pct = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);

/**
 * Отчёт. Скрипт системный: роль приложения azs_app видит рекомендации только в контексте пользователя
 * (RLS), поэтому отчёт выполняется в контексте admin, как и генерация рекомендаций.
 */
async function report(db: PoolClient): Promise<void> {
  const { rows: [{ as_of }] } = await db.query(`SELECT max(sale_date)::text AS as_of FROM azs.fuel_daily WHERE price IS NOT NULL`);
  const rules = await computeRules();
  const models = rules.models as Record<string, { elasticity: number | null; reliable?: boolean; r2: number | null; n: number }>;

  console.log(`Дата данных: ${as_of}. Эффекты в ₽ за день, объём в литрах.\n`);

  // ---------- 1. Ожидаемый эффект активных ценовых рекомендаций ----------
  const { rows: active } = await db.query(`
    SELECT r.dedupe_key, r.fuel_type, r.action, a.name AS station
      FROM recommendations r LEFT JOIN public.azs a ON a.id = r.azs_id
     WHERE r.status = 'active' AND r.rule_id LIKE 'PRICE-%'
     ORDER BY r.dedupe_key`);
  console.log('== 1. Ожидаемый эффект активных рекомендаций');
  console.log('станция            топливо  p₀     цель   Δp     e       q₀ л/д   Δобъёма  Δвыручка ₽/д  надёжность');
  for (const r of active) {
    // Только рекомендации по конкретной станции и топливу (сетевые тесты цены здесь не оцениваются)
    const m = String(r.dedupe_key).match(/^PRICE-\d+-(\d{3})-(.+)$/);
    if (!m) continue;
    const code = m[1];
    const fuel = m[2];
    const target = targetFromAction(r.action);
    const { rows: [pr] } = await db.query(
      `SELECT price::float AS p FROM azs.fuel_daily WHERE station_code = $1 AND fuel_code = $2 AND price > 0 ORDER BY sale_date DESC LIMIT 1`,
      [code, fuel]);
    const { rows: [vol] } = await db.query(
      `SELECT avg(sales_volume)::float AS q FROM azs.fuel_daily
        WHERE station_code = $1 AND fuel_code = $2 AND sale_date > $3::date - 7 AND sale_date <= $3::date`,
      [code, fuel, as_of]);
    const p0 = pr?.p ?? null;
    const q0 = vol?.q ?? null;
    const model = models[`${code}-${fuel}`];
    const e = model?.elasticity ?? null;
    const line = `${(r.station ?? '').padEnd(18)} ${fuel.padEnd(7)} ${fmt(p0, 2).padEnd(6)} ${fmt(target, 2).padEnd(6)}`;
    if (p0 === null || target === null || q0 === null) {
      console.log(line + ' нет данных для расчёта');
      continue;
    }
    const dp = target / p0 - 1;
    if (e === null) {
      console.log(line + ` ${pct(dp).padEnd(6)} —       ${fmt(q0, 0).padEnd(8)} —        —            не оценена (нет надёжной эластичности)`);
      continue;
    }
    const dVolPct = volumeChangeShare(p0, target - p0, e);
    const dRevPerDay = priceChangeEffect(p0, q0, target - p0, e);
    console.log(line + ` ${pct(dp).padEnd(6)} ${fmt(e, 2).padEnd(7)} ${fmt(q0, 0).padEnd(8)} ${pct(dVolPct).padEnd(8)} ${fmt(dRevPerDay, 0).padEnd(12)} оценка по модели`);
  }
  if (!active.length) console.log('(активных ценовых рекомендаций нет)');

  // ---------- 2. Фактический эффект выполненных рекомендаций ----------
  const { rows: done } = await db.query(`
    SELECT r.dedupe_key, r.fuel_type, r.completed_at::date::text AS done_on
      FROM recommendations r
     WHERE r.status = 'completed' AND r.rule_id LIKE 'PRICE-%' AND r.completed_at IS NOT NULL
     ORDER BY r.completed_at`);
  console.log('\n== 2. Фактический эффект выполненных рекомендаций (до/после ' + WINDOW_DAYS + ' дней)');
  if (!done.length) {
    console.log('(выполненных ценовых рекомендаций пока нет: сравнивать не с чем)');
  } else {
    console.log('станция/топливо          дата         Δобъёма  Δцены    Δвыручка ₽/д (факт)');
    for (const r of done) {
      const m = String(r.dedupe_key).match(/^PRICE-\d+-(\d{3})-(.+)$/);
      if (!m) continue;
      const [, code, fuel] = m;
      const { rows: [s] } = await db.query(`
        WITH daily AS (
          SELECT sale_date, avg(price)::float AS p, sum(sales_volume)::float AS q, sum(sales_volume * price)::float AS rev
            FROM azs.fuel_daily
           WHERE station_code = $1 AND fuel_code = $2 AND price > 0 AND sale_date <= $4::date
             AND sale_date >= $3::date - ${WINDOW_DAYS} AND sale_date < $3::date + ${WINDOW_DAYS}
           GROUP BY sale_date)
        SELECT
          avg(q) FILTER (WHERE sale_date < $3::date)  AS q_before,
          avg(q) FILTER (WHERE sale_date >= $3::date) AS q_after,
          avg(p) FILTER (WHERE sale_date < $3::date)  AS p_before,
          avg(p) FILTER (WHERE sale_date >= $3::date) AS p_after,
          avg(rev) FILTER (WHERE sale_date < $3::date)  AS rev_before,
          avg(rev) FILTER (WHERE sale_date >= $3::date) AS rev_after
          FROM daily`,
        [code, fuel, r.done_on, as_of]);
      const dq = s.q_before && s.q_after ? s.q_after / s.q_before - 1 : null;
      const dp = s.p_before && s.p_after ? s.p_after / s.p_before - 1 : null;
      const drev = s.rev_before !== null && s.rev_after !== null ? s.rev_after - s.rev_before : null;
      console.log(`${(code + ' ' + fuel).padEnd(24)} ${r.done_on}   ${pct(dq).padEnd(8)} ${pct(dp).padEnd(8)} ${fmt(drev, 0)}`);
    }
    console.log('Внимание: без контрольной группы; сравнение показывает изменение, а не доказанный эффект.');
  }

  console.log('\nМетодика: см. docs/RULES_FORMULAS.md и backend/src/scripts/effect-evaluation.ts.');
}

async function main(): Promise<void> {
  const pool = getRawPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.role', 'admin', false), set_config('app.user_id', '', false)");
    await requestScope.run({ client }, () => report(client));
  } finally {
    // Контекст не должен остаться в соединении, которое вернётся в пул
    await client.query('RESET app.role; RESET app.user_id').catch(() => undefined);
    client.release();
    await closeDatabasePool(pool);
  }
}

main().catch((error) => {
  console.error('Ошибка оценки эффектов:', error);
  process.exit(1);
});
