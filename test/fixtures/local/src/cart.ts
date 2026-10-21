export interface Customer {
  id: string;
  name: string;
}

const customers = new Map<string, Customer>();

export function findCustomer(id: string): Customer | undefined {
  return customers.get(id);
}

export interface CartLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  customerId: string;
  lines: CartLine[];
}

const TAX_RATE = 0.2;

export function cartSubtotal(order: Order): number {
  const subtotal = order.lines.reduce(
    (sum, line) => sum + line.quantity * line.unitPrice,
    0,
  );
  const discount = order.lines.length > 3 ? subtotal * 0.1 : 0;
  return subtotal - discount;
}

export function cartTotal(order: Order): number {
  return cartSubtotal(order) * (1 + TAX_RATE);
}

export function lineCount(order: Order): number {
  return order.lines.reduce((count, line) => count + line.quantity, 0);
}

export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function cartOwnerName(order: Order): string {
  const customer = findCustomer(order.customerId);
  return customer.name;
}
