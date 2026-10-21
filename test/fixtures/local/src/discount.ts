export function percentOff(subtotal: number, percent: number): number {
  return subtotal - subtotal * (percent / 100);
}
