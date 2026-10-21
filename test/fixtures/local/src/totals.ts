export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}
