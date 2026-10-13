/**
 * Расчёт эффекта изменения цены (services/rules.service: priceChangeEffect, volumeChangeShare).
 * Модель: постоянная эластичность e, V = V₀·(p/p₀)^e. Выручка R = p·V.
 * ΔR = V₀·p₀·((1+Δ/p₀)^(1+e) − 1). Проверка на числах, посчитанных вручную.
 */
import { priceChangeEffect, volumeChangeShare, priceTargetDecision } from '@services/rules.service';

describe('priceTargetDecision (действие PRICE-001 по знаку эффекта)', () => {
  it('подъём цены при эластичном спросе снижает выручку: «Установить цену» не выводится', () => {
    // DT: e = −2,45, подъём 79,09 → 80,10, выручка падает
    const d = priceTargetDecision(80.1, -2.45, -55102);
    expect(d.lowersRevenue).toBe(true);
    expect(d.action).toContain('Цену не менять');
    expect(d.action).not.toContain('Установить цену');
  });

  it('подъём цены, который увеличивает выручку, остаётся указанием', () => {
    const d = priceTargetDecision(80.1, -0.5, 1500);
    expect(d.lowersRevenue).toBe(false);
    expect(d.action).toBe('Установить цену 80.10 ₽/л');
  });

  it('без оценки эластичности остаётся ориентиром, даже если эффекта нет', () => {
    const d = priceTargetDecision(80.1, null, null);
    expect(d.lowersRevenue).toBe(false);
    expect(d.action).toBe('Ориентир 80.10 ₽/л (эффект не оценён)');
  });
});

describe('priceChangeEffect (выручка в день при изменении цены)', () => {
  it('снижение цены на 5% при неэластичном спросе (e = −0,5) уменьшает выручку', () => {
    // p₀ = 70, V₀ = 1000, Δ = −3,5: ΔR = 1000·70·(0,95^0,5 − 1) ≈ −1772
    const v = priceChangeEffect(70, 1000, -3.5, -0.5);
    expect(v).toBeLessThan(0);
    expect(v).toBe(Math.round(1000 * 70 * (Math.sqrt(0.95) - 1)));
  });

  it('снижение цены на 5% при эластичном спросе (e = −1,5) увеличивает выручку', () => {
    // ΔR = 1000·70·(0,95^(−0,5) − 1) ≈ +1819
    const v = priceChangeEffect(70, 1000, -3.5, -1.5);
    expect(v).toBeGreaterThan(0);
    expect(v).toBe(Math.round(1000 * 70 * (0.95 ** -0.5 - 1)));
  });

  it('при нулевой эластичности выручка меняется ровно на объём × изменение цены', () => {
    // e = 0: объём не меняется, ΔR = V₀·Δ = 1000·(−3,5) = −3500
    expect(priceChangeEffect(70, 1000, -3.5, 0)).toBe(-3500);
  });

  it('при единичной эластичности (e = −1) выручка не меняется', () => {
    expect(priceChangeEffect(70, 1000, -3.5, -1)).toBe(0);
  });

  it('повышение цены при неэластичном спросе увеличивает выручку', () => {
    expect(priceChangeEffect(70, 1000, 2, -0.5)).toBeGreaterThan(0);
  });

  it('нулевое изменение цены или нулевой объём дают 0', () => {
    expect(priceChangeEffect(70, 1000, 0, -0.5)).toBe(0);
    expect(priceChangeEffect(70, 0, -3.5, -0.5)).toBe(0);
  });

  it('результат округляется до рублей', () => {
    expect(Number.isInteger(priceChangeEffect(70, 1234, -1.7, -0.9))).toBe(true);
  });
});

describe('volumeChangeShare (доля изменения объёма)', () => {
  it('при снижении цены на 5% и e = −1,5 объём растёт на 0,95^(−1,5) − 1', () => {
    expect(volumeChangeShare(70, -3.5, -1.5)).toBeCloseTo(0.95 ** -1.5 - 1, 10);
  });

  it('согласован с выручкой: V₁·p₁ − V₀·p₀ равно ΔR на единицу объёма', () => {
    const p0 = 70;
    const delta = -3.5;
    const e = -0.7;
    const volume = 1000;
    const share = volumeChangeShare(p0, delta, e);
    const revChange = volume * (1 + share) * (p0 + delta) - volume * p0;
    expect(Math.abs(revChange - priceChangeEffect(p0, volume, delta, e))).toBeLessThanOrEqual(0.5);
  });
});
