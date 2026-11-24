import nodemailer from 'nodemailer';
import { getSite } from './settings.js';

// Sends email through SMTP when SMTP_HOST is set. In development (no SMTP_HOST) the email is
// printed to the server console instead, so links like password resets can still be tested.
let transport;
function getTransport() {
  if (transport) return transport;
  if (process.env.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  } else {
    transport = nodemailer.createTransport({ jsonTransport: true });
  }
  return transport;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Admin area path in the browser (must match VITE_ADMIN_PATH in the frontend).
export const adminUrl = path => appUrl(`${(process.env.ADMIN_PATH || '/officerArea').replace(/\/$/, '')}${path}`);
export const appUrl = path => `${(process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '')}${path}`;

// Simple branded HTML layout that works in common email clients.
function layout({ heading, body, button, place = 'Lagos, Nigeria' }) {
  return `<!doctype html><html><body style="margin:0;background:#f3f6ef;font-family:Helvetica,Arial,sans-serif;color:#17451c">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden">
      <tr><td style="background:#17451c;padding:22px 28px;color:#ffffff;font-size:18px;letter-spacing:4px;font-weight:bold">FARMORA
        <div style="font-size:9px;letter-spacing:3px;color:#b8912f;font-weight:normal;margin-top:4px">AGRITRADE LIMITED</div></td></tr>
      <tr><td style="padding:30px 28px">
        <h1 style="margin:0 0 14px;font-family:Georgia,serif;font-weight:normal;font-size:28px;color:#17451c">${heading}</h1>
        <div style="font-size:15px;line-height:1.6;color:#4f5f50">${body}</div>
        ${button ? `<p style="margin:26px 0 6px"><a href="${esc(button.href)}" style="background:#c0361a;color:#ffffff;text-decoration:none;padding:13px 22px;border-radius:99px;font-size:14px;display:inline-block">${esc(button.label)}</a></p>` : ''}
      </td></tr>
      <tr><td style="padding:18px 28px;border-top:1px solid #e6ebe1;font-size:12px;color:#86927f">From nature to the world · ${esc(place)}</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

export async function sendMail({ to, subject, heading, body, button, text }) {
  if (!to) return;
  try {
    const info = await getTransport().sendMail({
      from: process.env.MAIL_FROM || 'Farmora <no-reply@farmora.com>',
      to,
      subject,
      html: layout({ heading, body, button, place: await getSite().then(s => [s.city, s.country].filter(Boolean).join(', ')).catch(() => undefined) }),
      text: text || `${heading}\n\n${body.replace(/<[^>]+>/g, '')}${button ? `\n\n${button.label}: ${button.href}` : ''}`,
    });
    if (!process.env.SMTP_HOST) {
      console.log(`\n[email – dev mode, not sent] to: ${to}\nsubject: ${subject}\n${button ? `link: ${button.href}\n` : ''}`);
    }
    return info;
  } catch (err) {
    // never let an email failure break the request
    console.error('Email failed:', err.message);
  }
}

/* ---------- templates ---------- */
const money = (minor, cur) => (minor == null ? 'to be confirmed' : new Intl.NumberFormat(cur === 'NGN' ? 'en-NG' : 'en-US', { style: 'currency', currency: cur }).format(minor / 100));

export function passwordResetEmail(to, link) {
  return sendMail({
    to,
    subject: 'Reset your Farmora admin password',
    heading: 'Reset your password',
    body: `<p>Someone asked to reset the password for the Farmora admin account <b>${esc(to)}</b>.</p><p>This link works once and expires in 30 minutes. If you didn't ask for this, you can ignore this email.</p>`,
    button: { label: 'Choose a new password', href: link },
  });
}

export function orderReceivedEmail(order, customer, items) {
  const rows = items.map(i => `<tr><td style="padding:6px 0">${i.quantity} × ${esc(i.productName)} <span style="color:#86927f">(${esc(i.variantLabel)})</span></td><td align="right">${money(i.lineTotal, order.currency)}</td></tr>`).join('');
  return sendMail({
    to: customer.email,
    subject: `We've received your order ${order.reference}`,
    heading: `Thank you, ${esc(customer.name.split(' ')[0])}.`,
    body: `<p>We've received your order <b>${order.reference}</b> and are checking stock. We'll email you shortly to confirm delivery cost and payment details. You won't be charged until then.</p>
      <table role="presentation" width="100%" style="font-size:14px;border-top:1px solid #e6ebe1;margin-top:12px;padding-top:8px">${rows}
      <tr><td style="padding-top:10px;border-top:1px solid #e6ebe1"><b>Subtotal</b></td><td align="right" style="padding-top:10px;border-top:1px solid #e6ebe1"><b>${money(order.subtotal, order.currency)}</b></td></tr></table>
      <p style="margin-top:18px;font-size:13px;color:#86927f">You can see all your orders any time at <a href="${appUrl('/account')}" style="color:#17451c">My orders</a>, using this email address.</p>`,
    button: { label: 'Track your order', href: appUrl(`/account/orders/${order.reference}`) },
  });
}

export function orderStatusEmail(order, customer, status, note) {
  const extra = status === 'confirmed' && order.total != null ? `<p>Order total including delivery: <b>${money(order.total, order.currency)}</b>.</p>` : '';
  const tracking = status === 'shipped' && order.trackingNumber ? `<p>Tracking number: <b>${esc(order.trackingNumber)}</b></p>` : '';
  return sendMail({
    to: customer.email,
    subject: `Order ${order.reference}: ${status}`,
    heading: `Your order is ${status}.`,
    body: `<p>${esc(note)}</p>${extra}${tracking}`,
    button: { label: 'View order status', href: appUrl(`/account/orders/${order.reference}`) },
  });
}

export function newOrderAlert(order, customer) {
  return sendMail({
    to: process.env.ADMIN_NOTIFY_EMAIL,
    subject: `New order ${order.reference} from ${customer.name}`,
    heading: 'New order',
    body: `<p><b>${esc(customer.name)}</b> (${esc(customer.email)}) placed order <b>${order.reference}</b>: ${order.deliveryType} delivery to ${esc(order.city)}, ${esc(order.country)}.</p><p>Subtotal: ${money(order.subtotal, order.currency)}</p>`,
    button: { label: 'Open in admin', href: adminUrl(`/orders/${order.reference}`) },
  });
}

export function customerLoginEmail(customer, link) {
  return sendMail({
    to: customer.email,
    subject: 'Your Farmora sign-in link',
    heading: `Hi ${esc(customer.name.split(' ')[0])},`,
    body: `<p>Use the button below to see your Farmora orders. The link works once and expires in 20 minutes.</p><p>If you didn't ask for this, you can ignore this email.</p>`,
    button: { label: 'View my orders', href: link },
  });
}

export function customerActivateEmail(customer, link) {
  return sendMail({
    to: customer.email,
    subject: 'Confirm your Farmora account',
    heading: `Welcome, ${esc(customer.name.split(' ')[0])}.`,
    body: `<p>You've ordered from Farmora before with this email. Confirm it's you to finish creating your account and see all your orders and tracking in one place.</p><p>The link works once and expires in 20 minutes. If you didn't try to create an account, you can ignore this email.</p>`,
    button: { label: 'Confirm my account', href: link },
  });
}

export function newWholesaleAlert(customer, note = '') {
  const kind = customer.accountType === 'distributor' ? 'distributor' : 'wholesale';
  const extra = kind === 'distributor' ? `<p>Areas covered: ${esc(customer.area || '-')}<br>Expected monthly volume: ${esc(customer.monthlyVolume || '-')}</p>` : '';
  return sendMail({
    to: process.env.ADMIN_NOTIFY_EMAIL,
    subject: `${kind === 'distributor' ? 'Distributor application' : 'Wholesale account request'} from ${customer.company || customer.name}`,
    heading: kind === 'distributor' ? 'New distributor application' : 'New wholesale request',
    body: `<p><b>${esc(customer.name)}</b>${customer.company ? ` (${esc(customer.company)})` : ''}, ${esc(customer.email)}, ${esc(customer.phone || '')}, ${esc(customer.country || '')} asked for a ${kind} account.</p>${extra}${note ? `<p>${esc(note)}</p>` : ''}`,
    button: { label: 'Review in admin', href: adminUrl('/customers') },
  });
}

export function wholesaleStatusEmail(customer, status) {
  const approved = status === 'approved';
  const kind = customer.accountType === 'distributor' ? 'distributor' : 'wholesale';
  const first = esc(customer.name.split(' ')[0]);
  return sendMail({
    to: customer.email,
    subject: approved ? `Your Farmora ${kind} account is approved` : `Your Farmora ${kind} application`,
    heading: approved ? (kind === 'distributor' ? 'Welcome, Farmora distributor.' : 'Wholesale prices unlocked.') : `About your ${kind} application`,
    body: approved
      ? `<p>Hi ${first}, your ${kind} account is approved. Sign in to see your ${kind} prices on our products and request your bulk orders.</p>`
      : `<p>Hi ${first}, we couldn't approve your ${kind} application at the moment. Reply to this email to tell us more about your business, or request a bulk quote at any time.</p>`,
    button: { label: 'See my prices', href: appUrl('/shop') },
  });
}

export function kycSubmittedAlert(customer) {
  return sendMail({
    to: process.env.ADMIN_NOTIFY_EMAIL,
    subject: `KYC documents from ${customer.company || customer.name}`,
    heading: 'New KYC submission',
    body: `<p><b>${esc(customer.name)}</b>${customer.company ? ` (${esc(customer.company)})` : ''}, ${esc(customer.email)} sent their ${esc(customer.kycIdType || 'ID')} for verification.</p>`,
    button: { label: 'Review in admin', href: adminUrl('/kyc') },
  });
}

export function kycStatusEmail(customer, status, note) {
  const ok = status === 'approved';
  const first = esc(customer.name.split(' ')[0]);
  return sendMail({
    to: customer.email,
    subject: ok ? 'Your Farmora account is verified' : 'About your Farmora verification',
    heading: ok ? 'You are verified.' : 'We need another look at your documents',
    body: ok
      ? `<p>Hi ${first}, your identity documents have been checked and your account is now verified.</p>`
      : `<p>Hi ${first}, we could not verify the documents you sent.${note ? ` Reason: ${esc(note)}` : ''}</p><p>Please upload them again from your dashboard.</p>`,
    button: { label: 'Open my dashboard', href: appUrl('/account?tab=kyc') },
  });
}

export function noticeEmail(customer, title, body) {
  return sendMail({
    to: customer.email,
    subject: title,
    heading: title,
    body: `<p>Hi ${esc(customer.name.split(' ')[0])},</p>${esc(body).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}`,
    button: { label: 'Open my dashboard', href: appUrl('/account') },
  });
}
