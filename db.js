// 웨딩여기 · Supabase 연동 계층
// 실패해도 앱이 멈추지 않도록 모든 호출은 안전하게 감쌉니다.

const SUPABASE_URL = 'https://nrugltrcpjotlkimanfi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ydWdsdHJjcGpvdGxraW1hbmZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwNDg0MjYsImV4cCI6MjEwMDYyNDQyNn0.fl1uioN4pcGTkZ94wNNqnafM9TYFCl7EpmrPOfI5nhw';

let _client = null;

export function sb() {
  if (_client) return _client;
  const lib = window.supabase;
  if (!lib || !lib.createClient) return null;
  _client = lib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'bskn_auth' }
  });
  return _client;
}

export function ready() { return !!sb(); }

/* ---------------- auth ---------------- */

export async function signUp({ email, password, name, phone, weddingDate, isTbd }) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw error;
  const user = data.user;
  if (!user) throw new Error('가입 확인 메일을 확인해 주세요.');
  const { error: pe } = await c.from('profiles').insert({
    id: user.id, name, phone,
    wedding_date: (isTbd || !weddingDate) ? null : weddingDate,
    is_date_tbd: !!isTbd, points: 30000, provider: 'local'
  });
  if (pe && pe.code !== '23505') throw pe;
  return user;
}

export async function signIn({ email, password }) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signInOAuth(provider) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { error } = await c.auth.signInWithOAuth({
    provider, options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) throw error;
}

export async function signOut() {
  const c = sb(); if (c) await c.auth.signOut();
}

export async function currentUser() {
  const c = sb(); if (!c) return null;
  const { data } = await c.auth.getUser();
  return data ? data.user : null;
}

/* ---------------- profile ---------------- */

// OAuth 최초 로그인 시 프로필이 없으면 소셜 정보로 만들어 줍니다.
export async function ensureProfile(user) {
  const c = sb(); if (!c || !user) return null;
  const existing = await getProfile(user.id);
  if (existing) return existing;
  const meta = user.user_metadata || {};
  const name = meta.name || meta.full_name || meta.nickname || meta.preferred_username || '회원';
  const phone = meta.phone || meta.phone_number || user.phone || '';
  const provider = (user.app_metadata && user.app_metadata.provider) || 'local';
  const { data, error } = await c.from('profiles').insert({
    id: user.id, name, phone, points: 30000, is_date_tbd: true, provider
  }).select().maybeSingle();
  if (error) return null;
  return data;
}

export async function getProfile(userId) {
  const c = sb(); if (!c) return null;
  const { data, error } = await c.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) return null;
  return data;
}

export async function upsertProfile(userId, patch) {
  const c = sb(); if (!c) return null;
  const { data, error } = await c.from('profiles')
    .upsert({ id: userId, ...patch }).select().maybeSingle();
  if (error) throw error;
  return data;
}

/* ---------------- orders ---------------- */

export async function listOrders(userId) {
  const c = sb(); if (!c) return [];
  const { data, error } = await c.from('orders')
    .select('*').eq('user_id', userId).order('created_at', { ascending: false });
  return error ? [] : (data || []);
}

export async function createOrder(userId, order) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { error } = await c.from('orders').insert({
    id: order.id, user_id: userId, items: order.items, summary: order.summary,
    total: order.total, order_total: order.orderTotal, status: order.status
  });
  if (error) throw error;
}

/* ---------------- consults ---------------- */

export async function listConsults(userId) {
  const c = sb(); if (!c) return [];
  const { data, error } = await c.from('consults')
    .select('*').eq('user_id', userId).order('created_at', { ascending: false });
  return error ? [] : (data || []);
}

export async function createConsult(userId, rec) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { error } = await c.from('consults').insert({
    user_id: userId || null, name: rec.name, phone: rec.phone,
    target: rec.target, wish_time: rec.wishTime, status: '접수완료'
  });
  if (error) throw error;
}

/* ---------------- wishes ---------------- */

export async function listWishes(userId) {
  const c = sb(); if (!c) return [];
  const { data, error } = await c.from('wishes').select('vendor_id').eq('user_id', userId);
  return error ? [] : (data || []).map(r => r.vendor_id);
}

export async function addWish(userId, vendorId) {
  const c = sb(); if (!c) return;
  await c.from('wishes').upsert({ user_id: userId, vendor_id: vendorId });
}

export async function removeWish(userId, vendorId) {
  const c = sb(); if (!c) return;
  await c.from('wishes').delete().eq('user_id', userId).eq('vendor_id', vendorId);
}

/* ---------------- ad units ---------------- */

export async function loadAdUnits() {
  const c = sb(); if (!c) return null;
  const { data, error } = await c.from('ad_units').select('id,enabled');
  if (error || !data) return null;
  const out = {};
  data.forEach(r => { out[r.id] = r.enabled; });
  return out;
}

export async function saveAdUnit(id, enabled) {
  const c = sb(); if (!c) return;
  await c.from('ad_units').upsert({ id, enabled, updated_at: new Date().toISOString() });
}
