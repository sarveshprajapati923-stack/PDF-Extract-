import { createHash, timingSafeEqual } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { hit } from '@/lib/rateLimit';
import type { Lead } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function configured(): boolean {
  return Boolean(
    process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.ADMIN_PASSCODE,
  );
}

function sha(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function db() {
  return createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { persistSession: false },
  });
}

function guard(req: Request): NextResponse | null {
  if (!configured()) return NextResponse.json({ error: 'not-configured' }, { status: 501 });
  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0].trim();
  if (!hit(`leads:${ip}`, 60, 60_000).ok) {
    return NextResponse.json({ error: 'rate-limited' }, { status: 429 });
  }
  const given = req.headers.get('x-admin-passcode') ?? '';
  if (!timingSafeEqual(sha(given), sha(process.env.ADMIN_PASSCODE ?? ''))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

export async function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const { data, error } = await db()
    .from('leads')
    .select('data')
    .order('updated_at', { ascending: false })
    .limit(5000);
  if (error) return NextResponse.json({ error: 'db-error' }, { status: 502 });
  const leads = (data ?? []).map((r: { data: Lead }) => r.data);
  return NextResponse.json({ leads });
}

export async function POST(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  let body: { leads?: unknown };
  try {
    body = (await req.json()) as { leads?: unknown };
  } catch {
    return NextResponse.json({ error: 'bad-request' }, { status: 400 });
  }
  if (!Array.isArray(body.leads) || body.leads.length === 0 || body.leads.length > 500) {
    return NextResponse.json({ error: 'bad-request' }, { status: 400 });
  }
  const rows = [];
  for (const item of body.leads as Lead[]) {
    if (!item || typeof item.id !== 'string' || item.id.length > 80 || typeof item.name !== 'string') {
      return NextResponse.json({ error: 'bad-request' }, { status: 400 });
    }
    rows.push({ id: item.id, data: item, updated_at: new Date().toISOString() });
  }
  const { error } = await db().from('leads').upsert(rows, { onConflict: 'id' });
  if (error) return NextResponse.json({ error: 'db-error' }, { status: 502 });
  return NextResponse.json({ ok: true, saved: rows.length });
}

export async function DELETE(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get('id');
  if (!id || id.length > 80) return NextResponse.json({ error: 'bad-request' }, { status: 400 });
  const { error } = await db().from('leads').delete().eq('id', id);
  if (error) return NextResponse.json({ error: 'db-error' }, { status: 502 });
  return NextResponse.json({ ok: true });
}
