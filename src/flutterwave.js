// Flutterwave online payment for confirmed orders.
//
// Switched on by environment variables on the server (Render):
//   FLW_SECRET_KEY   secret key from the Flutterwave dashboard (Settings → API keys)
//   FLW_SECRET_HASH  any long random text; enter the same text as the "Secret hash" for the webhook
//                    in Flutterwave (Settings → Webhooks), with URL <APP_URL>/api/payments/flutterwave/webhook
// Without FLW_SECRET_KEY the "Pay now" button explains that online payment isn't switched on yet,
// and orders are paid by bank transfer and marked paid in the admin as before.
import { prisma } from './db.js';
import { appUrl, orderStatusEmail } from './mailer.js';
import { STATUS_TEXT } from './constants.js';

const API = 'https://api.flutterwave.com/v3';
export const paymentsEnabled = () => Boolean(process.env.FLW_SECRET_KEY);

async function flw(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'success') throw new Error(body.message || `Flutterwave error ${res.status}`);
  return body.data;
}

// An order can be paid online once the admin has confirmed it with a final total (prices + delivery).
export const canPay = o => o.paymentStatus === 'unpaid' && o.status === 'confirmed' && o.total != null && o.total > 0;

// Start a payment: returns the Flutterwave checkout link to send the customer to.
export async function createPaymentLink(order, customer) {
  const data = await flw('/payments', {
    method: 'POST',
    body: JSON.stringify({
      tx_ref: `${order.reference}-${Date.now()}`,
      amount: order.total / 100,
      currency: order.currency,
      redirect_url: appUrl(`/account/orders/${order.reference}?payment=done`),
      customer: { email: customer.email, name: customer.name, phonenumber: customer.phone || undefined },
      customizations: { title: 'Farmora AgriTrade Limited', description: `Order ${order.reference}`, logo: appUrl('/emblem.png') },
      meta: { reference: order.reference },
    }),
  });
  return data.link;
}

// Checks a transaction with Flutterwave and marks the order paid if it really is.
// Used by both the customer's return from checkout and the webhook, so either one is enough.
export async function confirmTransaction(transactionId) {
  const tx = await flw(`/transactions/${encodeURIComponent(transactionId)}/verify`);
  const reference = String(tx.tx_ref || '').split('-').slice(0, 2).join('-');
  const order = await prisma.order.findUnique({ where: { reference }, include: { customer: true } });
  if (!order) return { ok: false, reason: 'Order not found for this payment.' };
  if (order.paymentStatus === 'paid') return { ok: true, order };
  const amountOk = Math.round(Number(tx.amount) * 100) >= order.total && tx.currency === order.currency;
  if (tx.status !== 'successful' || !amountOk) return { ok: false, reason: 'The payment was not completed.' };

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: {
      paymentStatus: 'paid',
      paymentMethod: `Flutterwave (${tx.payment_type || 'online'})`,
      paymentRef: String(tx.id),
      paidAt: new Date(),
      ...(['received', 'confirmed'].includes(order.status) ? { status: 'paid' } : {}),
      events: { create: { status: 'paid', note: STATUS_TEXT.paid, createdBy: 'flutterwave' } },
    },
  });
  orderStatusEmail(updated, order.customer, 'paid', STATUS_TEXT.paid);
  return { ok: true, order: updated };
}
