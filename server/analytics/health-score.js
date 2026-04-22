// Deterministic health-score calculator.
//
// The score is a weighted composite of six components that a reasonable
// analyst would look at first when judging an Austrian SME:
//
//   1. Eigenkapitalquote (25%)  — solvency cushion
//   2. Umsatz-CAGR 3y  (20%)   — top-line trajectory
//   3. JÜ-Marge         (20%)   — bottom-line quality
//   4. Reporting-Kontinuität (15%) — how many consecutive years filed
//   5. Mitarbeiter-Δ    (10%)   — team trajectory
//   6. Bilanz-CAGR 3y   (10%)   — balance growth
//
// Every component is squashed into [0, 1] and multiplied by its weight.
// The final score is rounded to an integer 0–100. The grade buckets:
//    >=85 AAA, 75-84 AA, 65-74 A, 50-64 B, <50 C.
//
// Any missing input is simply excluded from the weighted average — the
// weight is redistributed pro-rata so that sparsely-reporting companies
// still get a sensible score instead of always landing in the bottom.

const WEIGHTS = {
  ekQuote: 0.25,
  umsatzCAGR: 0.20,
  margin: 0.20,
  continuity: 0.15,
  employees: 0.10,
  bilanzCAGR: 0.10,
};

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// Logistic mapping: center around `mean` with steepness `k`.
function sigmoid(x, mean = 0.3, k = 8) {
  return 1 / (1 + Math.exp(-k * (x - mean)));
}

// Bounded linear mapping: -cap..cap → 0..1 with +0% = 0.5
function symmetricRatio(x, cap = 0.5) {
  if (x == null || !Number.isFinite(x)) return null;
  const t = Math.max(-cap, Math.min(cap, x));
  return clamp01(0.5 + t / (2 * cap));
}

function cagr(firstValue, lastValue, years) {
  if (firstValue == null || lastValue == null || !years || firstValue <= 0) return null;
  const ratio = lastValue / firstValue;
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  return Math.pow(ratio, 1 / years) - 1;
}

/**
 * Compute a health score for a company from its per-year financial rows.
 * `rows` must be sorted ascending by stichtag.
 * @returns { score, grade, breakdown: Array<{key, value, weight, contribution, explanation}> }
 */
export function computeHealthScore(rows) {
  if (!rows || rows.length === 0) {
    return { score: null, grade: null, breakdown: [] };
  }
  const latest = rows[rows.length - 1];
  const components = [];

  // 1. Eigenkapitalquote
  if (latest.ek_quote != null) {
    const v = sigmoid(latest.ek_quote, 0.3, 8);
    components.push({
      key: 'ekQuote',
      label: 'Eigenkapitalquote',
      value: latest.ek_quote,
      normalised: v,
      weight: WEIGHTS.ekQuote,
      explanation: `Eigenkapital deckt ${(latest.ek_quote * 100).toFixed(1)}% der Bilanz.`,
    });
  }

  // 2. Umsatz 3y CAGR (or 2y / 1y fallback)
  const withUmsatz = rows.filter((r) => r.umsatzerloese != null);
  if (withUmsatz.length >= 2) {
    const first = withUmsatz[Math.max(0, withUmsatz.length - 4)];
    const last = withUmsatz[withUmsatz.length - 1];
    const years = Math.max(1, withUmsatz.length - 1);
    const c = cagr(first.umsatzerloese, last.umsatzerloese, Math.min(3, years));
    const v = symmetricRatio(c, 0.5);
    if (v != null) {
      components.push({
        key: 'umsatzCAGR',
        label: 'Umsatzwachstum (CAGR)',
        value: c,
        normalised: v,
        weight: WEIGHTS.umsatzCAGR,
        explanation: `Umsatz wuchs im Schnitt um ${(c * 100).toFixed(1)}% p.a.`,
      });
    }
  }

  // 3. JÜ-Marge (Jahresergebnis / Umsatz)
  if (latest.jahresergebnis != null && latest.umsatzerloese) {
    const margin = latest.jahresergebnis / latest.umsatzerloese;
    const v = symmetricRatio(margin, 0.2);
    components.push({
      key: 'margin',
      label: 'Netto-Marge',
      value: margin,
      normalised: v,
      weight: WEIGHTS.margin,
      explanation: `Jahresergebnis entspricht ${(margin * 100).toFixed(1)}% vom Umsatz.`,
    });
  }

  // 4. Continuity — consecutive years filed / 10
  const v4 = clamp01(rows.length / 10);
  components.push({
    key: 'continuity',
    label: 'Berichts­kontinuität',
    value: rows.length,
    normalised: v4,
    weight: WEIGHTS.continuity,
    explanation: `${rows.length} Jahresabschluss${rows.length === 1 ? '' : '-Einträge'} erfasst.`,
  });

  // 5. Mitarbeiter-Δ (latest / first)
  const withEmp = rows.filter((r) => r.arbeitnehmer != null);
  if (withEmp.length >= 2) {
    const first = withEmp[0].arbeitnehmer;
    const last = withEmp[withEmp.length - 1].arbeitnehmer;
    if (first > 0) {
      const growth = (last - first) / first;
      const v = symmetricRatio(growth, 0.5);
      components.push({
        key: 'employees',
        label: 'Mitarbeiter­entwicklung',
        value: growth,
        normalised: v,
        weight: WEIGHTS.employees,
        explanation: `Mitarbeiter ${growth >= 0 ? 'stiegen' : 'sanken'} um ${(growth * 100).toFixed(0)}%.`,
      });
    }
  }

  // 6. Bilanz-CAGR
  const withBilanz = rows.filter((r) => r.bilanzsumme != null);
  if (withBilanz.length >= 2) {
    const first = withBilanz[Math.max(0, withBilanz.length - 4)];
    const last = withBilanz[withBilanz.length - 1];
    const years = Math.max(1, withBilanz.length - 1);
    const c = cagr(first.bilanzsumme, last.bilanzsumme, Math.min(3, years));
    const v = symmetricRatio(c, 0.3);
    if (v != null) {
      components.push({
        key: 'bilanzCAGR',
        label: 'Bilanz-Wachstum',
        value: c,
        normalised: v,
        weight: WEIGHTS.bilanzCAGR,
        explanation: `Bilanzsumme CAGR ${(c * 100).toFixed(1)}%.`,
      });
    }
  }

  if (components.length === 0) return { score: null, grade: null, breakdown: [] };

  // Renormalise weights across the components that produced a signal.
  const sumWeights = components.reduce((s, c) => s + c.weight, 0);
  const rawScore = components.reduce((s, c) => s + (c.normalised * c.weight / sumWeights), 0);
  const score = Math.round(rawScore * 100);

  let grade = 'C';
  if (score >= 85) grade = 'AAA';
  else if (score >= 75) grade = 'AA';
  else if (score >= 65) grade = 'A';
  else if (score >= 50) grade = 'B';

  return {
    score, grade,
    breakdown: components.map((c) => ({
      key: c.key, label: c.label,
      value: c.value,
      normalised: c.normalised,
      weight: c.weight,
      contribution: Math.round(c.normalised * (c.weight / sumWeights) * 100),
      explanation: c.explanation,
    })),
  };
}
