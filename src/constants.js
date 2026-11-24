// Allowed values for the string "enum" columns in prisma/schema.prisma.

export const ORDER_STATUSES = ['received', 'confirmed', 'paid', 'processing', 'shipped', 'delivered', 'cancelled'];

// Which statuses an order may move to next. Admins follow this flow; cancelling is allowed until shipped.
export const NEXT_STATUS = {
  received: ['confirmed', 'cancelled'],
  confirmed: ['paid', 'cancelled'],
  paid: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

// Customer-facing wording for each status (tracking page and status history).
export const STATUS_TEXT = {
  received: 'We have received your order and are checking stock.',
  confirmed: 'Your order is confirmed with the final price and delivery cost. You can now pay from your dashboard.',
  paid: 'Payment received. Thank you!',
  processing: 'Your oil is being packed and prepared for dispatch.',
  shipped: 'Your order is on its way.',
  delivered: 'Delivered. Enjoy your Farmora palm oil!',
  cancelled: 'This order has been cancelled.',
};

export const PAYMENT_STATUSES = ['unpaid', 'paid', 'refunded'];
export const SHIPPING_METHODS = {
  'Air freight (small parcels)': 'air',
  'Sea freight – FOB Lagos': 'fob',
  'Sea freight – CIF to my port': 'cif',
  'Not sure – please advise': 'advise',
};
export const MESSAGE_STATUSES = ['new', 'read', 'replied', 'archived'];
export const CONTACT_TOPICS = ['General question', 'Bulk / export order', 'Local delivery', 'Partnership / supply'];
