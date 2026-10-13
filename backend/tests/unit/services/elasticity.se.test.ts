/**
 * Ошибка Ньюи–Уэста (services/elasticity.service: neweyWestSe) на числах, посчитанных вручную.
 */
import { neweyWestSe, invert } from '@services/elasticity.service';

describe('neweyWestSe', () => {
  it('для константы при нулевом лаге совпадает с 1/√n (среднее одной выборки)', () => {
    // X = [1], остатки = 1, n наблюдений: (X'X)⁻¹ = 1/n, S = n → V = (1/n)·n·(1/n) = 1/n
    const n = 50;
    const X = Array.from({ length: n }, () => [1]);
    const resid = Array.from({ length: n }, () => 1);
    const inv = invert([[n]]) as number[][];
    const keys = Array.from({ length: n }, (_, i) => ({ station: 'A', day: i }));
    expect(neweyWestSe(X, resid, inv, keys, 0, 0)).toBeCloseTo(1 / Math.sqrt(n), 10);
  });

  it('положительно коррелированные остатки (один день подряд) увеличивают ошибку', () => {
    const n = 60;
    const X = Array.from({ length: n }, () => [1]);
    // остатки блоками по 10 дней одного знака: сильная автокорреляция
    const resid = Array.from({ length: n }, (_, i) => (Math.floor(i / 10) % 2 === 0 ? 1 : -1));
    const inv = invert([[n]]) as number[][];
    const keys = Array.from({ length: n }, (_, i) => ({ station: 'A', day: i }));
    const se0 = neweyWestSe(X, resid, inv, keys, 0, 0);
    const se7 = neweyWestSe(X, resid, inv, keys, 7, 0);
    expect(se7).toBeGreaterThan(se0);
  });

  it('автокорреляция не переносится между станциями', () => {
    const n = 40;
    const X = Array.from({ length: n }, () => [1]);
    const resid = Array.from({ length: n }, (_, i) => (Math.floor(i / 10) % 2 === 0 ? 1 : -1));
    const inv = invert([[n]]) as number[][];
    // каждое наблюдение — своя станция: соседних дней внутри станции нет
    const keys = Array.from({ length: n }, (_, i) => ({ station: `S${i}`, day: i }));
    expect(neweyWestSe(X, resid, inv, keys, 7, 0)).toBeCloseTo(neweyWestSe(X, resid, inv, keys, 0, 0), 10);
  });
});
