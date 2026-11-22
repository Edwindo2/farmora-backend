// Seeds the catalog and the first admin user. Safe to run more than once.
// Run with: npm run db:seed
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { prisma, toMinor } from '../src/db.js';
import { products } from '../products.js';
import { FAQ } from '../faq-seed.js';

async function main() {
  for (const [i, p] of products.entries()) {
    const product = await prisma.product.upsert({
      where: { slug: p.id },
      update: { name: p.name, tag: p.tag, description: p.description, sortOrder: i },
      create: { slug: p.id, name: p.name, tag: p.tag, description: p.description, image: `/products/${p.id}.jpg`, sortOrder: i },
    });
    for (const [j, s] of p.sizes.entries()) {
      await prisma.productVariant.upsert({
        where: { productId_code: { productId: product.id, code: s.id } },
        update: {},
        create: {
          productId: product.id,
          code: s.id,
          label: s.label,
          sku: `${p.id}-${s.id}`.toUpperCase(),
          priceNgn: toMinor(s.ngn),
          priceUsd: toMinor(s.usd),
          sortOrder: j,
        },
      });
    }
  }

  // FAQ: only loaded into an empty table, so admin edits are never overwritten
  if ((await prisma.faqItem.count()) === 0) {
    let order = 0;
    for (const g of FAQ) for (const it of g.items) {
      await prisma.faqItem.create({ data: { category: g.group, question: it.q, answer: it.a, sortOrder: order++ } });
    }
    console.log(`FAQ loaded: ${order} questions`);
  }

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (email && password) {
    await prisma.adminUser.upsert({
      where: { email },
      update: {},
      create: { email, name: 'Farmora Admin', passwordHash: await bcrypt.hash(password, 10), role: 'admin' },
    });
    console.log(`Admin user ready: ${email} (password from .env)`);
  }
  console.log('Seed complete.');
}

main().finally(() => prisma.$disconnect());
