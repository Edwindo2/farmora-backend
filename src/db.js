import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// Short, readable references like FM-7Q2K9D (no 0/O/1/I to avoid confusion).
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export function makeReference(prefix) {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `${prefix}-${s}`;
}

// Minor units (kobo/cents) <-> whole currency units for the API.
export const toMinor = v => (v == null ? null : Math.round(Number(v) * 100));
export const toMajor = v => (v == null ? null : v / 100);
