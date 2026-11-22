// Product catalog. Prices are placeholders: replace them with real prices before launch.
export const products = [
  {
    id: 'red-palm-oil',
    name: 'Special Red Palm Oil',
    tag: 'Food grade · Unrefined',
    description:
      'Deep red and full of carotene. Pressed in small batches from fresh fruit bunches for home cooking and food retail.',
    sizes: [
      { id: '1l', label: '1 litre', usd: 6, ngn: 4500 },
      { id: '5l', label: '5 litres', usd: 26, ngn: 20000 },
      { id: '25l', label: '25 litres', usd: 115, ngn: 90000 },
    ],
  },
  {
    id: 'crude-palm-oil',
    name: 'Crude Palm Oil (CPO)',
    tag: 'Bulk · Industrial',
    description:
      'Bulk oil for refineries and for makers of soap, oleochemicals and food ingredients. Ships in drums or by flexitank.',
    sizes: [
      { id: 'drum', label: '200 L drum', usd: 820, ngn: 640000 },
      { id: 'container', label: '20ft container', usd: null, ngn: null },
    ],
  },
  {
    id: 'palm-kernel-oil',
    name: 'Palm Kernel Oil (PKO)',
    tag: 'Kernel · Light',
    description:
      'A light, pale oil pressed from the kernel. Used in cosmetics, soap, confectionery and specialty fats.',
    sizes: [
      { id: '1l', label: '1 litre', usd: 8, ngn: 6000 },
      { id: '25l', label: '25 litres', usd: 150, ngn: 115000 },
      { id: 'drum', label: '200 L drum', usd: 1050, ngn: 820000 },
    ],
  },
];
