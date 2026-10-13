/**
 * Оценка эластичности спроса по цене (FR-5.2, PRICE-003).
 *
 * Одна станция и 90 дней дают слишком мало изменений цены и слишком много шума, поэтому оценка
 * делается по всем станциям сети сразу (панель) с контролями:
 *   ln(объём) = b·ln(цена) + фиксированный эффект станции + день недели + праздник + месяц + ε
 * Эластичность — коэффициент b. Значим, если |t| ≥ 2 и b < 0 (спрос падает с ценой).
 */
import { getPool } from '@config/database';

export interface Elasticity {
  fuel: string;
  scope: string;               // 'сеть' или код станции
  elasticity: number | null;   // b, если значим
  rawElasticity: number;       // b без проверки значимости
  se: number | null;
  t: number | null;
  r2: number | null;
  n: number;
  excludedDays: number;        // нерабочие дни станции, исключённые из оценки
  reliable: boolean;
  reason: string;              // почему надёжна или нет
}

/** Обращение матрицы методом Гаусса–Жордана; null — если матрица вырождена */
export function invert(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map(row => row.slice(n));
}

/**
 * Кэш оценок. Регрессия читает всю историю продаж, а одна страница вызывает её десятки раз
 * (сеть по каждому топливу и каждая станция отдельно). Запись кэша привязана к версии данных:
 * дата и число строк в azs.fuel_daily. После загрузки CSV версия меняется и кэш сбрасывается сам.
 */
const elasticityCache = new Map<string, { version: string; value: Elasticity }>();

/** Сброс кэша оценок (после загрузки данных) */
export function clearElasticityCache(): void {
  elasticityCache.clear();
}

export async function dataVersion(): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT max(sale_date)::text AS d, count(*)::text AS n FROM azs.fuel_daily`
  );
  return `${rows[0].d}|${rows[0].n}`;
}

/** Оценка эластичности с кэшем по версии данных (см. computePooledElasticity) */
// version — версия данных, если вызывающий её уже получил (не нужно спрашивать базу на каждую оценку)
export async function pooledElasticity(fuel: string, days: number, asOf: string, stationCode?: string, version?: string): Promise<Elasticity> {
  const key = [fuel, days, asOf, stationCode ?? '*'].join('|');
  const v = version ?? (await dataVersion());
  const hit = elasticityCache.get(key);
  if (hit && hit.version === v) return hit.value;
  const value = await computePooledElasticity(fuel, days, asOf, stationCode);
  elasticityCache.set(key, { version: v, value });
  return value;
}

/** Оценка по всем станциям сети для одного вида топлива за `days` дней до `asOf` */
/** Доля медианного дневного объёма, ниже которой день считается нерабочим */
export const CLOSED_DAY_SHARE = 0.1;

/**
 * Оценка по сети (stationCode не задан) или по одной станции (stationCode задан).
 * По станции фиксированного эффекта станции нет, выборка только этой станции.
 */
async function computePooledElasticity(fuel: string, days: number, asOf: string, stationCode?: string): Promise<Elasticity> {
  // Нерабочие дни станции исключаются: общий объём за день (все виды топлива) меньше
  // CLOSED_DAY_SHARE от медианного дневного объёма этой станции за окно.
  const all = await getPool().query(
    `WITH tot AS (
       SELECT station_code, sale_date, sum(sales_volume)::float AS t FROM azs.fuel_daily
        WHERE sale_date > $1::date - ($2 || ' days')::interval AND sale_date <= $1::date
        GROUP BY station_code, sale_date),
     med AS (SELECT station_code, percentile_cont(0.5) WITHIN GROUP (ORDER BY t) AS m FROM tot GROUP BY station_code)
     SELECT f.station_code, f.sale_date, f.sales_volume::float AS vol, f.price::float AS price,
            EXTRACT(ISODOW FROM c.cal_date)::int AS day_of_week, c.is_holiday, c.month, tot.t, med.m,
            f.sale_date::text AS d
       FROM azs.fuel_daily f
       JOIN azs.calendar c ON c.cal_date = f.sale_date
       JOIN tot ON tot.station_code = f.station_code AND tot.sale_date = f.sale_date
       JOIN med ON med.station_code = f.station_code
      WHERE f.fuel_code = $3 AND f.price > 0 AND f.sales_volume > 0
        AND ($4::text IS NULL OR f.station_code = $4)
        AND f.sale_date > $1::date - ($2 || ' days')::interval AND f.sale_date <= $1::date`,
    [asOf, days, fuel, stationCode ?? null]
  );
  // Нерабочие дни исключаем; наблюдения упорядочиваем по станции и дате (для автокорреляции)
  const rows = all.rows
    .filter(r => r.t >= CLOSED_DAY_SHARE * r.m)
    .sort((a, b) => (a.station_code < b.station_code ? -1 : a.station_code > b.station_code ? 1 : a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const excludedDays = all.rows.length - rows.length;
  const stations = [...new Set(rows.map(r => r.station_code))].sort();
  const dows = [2, 3, 4, 5, 6, 7];   // день недели, базовый — понедельник (1)
  // сезонность (месяц) идентифицируется только на окнах не короче полугода
  const months = days >= 180 ? [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : []; // базовый — январь
  const fail = (reason: string, n = rows.length): Elasticity => ({
    fuel, scope: stationCode ?? 'сеть', elasticity: null, rawElasticity: NaN, se: null, t: null, r2: null, n, excludedDays, reliable: false, reason
  });
  const minObs = stationCode ? 120 : 200;
  if (rows.length < minObs || (!stationCode && stations.length < 2)) return fail('мало наблюдений для оценки');

  // признаки: [1, ln цены, станции(кроме первой), дни недели, праздник, месяцы]
  const X: number[][] = [], y: number[] = [];
  for (const r of rows) {
    const lp = Math.log(r.price);
    const x = [1, lp];
    for (const s of stations.slice(1)) x.push(r.station_code === s ? 1 : 0);
    for (const d of dows) x.push(r.day_of_week === d ? 1 : 0);
    x.push(r.is_holiday ? 1 : 0);
    for (const m of months) x.push(r.month === m ? 1 : 0);
    X.push(x);
    y.push(Math.log(r.vol));
  }
  const n = X.length;
  // столбцы без вариации (например, праздников в окне нет) дают вырожденную матрицу — убираем.
  // Столбцы 0 (константа) и 1 (ln цены) всегда остаются.
  const width = X[0].length;
  const keep = [0, 1];
  for (let j = 2; j < width; j++) {
    // признак нужен, если он меняется в выборке (для дамми — есть и 0, и 1; для непрерывных — есть разброс)
    let mn = Infinity, mx = -Infinity;
    for (const row of X) { if (row[j] < mn) mn = row[j]; if (row[j] > mx) mx = row[j]; }
    if (mx > mn) keep.push(j);
  }
  const Xk = X.map(row => keep.map(j => row[j]));
  const k = keep.length;
  // нормальные уравнения
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < Xk.length; i++) {
    const xi = Xk[i];
    for (let a = 0; a < k; a++) {
      if (xi[a] === 0) continue;
      Xty[a] += xi[a] * y[i];
      for (let b = 0; b < k; b++) XtX[a][b] += xi[a] * xi[b];
    }
  }
  const inv = invert(XtX);
  if (!inv) return fail('признаки линейно зависимы (нет вариации цен)');
  const beta = inv.map(row => row.reduce((s, v, j) => s + v * Xty[j], 0));

  let rss = 0;
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  let tss = 0;
  const resid: number[] = [];
  for (let i = 0; i < Xk.length; i++) {
    const fit = Xk[i].reduce((s, v, j) => s + v * beta[j], 0);
    resid.push(y[i] - fit);
    rss += (y[i] - fit) ** 2;
    tss += (y[i] - meanY) ** 2;
  }
  const r2 = tss > 0 ? 1 - rss / tss : null;
  const b = beta[1];
  // Ошибка Ньюи–Уэста (окно 7 дней внутри станции): дневные остатки автокоррелированы,
  // классическая ошибка завышала бы значимость
  const se = neweyWestSe(Xk, resid, inv, rows.map(r => ({ station: r.station_code, day: Date.parse(r.d) / 86400000 })), 7, 1);
  const t = se > 0 ? b / se : null;

  // разброс цены: диапазон ln-цены по всей выборке (без станционных средних)
  // разброс внутри станции (после вычитания средней ln-цены станции): именно он идентифицирует эффект
  const byStation = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byStation.get(r.station_code) ?? [];
    arr.push(Math.log(r.price));
    byStation.set(r.station_code, arr);
  }
  let ss = 0, cnt = 0;
  for (const arr of byStation.values()) {
    const m = arr.reduce((a, c) => a + c, 0) / arr.length;
    for (const v of arr) ss += (v - m) ** 2;
    cnt += arr.length;
  }
  const spread = Math.sqrt(ss / cnt);
  let reason = 'значима';
  let reliable = true;
  if (spread < 0.02) { reliable = false; reason = 'цена почти не менялась'; }
  else if (t === null || Math.abs(t) < 2) { reliable = false; reason = 'эффект цены не отличим от нуля (|t| < 2)'; }
  else if (b >= 0) { reliable = false; reason = 'оценка положительная: спрос не падает с ценой'; }
  else if (b < -10) { reliable = false; reason = 'оценка нереалистично велика'; }

  return {
    fuel,
    scope: stationCode ?? 'сеть',
    elasticity: reliable ? round(b) : null,
    rawElasticity: round(b),
    se: round(se),
    t: t === null ? null : round(t),
    r2: r2 === null ? null : round(r2, 3),
    n,
    excludedDays,
    reliable,
    reason
  };
}

/**
 * Стандартная ошибка коэффициента `coef` по Ньюи–Уэсту (ядро Бартлетта, окно `lag`).
 * Автокорреляция учитывается только внутри станции: наблюдения сопоставляются по (станция, день).
 *   V = (X'X)⁻¹ · S · (X'X)⁻¹,   S = Σ_t s_t s_t' + Σ_l w_l Σ_t (s_t s_{t−l}' + s_{t−l} s_t'),  s_t = x_t·e_t
 */
export function neweyWestSe(X: number[][], resid: number[], inv: number[][], keys: { station: string; day: number }[], lag: number, coef: number): number {
  const k = inv.length;
  const index = new Map<string, number>();
  keys.forEach((kk, i) => index.set(`${kk.station}|${kk.day}`, i));
  const score = X.map((row, i) => row.map(v => v * resid[i]));
  const S: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const add = (s: number[], t: number[], w: number) => {
    for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) S[a][b] += w * s[a] * t[b];
  };
  for (let i = 0; i < X.length; i++) {
    add(score[i], score[i], 1);
    for (let l = 1; l <= lag; l++) {
      const j = index.get(`${keys[i].station}|${keys[i].day + l}`);
      if (j === undefined) continue;
      const w = 1 - l / (lag + 1);
      add(score[i], score[j], w);
      add(score[j], score[i], w);
    }
  }
  const tmp: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, b) => { let s = 0; for (let a = 0; a < k; a++) s += inv[i][a] * S[a][b]; return s; }));
  const V = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => { let s = 0; for (let b = 0; b < k; b++) s += tmp[i][b] * inv[b][j]; return s; }));
  return Math.sqrt(Math.max(V[coef][coef], 0));
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
