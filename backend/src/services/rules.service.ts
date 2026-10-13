/**
 * Расчёт правил из AI_Agent_Rules по реальным данным схемы azs.
 *
 * Считаются только правила, для которых в базе есть входные данные:
 *   PRICE-001  выравнивание цены с конкурентами
 *   PRICE-002  избыточная премия к конкурентам
 *   PRICE-004  тест цены при ненадёжной модели (R² < 0.36)
 *   COMP-001   экстренная реакция на снижение цены конкурента
 *   TRAFFIC-002 рост трафика
 *   PROMO-003  частота акций
 * Остальные правила перечислены с причиной, почему их нельзя посчитать.
 */
import { getPool } from '@config/database';
import { logger } from '@utils/logger';
import { getRuleSettings } from '@services/settings.service';
import { pooledElasticity, dataVersion, Elasticity } from '@services/elasticity.service';

/** Обработка списка с ограничением параллельных запросов к базе */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
import { extraRules } from '@services/rules-extra.service';

const FUELS = ['AI92', 'AI95', 'DT']; // топливо, которое есть и у нас, и у конкурентов

export type Priority = 'URGENT' | 'HIGH' | 'MEDIUM' | 'LOW';

/**
 * Изменение объёма при изменении цены с p₀ на p₀ + Δ при постоянной эластичности e:
 *   V = V₀·(p/p₀)^e  →  доля изменения объёма = (1 + Δ/p₀)^e − 1.
 */
export function volumeChangeShare(p0: number, deltaPrice: number, elasticity: number): number {
  return (1 + deltaPrice / p0) ** elasticity - 1;
}

/**
 * Изменение выручки в ₽ в день при изменении цены с p₀ на p₀ + Δ (постоянная эластичность e):
 *   R = p·V = p·V₀·(p/p₀)^e  →  ΔR = V₀·p₀·((1 + Δ/p₀)^(1+e) − 1).
 * Знак важен: при |e| < 1 снижение цены уменьшает выручку, при |e| > 1 — увеличивает.
 * Чистая функция: проверяется на известных числах (tests/unit/services/rules.effect.test.ts).
 */
export function priceChangeEffect(p0: number, volumePerDay: number, deltaPrice: number, elasticity: number): number {
  // || 0 убирает -0, который дают округление и умножение на отрицательные числа
  return Math.round(volumePerDay * p0 * ((1 + deltaPrice / p0) ** (1 + elasticity) - 1)) || 0;
}

export interface RuleRecommendation {
  id: string;
  rule: string;
  title: string;
  station: string;
  fuel: string | null;
  priority: Priority;
  effect: string;
  action: string;
  reason: string;
}

const median = (a: number[]): number | null => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Линейная регрессия: наклон и R² */
function linreg(x: number[], y: number[]): { slope: number; r2: number } | null {
  const n = x.length;
  if (n < 10) return null;
  const mx = mean(x) as number, my = mean(y) as number;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return { slope: sxy / sxx, r2: (sxy * sxy) / (sxx * syy) };
}

const stationCode = (name: string): string | null => {
  const m = name.match(/(\d{3})$/);
  return m ? m[1] : null;
};

const dayDiff = (a: string, b: string) =>
  (Date.parse(a) - Date.parse(b)) / 86400000;

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

// ---------- Кэш ответа расчёта правил ----------
// Расчёт тяжёлый (выборки продаж, трафика, цен конкурентов). Ответ кэшируется по версии всех
// таблиц, от которых он зависит, и по настройкам. Кэш сбрасывается после загрузки данных
// и в любом случае устаревает через RULES_CACHE_TTL_MS.
const RULES_CACHE_TTL_MS = 10 * 60 * 1000;
const rulesCache = new Map<string, { version: string; at: number; value: any }>();

/** Версия данных для правил: количество строк и последние даты/метки каждой таблицы */
async function rulesDataVersion(): Promise<string> {
  const { rows } = await getPool().query(`
    SELECT
      (SELECT max(sale_date)::text || '|' || count(*) FROM azs.fuel_daily) AS fuel,
      (SELECT max(sale_date)::text || '|' || count(*) FROM azs.shop_sales_daily) AS shop,
      (SELECT max(traffic_date)::text || '|' || count(*) FROM azs.traffic_daily) AS traffic,
      (SELECT max(observed_at)::text || '|' || count(*) FROM azs.competitor_price) AS comp_price,
      (SELECT count(*)::text FROM azs.competitor) AS comp,
      (SELECT max(weather_date)::text || '|' || count(*) FROM azs.weather_daily) AS weather,
      (SELECT count(*)::text FROM azs.promotion) AS promo,
      (SELECT count(*)::text || '|' || coalesce(max(name), '') FROM public.azs) AS stations`);
  return Object.values(rows[0]).join('#');
}

/** Ответ расчёта правил с кэшем (для маршрута /api/analysis/rules) */
export async function computeRulesCached() {
  const version = await rulesDataVersion();
  const key = JSON.stringify(await getRuleSettings());
  const hit = rulesCache.get(key);
  if (hit && hit.version === version && Date.now() - hit.at < RULES_CACHE_TTL_MS) return hit.value;
  const value = await computeRules();
  rulesCache.set(key, { version, at: Date.now(), value });
  return value;
}

/** Сброс кэша расчёта правил (после загрузки данных) */
export function clearRulesCache(): void {
  rulesCache.clear();
}

// Прогрев: расчёт в фоне, чтобы первый пользователь не ждал холодного расчёта.
// Повторные запуски пока расчёт идёт не создают новых (параллельные импорты дают один прогрев).
let warming: Promise<void> | null = null;
// Пулер Supabase при старте иногда не отвечает: до трёх попыток с паузой
export function warmRulesCache(attempt = 1): void {
  if (warming) return;
  warming = computeRulesCached()
    .then(() => undefined)
    .catch((e) => {
      logger.warn('Прогрев кэша правил не выполнен', 'RULES', { attempt, error: String(e?.message || e) });
      if (attempt < 3) setTimeout(() => warmRulesCache(attempt + 1), 15000).unref();
    })
    .finally(() => { warming = null; });
}

export async function computeRules(override?: { elasticityDays?: number }) {
  const pool = getPool();
  // пороги и окна — из настроек (FR-5.10), по умолчанию из AI_Agent_Rules
  // окно эластичности можно переопределить запросом (7, 28, 90, 365 дней), настройка не меняется
  const S = { ...(await getRuleSettings()), ...(override?.elasticityDays ? { elasticity_days: override.elasticityDays } : {}) };

  // 1. Станции: публичная таблица azs ↔ код станции из схемы azs
  const { rows: stations } = await pool.query(`SELECT id::text, name FROM public.azs ORDER BY name`);
  const stationList = stations
    .map(s => ({ id: s.id, name: s.name, code: stationCode(s.name) }))
    .filter(s => s.code);

  const stationNames = new Map<string, string>(stationList.map(x => [x.code as string, x.name]));

  // 2. Дата расчёта — последний день с известной ценой
  const { rows: [{ as_of }] } = await pool.query(
    `SELECT max(sale_date)::text AS as_of FROM azs.fuel_daily WHERE price IS NOT NULL`
  );
  const asOf: string = as_of;

  // 3. Наши продажи и цены за S.elasticity_days
  const { rows: fuelRows } = await pool.query(
    `SELECT station_code, sale_date::text AS d, fuel_code, sales_volume::float AS vol, price::float AS price
       FROM azs.fuel_daily
      WHERE sale_date > $1::date - ($2 || ' days')::interval
        AND sale_date <= $1::date AND fuel_code = ANY($3)`,
    [asOf, S.elasticity_days, FUELS]
  );

  // 4. Наблюдения конкурентов за 30 дней (с брендом)
  const { rows: compRows } = await pool.query(
    `SELECT c.station_code, c.brand, cp.fuel_code, cp.observed_at::date::text AS d,
            cp.observed_at::text AS ts, cp.price::float AS price
       FROM azs.competitor_price cp JOIN azs.competitor c USING (competitor_id)
      WHERE cp.is_offered AND cp.price > 0
        AND cp.observed_at::date > $1::date - ($2 || ' days')::interval
        AND cp.observed_at::date <= $1::date AND cp.fuel_code = ANY($3)
      ORDER BY cp.observed_at`,
    [asOf, S.price_window_days, FUELS]
  );

  // 5. Трафик за 28 дней
  const { rows: trafRows } = await pool.query(
    `SELECT station_code, traffic_date::text AS d, cars::float AS cars
       FROM azs.traffic_daily
      WHERE traffic_date > $1::date - interval '28 days' AND traffic_date <= $1::date`,
    [asOf]
  );

  // 6. Акции, действующие в последние 30 дней (сеть целиком)
  const { rows: [promo] } = await pool.query(
    `SELECT count(*)::int AS n FROM azs.promotion
      WHERE start_date IS NOT NULL
        AND start_date <= $1::date AND (validity = 'бессрочно' OR end_date >= $1::date - interval '30 days')`,
    [asOf]
  );

  const out: RuleRecommendation[] = [];
  const modelInfo: Record<string, { elasticity: number | null; se: number | null; n: number; r2: number | null; source: string | null; stationR2: number | null; networkR2: number | null; reason: string | null }> = {};
  // эластичность по всей сети (панель с контролями) — одна оценка на вид топлива
  // оценка по сети и по каждой станции; для станции берём её оценку, если она значима, иначе сетевую
  // Версия данных одна на весь расчёт; оценки считаются параллельно, но не более 5 запросов сразу
  const version = await dataVersion();
  const pooled = new Map<string, Elasticity>();
  const fuelEls = await mapLimit(FUELS, 5, (f) => pooledElasticity(f, S.elasticity_days, asOf, undefined, version));
  FUELS.forEach((f, i) => pooled.set(f, fuelEls[i]));
  const stationEl = new Map<string, Elasticity>();
  const pairs = stationList.flatMap(st => FUELS.map(f => ({ st, f })));
  const pairEls = await mapLimit(pairs, 5, ({ st, f }) => pooledElasticity(f, S.elasticity_days, asOf, st.code as string, version));
  pairs.forEach(({ st, f }, i) => stationEl.set(`${st.code}-${f}`, pairEls[i]));

  // ---- по станциям и топливу ----
  // пары, где эластичность не значима: сводятся в одну рекомендацию PRICE-004 после цикла
  const weakPairs: { name: string; why: string; insufficient: boolean }[] = [];
  for (const st of stationList) {
    const code = st.code as string;

    // Трафик: PRICE/TRAFFIC-002
    const traf = trafRows.filter(r => r.station_code === code).sort((a, b) => a.d.localeCompare(b.d));
    if (traf.length >= 14) {
      const reg = linreg(traf.map((_, i) => i), traf.map(r => r.cars));
      if (reg && reg.slope > S.traffic_slope_min) {
        out.push({
          id: `TRAFFIC-002-${code}`, rule: 'TRAFFIC-002', title: 'Растущий трафик',
          station: st.name, fuel: null, priority: 'MEDIUM',
          effect: `Рост трафика ${reg.slope.toFixed(2)} авт./день`,
          action: 'Рассмотреть оптимизацию цены для захвата новых клиентов',
          reason: 'Тренд трафика за 28 дней по traffic_daily. Доля захвата не рассчитана: нет объёма рынка.'
        });
      }
    }

    for (const fuel of FUELS) {
      const series = fuelRows
        .filter(r => r.station_code === code && r.fuel_code === fuel)
        .sort((a, b) => a.d.localeCompare(b.d));
      const withPrice = series.filter(r => r.price > 0);
      if (!withPrice.length) continue;
      const last = withPrice[withPrice.length - 1];
      const ourPrice = last.price;
      const ourDate = last.d;

      // Эластичность: ln(объём) от ln(цены) по дням с продажами
      const pts = series.filter(r => r.price > 0 && r.vol > 0);
      const own = stationEl.get(`${code}-${fuel}`) as Elasticity;
      const net = pooled.get(fuel) as Elasticity;
      const pe = own.reliable ? own : net;
      const elasticity = pe.elasticity;
      const elasticitySource = own.reliable ? 'станция' : net.reliable ? 'сеть' : null;
      // причина показывается, когда оценка не значима: это причина по самой станции
      modelInfo[`${code}-${fuel}`] = { elasticity, se: pe.se, n: pe.n, r2: pe.r2, source: elasticitySource, stationR2: own.r2, networkR2: net.r2, reason: elasticity === null ? own.reason : null };

      // Средний объём за 7 дней и предыдущие 7 дней
      const last7 = series.filter(r => dayDiff(asOf, r.d) < 7).map(r => r.vol);
      const prev7 = series.filter(r => dayDiff(asOf, r.d) >= 7 && dayDiff(asOf, r.d) < 14).map(r => r.vol);
      const volMa7 = mean(last7);
      const volTrendPct = volMa7 !== null && mean(prev7) ? (volMa7 / (mean(prev7) as number) - 1) * 100 : null;

      // Конкуренты: последнее наблюдение каждого бренда за 14 дней
      const comp = compRows.filter(r => r.station_code === code && r.fuel_code === fuel && dayDiff(asOf, r.d) < S.comp_window_days);
      const lastByBrand = new Map<string, number>();
      for (const r of comp) lastByBrand.set(r.brand, r.price); // comp отсортирован по времени
      const compPrices = [...lastByBrand.values()];
      const compMed = median(compPrices);
      const compMax = compPrices.length ? Math.max(...compPrices) : null;

      // PRICE-001: выравнивание с медианой конкурентов
      if (compMed !== null && Math.abs(ourPrice - compMed) > S.price_gap_min) {
        const gap = ourPrice - compMed;
        const absGap = Math.abs(gap);
        const priority: Priority = absGap > S.price_gap_urgent ? 'URGENT' : 'HIGH';
        const target = gap > 0 ? compMed - 0.1 : compMed + 0.1;
        // эффект считается всегда, когда есть продажи и отрицательная точечная оценка:
        // значимая — как есть, незначимая — с пометкой низкой надёжности
        // точечная оценка самой станции (а не сетевой резерв), если она есть
        const rawE = Number.isFinite(own.rawElasticity) ? own.rawElasticity : Number.isFinite(pe.rawElasticity) ? pe.rawElasticity : null;
        const effEl = elasticity !== null ? elasticity : rawE !== null && rawE < 0 ? rawE : null;
        // Выручка в день при переходе на цель (знак важен: при неэластичном спросе снижение цены уменьшает выручку)
        const dRev = effEl !== null && volMa7 !== null ? priceChangeEffect(ourPrice, volMa7, target - ourPrice, effEl) : null;
        const effect = dRev !== null
          ? `≈ ${dRev >= 0 ? '+' : '−'}${Math.abs(dRev)} ₽/день (${elasticity !== null ? 'оценка по эластичности' : 'низкая надёжность, эластичность'} ${effEl.toFixed(2)})`
          : 'эффект не рассчитан: нет продаж или эластичность не определена';
        out.push({
          id: `PRICE-001-${code}-${fuel}`, rule: 'PRICE-001', title: 'Выравнивание цены с рынком',
          station: st.name, fuel, priority, effect,
          // без оценки эластичности цена — только ориентир, а не указание
          action: elasticity !== null ? `Установить цену ${target.toFixed(2)} ₽/л` : `Ориентир ${target.toFixed(2)} ₽/л (эффект не оценён)`,
          reason: `Цена ${ourPrice.toFixed(2)} ₽ (на ${ourDate}), медиана конкурентов ${compMed.toFixed(2)} ₽, разрыв ${gap.toFixed(2)} ₽`
        });
      }

      // PRICE-002: премия к конкурентам при падении объёма
      if (compMed !== null && ourPrice > compMed && volTrendPct !== null && volTrendPct < S.premium_drop_pct) {
        const above = compMax !== null && ourPrice > compMax;
        out.push({
          id: `PRICE-002-${code}-${fuel}`, rule: 'PRICE-002', title: 'Избыточная премия к конкурентам',
          station: st.name, fuel, priority: above ? 'HIGH' : 'MEDIUM',
          effect: `Объём за 7 дней ${volTrendPct.toFixed(1)}% к предыдущим 7 дням`,
          action: `Снизить цену на ${(ourPrice - compMed).toFixed(2)} ₽ или запустить промо`,
          reason: above ? 'Цена выше максимума конкурентов и объём падает' : 'Цена выше медианы конкурентов и объём падает'
        });
      }

      // PRICE-004: эластичность не значима — копим пару, рекомендация одна на все пары
      if (!pe.reliable && pts.length >= 30) {
        weakPairs.push({
          name: `${st.name} · ${fuel}`,
          why: own.reason,
          insufficient: own.reason.startsWith('мало наблюдений')
        });
      }

      // COMP-001: снижение цены конкурента на ≥0.4 ₽ с падением объёма ≥30%
      for (const brand of new Set(comp.map(r => r.brand))) {
        const obs = comp.filter(r => r.brand === brand);
        if (obs.length < 2) continue;
        const cur = obs[obs.length - 1];
        const prevObs = obs.filter(r => dayDiff(cur.d, r.d) >= 3 && dayDiff(cur.d, r.d) <= 14);
        if (!prevObs.length) continue;
        const before = prevObs[prevObs.length - 1];
        const drop = cur.price - before.price;
        if (drop <= S.comp_drop_min) {
          const v3 = fuelRows.filter(r => r.station_code === code && r.fuel_code === fuel && dayDiff(asOf, r.d) < 3).map(r => r.vol);
          const v7 = fuelRows.filter(r => r.station_code === code && r.fuel_code === fuel && dayDiff(asOf, r.d) >= 3 && dayDiff(asOf, r.d) < 10).map(r => r.vol);
          const reaction = mean(v3) !== null && mean(v7) ? (mean(v3) as number) / (mean(v7) as number) - 1 : null;
          if (reaction !== null && reaction <= S.comp_reaction_min) {
            out.push({
              id: `COMP-001-${code}-${fuel}-${brand}`, rule: 'COMP-001', title: 'Конкурент снизил цену',
              station: st.name, fuel, priority: 'URGENT',
              effect: `Объём упал на ${Math.abs(reaction * 100).toFixed(0)}%`,
              action: `Варианты: снизить на 0.20 ₽ (вернуть ~70% объёма) или на 0.35 ₽ (вернуть ~95%)`,
              reason: `${brand} снизил цену на ${Math.abs(drop).toFixed(2)} ₽ за ${dayDiff(cur.d, before.d)} дн. Расстояние до конкурента (500 м) в данных не проверено.`
            });
          }
        }
      }
    }
  }

  if (weakPairs.length) {
    // тест предлагается, только если есть данные для оценки; пары с малым числом наблюдений — приоритет LOW
    const hasTestable = weakPairs.some(p => !p.insufficient);
    const step = S.ab_step.toFixed(1).replace('.', ',');
    out.push({
      id: 'PRICE-004-SUMMARY', rule: 'PRICE-004',
      title: `Эластичность не оценена для ${weakPairs.length} из ${Object.keys(modelInfo).length} пар`,
      station: 'Вся сеть', fuel: null,
      priority: hasTestable ? 'MEDIUM' : 'LOW',
      effect: 'Прогноз объёма при изменении цены по этим парам не строится',
      action: hasTestable
        ? `Провести A/B тест цены на парах с вариацией: уровни ±${step} ₽ от текущей цены, по 2 дня каждая`
        : 'Собрать данные: накопления наблюдений для оценки эластичности по парам',
      reason: weakPairs.map(p => `${p.name}: ${p.why}`).join('; ')
    });
  }

  // Сетевые рекомендации по эластичности (вся сеть, по каждому виду топлива)
  for (const f of FUELS) {
    const net = pooled.get(f) as Elasticity;
    if (net.reliable) {
      out.push({
        id: `NET-PRICE-${f}`, rule: 'PRICE-003', title: 'Спрос по сети чувствителен к цене', station: 'Вся сеть', fuel: f,
        priority: 'LOW',
        effect: `Эластичность по сети ${net.elasticity} (t ${net.t})`,
        action: `При росте цены на 1% объём по сети меняется примерно на ${net.elasticity}% — учитывать при сетевых изменениях цены`,
        reason: `Оценка по всей сети за ${S.elasticity_days} дн., контроли: станция, день недели, праздник, месяц (n=${net.n})`
      });
    } else {
      out.push({
        id: `NET-TEST-${f}`, rule: 'PRICE-004', title: 'Сетевой тест цены', station: 'Вся сеть', fuel: f,
        priority: 'MEDIUM',
        effect: 'Нужны данные для надёжной оценки эластичности по сети',
        action: 'Провести контролируемый тест цены по сети (блоки по 2 дня, уровни ±0,5–1 ₽)',
        reason: `По сети эластичность не значима: ${net.reason} (n=${net.n})`
      });
    }
  }

  // Сетевой трафик: изменение легковых машин за 28 дней к предыдущим 28
  const trafficNet = await pool.query(
    `SELECT avg(CASE WHEN d > $1::date - 28 THEN cars END)::float AS cur,
            avg(CASE WHEN d <= $1::date - 28 AND d > $1::date - 56 THEN cars END)::float AS prev
       FROM (SELECT traffic_date AS d, sum(cars)::float AS cars FROM azs.traffic_daily GROUP BY traffic_date) x`,
    [asOf]
  );
  const tc = trafficNet.rows[0];
  if (tc && tc.cur && tc.prev) {
    const change = (tc.cur / tc.prev - 1) * 100;
    if (Math.abs(change) >= 5) {
      out.push({
        id: 'NET-TRAFFIC', rule: 'TRAFFIC-002', title: change > 0 ? 'Рост трафика по сети' : 'Падение трафика по сети', station: 'Вся сеть', fuel: null,
        priority: change > 0 ? 'MEDIUM' : 'HIGH',
        effect: `Легковые по сети ${change > 0 ? '+' : ''}${round(change, 1)}% за 28 дн.`,
        action: change > 0 ? 'Использовать рост трафика: усилить предложения для проезжающих машин' : 'Выяснить причину падения трафика по сети: сезон, дорожные работы, конкуренты у трассы',
        reason: 'Сумма легковых машин по всем станциям, среднее в день: последние 28 дней к предыдущим 28'
      });
    }
  }

  // PROMO-003: частота акций (по сети)
  const promoN = promo?.n ?? 0;
  out.push({
    id: 'PROMO-003-NETWORK', rule: 'PROMO-003', title: 'Частота акций',
    station: 'Вся сеть', fuel: null,
    priority: promoN >= S.promo_limit ? 'HIGH' : 'LOW',
    effect: `Активных акций за 30 дней: ${promoN}`,
    action: promoN >= S.promo_limit
      ? 'Сделать 4-недельный перерыв перед следующей акцией'
      : promoN === 1 ? 'Следующую акцию можно провести не ранее чем через 2 недели' : 'Акции долго не было: подходящий момент для нового предложения',
    reason: 'Акции из azs.promotion: сеть «Татнефть-АЗС-Запад», охват по сети'
  });

  // Правила, которые нельзя посчитать из текущих данных
  // дополнительные правила (COMP-002, COMP-003, TRAFFIC-001/003, PROMO-002, SHOP-001)
  const extra = await extraRules(asOf, stationNames);
  out.push(...(extra.recs as any[]));
  // правила, которые нельзя посчитать по текущим данным
  const notComputed = [
    { rule: 'PRICE-003', reason: 'Нужна себестоимость для оптимальной цены' },
    { rule: 'PRICE-005', reason: 'Нет себестоимости: проверка цены ниже себестоимости невозможна' },
    { rule: 'PROMO-001', reason: 'Нет скидки, стоимости акции и прироста объёма: ROI не считается' },
    { rule: 'SHOP-002', reason: 'Нет маржи по товарам магазина' },
    { rule: 'SHOP-003', reason: 'Нет данных о чеках (корзинах покупок): перекрёстные продажи не считаются' },
    { rule: 'SHOP-004', reason: 'Нет данных об ассортименте конкурентов' }
  ];

  const order: Priority[] = ['URGENT', 'HIGH', 'MEDIUM', 'LOW'];
  out.sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority));

  return {
    asOfDate: asOf,
    fuels: FUELS,
    windows: { priceDays: S.price_window_days, competitorDays: S.comp_window_days, elasticityDays: S.elasticity_days, r2Min: S.r2_min },
    models: modelInfo,
    recommendations: out,
    compElasticity: extra.compElasticity,
    notComputed
  };
}
