/** Sort unit labels like A1, B1, A2, B2 — by floor number first, then side. */
export function compareUnitLabels(a: string, b: string): number {
  const pa = /^([A-Za-z]*)(\d+)$/.exec(a);
  const pb = /^([A-Za-z]*)(\d+)$/.exec(b);
  if (pa && pb) {
    const na = Number(pa[2]);
    const nb = Number(pb[2]);
    if (na !== nb) return na - nb;
    return pa[1].localeCompare(pb[1]);
  }
  return a.localeCompare(b);
}
