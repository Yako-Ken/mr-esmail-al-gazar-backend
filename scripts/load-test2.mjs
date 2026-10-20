/**
 * Load test v2: authenticated endpoints under concurrency.
 *
 * v1 proved the brute-force protection works (50 logins from one IP -> 429).
 * That is CORRECT and must not be "fixed". Real users arrive from distinct IPs,
 * so the meaningful load test is: N authenticated users hitting app endpoints
 * at once. Tokens are minted directly (same JWT_SECRET the server uses) for
 * users created in the DB — this bypasses only the login gate, nothing else.
 *
 * Run: node scripts/load-test2.mjs [users=100]
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const BASE = 'http://localhost:5000';
const USERS = parseInt(process.argv[2] || '100', 10);
const prisma = new PrismaClient();
import fs from 'fs';
const envLine = fs.readFileSync('.env','utf8').split(/\r?\n/).find(l => l.startsWith('JWT_SECRET='));
const SECRET = (envLine || '').slice('JWT_SECRET='.length).trim();
if (!SECRET) throw new Error('JWT_SECRET missing from .env');

async function setup() {
  const hash = await bcrypt.hash('Load@1234', 4); // fast hash for fixtures
  const tokens = [];
  for (let i = 0; i < USERS; i++) {
    const phone = `0109100${String(2000 + i).slice(-4)}`;
    const user = await prisma.user.upsert({
      where: { phone },
      create: { phone, password: hash, name: 'Load' + i, role: 'STUDENT', status: 'APPROVED', isApproved: true },
      update: {},
    });
    tokens.push(jwt.sign({ id: user.id, phone: user.phone, role: 'STUDENT', sv: user.sessionVersion }, SECRET, { expiresIn: '1h' }));
  }
  return tokens;
}

async function flow(token) {
  const t0 = Date.now();
  const H = { Authorization: `Bearer ${token}` };
  try {
    const r1 = await fetch(`${BASE}/api/courses`, { headers: H });
    if (!r1.ok) return { ok: false, where: 'courses:' + r1.status, total: Date.now() - t0 };
    const r2 = await fetch(`${BASE}/api/auth/me`, { headers: H });
    if (!r2.ok) return { ok: false, where: 'me:' + r2.status, total: Date.now() - t0 };
    const r3 = await fetch(`${BASE}/api/parents/my-children`, { headers: H });
    // Students get 403 here — that IS the correct answer; we measure it.
    const ok3 = r3.status === 403;
    return { ok: ok3, where: ok3 ? '' : 'children:' + r3.status, total: Date.now() - t0 };
  } catch (e) {
    return { ok: false, where: 'exc:' + e.message.slice(0, 50), total: Date.now() - t0 };
  }
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

(async () => {
  console.log(`setup ${USERS} users...`);
  const tokens = await setup();
  await prisma.$disconnect();
  console.log(`firing ${USERS} concurrent flows...`);
  const start = Date.now();
  const results = await Promise.all(tokens.map(flow));
  const wall = Date.now() - start;
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const totals = results.map((r) => r.total);
  console.log(`RESULT users=${USERS} ok=${ok.length} failed=${bad.length} wall=${wall}ms`);
  console.log(`LAT p50=${pct(totals, 50)}ms p95=${pct(totals, 95)}ms p99=${pct(totals, 99)}ms`);
  const byWhere = {};
  for (const b of bad) byWhere[b.where] = (byWhere[b.where] || 0) + 1;
  for (const [k, v] of Object.entries(byWhere).slice(0, 5)) console.log(`FAIL ${k} x${v}`);
  // Cleanup fixtures
  const p2 = new PrismaClient();
  await p2.user.deleteMany({ where: { phone: { startsWith: '0109100' } } });
  await p2.user.deleteMany({ where: { phone: { startsWith: '0109000' } } });
  await p2.$disconnect();
  console.log('fixtures cleaned');
  process.exit(bad.length ? 1 : 0);
})();
