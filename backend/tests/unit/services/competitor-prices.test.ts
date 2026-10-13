/**
 * Текущая цена конкурентов (services/rules.service: competitorLatestPrices).
 */
import { competitorLatestPrices } from '@services/rules.service';

describe('competitorLatestPrices', () => {
  it('берёт последнее наблюдение каждой АЗС, а не первое', () => {
    const obs = [
      { competitor_id: 1, ts: '2026-09-19 01:00:00', price: 79 },
      { competitor_id: 1, ts: '2026-09-21 01:00:00', price: 80 },
      { competitor_id: 2, ts: '2026-09-20 02:00:00', price: 81 }
    ];
    expect(competitorLatestPrices(obs).sort()).toEqual([80, 81]);
  });

  it('две АЗС одного бренда дают два значения', () => {
    const obs = [
      { competitor_id: 8, ts: '2026-09-21 01:01:00', price: 79.87 },
      { competitor_id: 10, ts: '2026-09-21 01:02:00', price: 78.66 }
    ];
    expect(competitorLatestPrices(obs).sort()).toEqual([78.66, 79.87]);
  });

  it('две цены в одну минуту дают среднее, округлённое до копеек', () => {
    const obs = [
      { competitor_id: 9, ts: '2026-09-21 02:01:00', price: 80 },
      { competitor_id: 9, ts: '2026-09-21 02:01:00', price: 81.9 }
    ];
    expect(competitorLatestPrices(obs)).toEqual([80.95]);
  });

  it('среднее берётся только из последней минуты, предыдущие цены не учитываются', () => {
    const obs = [
      { competitor_id: 9, ts: '2026-09-20 02:01:00', price: 70 },
      { competitor_id: 9, ts: '2026-09-21 02:01:00', price: 80 },
      { competitor_id: 9, ts: '2026-09-21 02:01:00', price: 82 },
      { competitor_id: 9, ts: '2026-09-21 02:01:00', price: 81 }
    ];
    expect(competitorLatestPrices(obs)).toEqual([81]);
  });

  it('пустой список даёт пустой результат', () => {
    expect(competitorLatestPrices([])).toEqual([]);
  });
});
