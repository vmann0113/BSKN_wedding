// 웨딩여기 · Supabase 연동 계층
// 실패해도 앱이 멈추지 않도록 모든 호출은 안전하게 감쌉니다.

const SUPABASE_URL = 'https://nrugltrcpjotlkimanfi.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ydWdsdHJjcGpvdGxraW1hbmZpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUwNDg0MjYsImV4cCI6MjEwMDYyNDQyNn0.fl1uioN4pcGTkZ94wNNqnafM9TYFCl7EpmrPOfI5nhw';

export const PROJECT_URL = SUPABASE_URL;

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

export async function signUp({ email, password, name, phone, weddingDate, isTbd, role, marketing }) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { data, error } = await c.auth.signUp({ email, password });
  if (error) throw error;
  const user = data.user;
  if (!user) throw new Error('가입 확인 메일을 확인해 주세요.');
  const now = new Date().toISOString();
  const { error: pe } = await c.from('profiles').insert({
    id: user.id, name, phone,
    wedding_date: (isTbd || !weddingDate) ? null : weddingDate,
    is_date_tbd: !!isTbd, points: 30000, provider: 'local',
    role: role || 'member', marketing_opt: !!marketing,
    terms_at: now, privacy_at: now
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
  const now = new Date().toISOString();
  const { data, error } = await c.from('profiles').insert({
    id: user.id, name, phone, points: 30000, is_date_tbd: true, provider,
    role: 'member', terms_at: now, privacy_at: now
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
    total: order.total, order_total: order.orderTotal, status: order.status,
    vendor_id: order.vendorId || null
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
    target: rec.target, wish_time: rec.wishTime, status: '접수완료',
    vendor_id: rec.vendorId || null
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


/* ================= 역할 ================= */

export async function isAdmin() {
  const c = sb(); if (!c) return false;
  const { data, error } = await c.from('admins').select('user_id').maybeSingle();
  return !error && !!data;
}

export async function setRole(userId, role) {
  return upsertProfile(userId, { role, updated_at: new Date().toISOString() });
}

/* ================= 업체 (vendors) ================= */

const VCOLS = '*';

export async function listPublicVendors({ cat, region, limit = 300 } = {}) {
  const c = sb(); if (!c) return [];
  let q = c.from('vendors').select(VCOLS).eq('status', 'approved');
  if (cat) q = q.eq('cat', cat);
  if (region) q = q.eq('region', region);
  const { data, error } = await q.order('sort_weight', { ascending: false })
    .order('created_at', { ascending: false }).limit(limit);
  return error ? [] : (data || []);
}

export async function myVendors(userId) {
  const c = sb(); if (!c || !userId) return [];
  const { data, error } = await c.from('vendors').select(VCOLS)
    .eq('owner_id', userId).order('created_at', { ascending: false });
  return error ? [] : (data || []);
}

export async function getVendor(id) {
  const c = sb(); if (!c) return null;
  const { data, error } = await c.from('vendors').select(VCOLS).eq('id', id).maybeSingle();
  return error ? null : data;
}

export async function createVendor(userId, patch) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { data, error } = await c.from('vendors')
    .insert({ ...patch, owner_id: userId, status: patch.status || 'draft' })
    .select().maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateVendor(id, patch) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { data, error } = await c.from('vendors')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data;
}

export async function submitVendor(id) {
  return updateVendor(id, { status: 'pending', submitted_at: new Date().toISOString(), reject_reason: null });
}

export async function deleteVendor(id) {
  const c = sb(); if (!c) return;
  await c.from('vendors').delete().eq('id', id);
}

/* ---- 갤러리 ---- */

export async function listVendorImages(vendorId) {
  const c = sb(); if (!c) return [];
  const { data, error } = await c.from('vendor_images').select('*')
    .eq('vendor_id', vendorId).order('sort', { ascending: true });
  return error ? [] : (data || []);
}

export async function addVendorImage(vendorId, url, sort = 0, caption = '') {
  const c = sb(); if (!c) return null;
  const { data } = await c.from('vendor_images')
    .insert({ vendor_id: vendorId, url, sort, caption }).select().maybeSingle();
  return data;
}

export async function removeVendorImage(id) {
  const c = sb(); if (!c) return;
  await c.from('vendor_images').delete().eq('id', id);
}

/* ---- 내부 단가표 ---- */

export async function getVendorInternal(vendorId) {
  const c = sb(); if (!c) return null;
  const { data } = await c.from('vendor_internal').select('*').eq('vendor_id', vendorId).maybeSingle();
  return data || null;
}

export async function saveVendorInternal(vendorId, patch) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { data, error } = await c.from('vendor_internal')
    .upsert({ vendor_id: vendorId, ...patch, updated_at: new Date().toISOString() })
    .select().single();
  if (error) throw error;
  return data;
}

/* ---- 가격표 ---- */

export async function listVendorProducts(vendorId) {
  const c = sb(); if (!c) return [];
  const { data, error } = await c.from('vendor_products').select('*')
    .eq('vendor_id', vendorId).order('sort', { ascending: true });
  return error ? [] : (data || []);
}

export async function saveVendorProduct(vendorId, p) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const row = {
    vendor_id: vendorId, name: p.name, price: p.price | 0, unit: p.unit || '원',
    options: p.options || [], includes: p.includes || '', note: p.note || '',
    sort: p.sort | 0, active: p.active !== false
  };
  if (p.id) {
    const { data, error } = await c.from('vendor_products').update(row).eq('id', p.id).select().maybeSingle();
    if (error) throw error; return data;
  }
  const { data, error } = await c.from('vendor_products').insert(row).select().maybeSingle();
  if (error) throw error; return data;
}

export async function removeVendorProduct(id) {
  const c = sb(); if (!c) return;
  await c.from('vendor_products').delete().eq('id', id);
}

/* ---- 파일 업로드 ---- */

export async function uploadMedia(file, prefix = 'vendor', bucket = 'vendor-media') {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = prefix + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const { error } = await c.storage.from(bucket).upload(path, file, { cacheControl: '3600', upsert: false });
  if (error) throw error;
  if (bucket === 'vendor-media') {
    const { data } = c.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }
  return path;
}

/* ================= 관리자 ================= */

export async function adminVendors(status) {
  const c = sb(); if (!c) return [];
  let q = c.from('vendors').select(VCOLS);
  if (status && status !== 'all') q = q.eq('status', status);
  const { data, error } = await q.order('submitted_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false });
  return error ? [] : (data || []);
}

// 관리자 시딩: 여러 업체를 한 번에 등록합니다. 200건씩 잘라 넣습니다.
export async function bulkInsertVendors(rows) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { data, error } = await c.from('vendors').insert(chunk).select('id');
    if (error) throw error;
    inserted += (data || []).length;
  }
  return inserted;
}

// 상호+주소가 같은 업체가 이미 있는지 (중복 시딩 방지)
export async function existingVendorKeys() {
  const c = sb(); if (!c) return new Set();
  const { data } = await c.from('vendors').select('name,address').limit(5000);
  return new Set((data || []).map(v => (v.name || '').trim() + '|' + (v.address || '').trim()));
}

export async function approveVendor(id) {
  return updateVendor(id, { status: 'approved', approved_at: new Date().toISOString(), reject_reason: null });
}

export async function rejectVendor(id, reason) {
  return updateVendor(id, { status: 'rejected', reject_reason: reason || '' });
}

export async function adminConsults(status) {
  const c = sb(); if (!c) return [];
  let q = c.from('consults').select('*');
  if (status && status !== 'all') q = q.eq('status', status);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
  return error ? [] : (data || []);
}

export async function updateConsult(id, patch) {
  const c = sb(); if (!c) return null;
  const { data } = await c.from('consults').update(patch).eq('id', id).select().maybeSingle();
  return data;
}

export async function adminOrders() {
  const c = sb(); if (!c) return [];
  const { data, error } = await c.from('orders').select('*')
    .order('created_at', { ascending: false }).limit(500);
  return error ? [] : (data || []);
}

export async function updateOrder(id, patch) {
  const c = sb(); if (!c) return null;
  const { data } = await c.from('orders')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().maybeSingle();
  return data;
}

export async function adminMembers(limit = 500) {
  const c = sb(); if (!c) return [];
  const { data, error } = await c.from('profiles').select('*')
    .order('created_at', { ascending: false }).limit(limit);
  return error ? [] : (data || []);
}

export async function adminStats() {
  const c = sb(); if (!c) return null;
  const { data, error } = await c.from('admin_stats').select('*').maybeSingle();
  return error ? null : data;
}

/* ---- 광고 슬롯 ---- */

export async function listAdSlots(unit) {
  const c = sb(); if (!c) return [];
  let q = c.from('ad_slots').select('*').eq('active', true);
  if (unit) q = q.eq('unit', unit);
  const { data, error } = await q.order('sort', { ascending: true });
  return error ? [] : (data || []);
}

export async function saveAdSlot(slot) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  if (slot.id) {
    const { data, error } = await c.from('ad_slots').update(slot).eq('id', slot.id).select().maybeSingle();
    if (error) throw error; return data;
  }
  const { data, error } = await c.from('ad_slots').insert(slot).select().maybeSingle();
  if (error) throw error; return data;
}

export async function removeAdSlot(id) {
  const c = sb(); if (!c) return;
  await c.from('ad_slots').delete().eq('id', id);
}

export async function myAdSlots(vendorIds) {
  const c = sb(); if (!c || !vendorIds || !vendorIds.length) return [];
  const { data, error } = await c.from('ad_slots').select('*').in('vendor_id', vendorIds).order('created_at', { ascending: false });
  return error ? [] : (data || []);
}

// 관리자용: active 여부와 무관하게 전체 슬롯(승인대기 포함)을 봅니다.
export async function adSlotCounts() {
  const c = sb(); if (!c) return {};
  const { data, error } = await c.from('ad_slots').select('unit,status').in('status', ['pending', 'approved']);
  if (error || !data) return {};
  const out = {};
  data.forEach(r => { out[r.unit] = (out[r.unit] || 0) + 1; });
  return out;
}

export async function trackAdImpression(slotId) {
  const c = sb(); if (!c || !slotId) return;
  try { await c.rpc('increment_ad_impression', { p_slot_id: slotId }); } catch (e) {}
}

export async function trackAdClick(slotId) {
  const c = sb(); if (!c || !slotId) return;
  try { await c.rpc('increment_ad_click', { p_slot_id: slotId }); } catch (e) {}
}

export async function adminAdSlots() {
  const c = sb(); if (!c) return [];
  const { data, error } = await c.from('ad_slots').select('*').order('created_at', { ascending: false });
  return error ? [] : (data || []);
}

/* ---- 정산 ---- */

export async function listBillings(vendorId) {
  const c = sb(); if (!c) return [];
  let q = c.from('billings').select('*');
  if (vendorId) q = q.eq('vendor_id', vendorId);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
  return error ? [] : (data || []);
}

export async function saveBilling(row) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  if (row.id) {
    const { data, error } = await c.from('billings').update(row).eq('id', row.id).select().maybeSingle();
    if (error) throw error; return data;
  }
  const { data, error } = await c.from('billings').insert(row).select().maybeSingle();
  if (error) throw error; return data;
}

/* ================= 개인화 ================= */

export async function touchRecent(userId, vendorId, cat) {
  const c = sb(); if (!c || !userId) return;
  await c.from('recent_views').upsert({
    user_id: userId, vendor_id: String(vendorId), cat: cat || null,
    viewed_at: new Date().toISOString()
  });
}

export async function listRecent(userId, limit = 12) {
  const c = sb(); if (!c || !userId) return [];
  const { data, error } = await c.from('recent_views').select('vendor_id,cat,viewed_at')
    .eq('user_id', userId).order('viewed_at', { ascending: false }).limit(limit);
  return error ? [] : (data || []);
}

/* ---- 체크리스트 ---- */

export const DEFAULT_CHECKLIST = [
  { title: '예산 정하기',            cat: '준비', d_offset: -300 },
  { title: '예식장 후보 3곳 투어',    cat: '예식장', d_offset: -270 },
  { title: '예식장 계약',             cat: '예식장', d_offset: -240 },
  { title: '스드메 상담·계약',        cat: '스드메', d_offset: -210 },
  { title: '청첩장 시안 결정',        cat: '청첩장', d_offset: -120 },
  { title: '본식 스냅·영상 예약',     cat: '스드메', d_offset: -150 },
  { title: '웨딩촬영',               cat: '스드메', d_offset: -120 },
  { title: '예복·한복 준비',          cat: '예복',   d_offset: -100 },
  { title: '예단·예물 준비',          cat: '예단',   d_offset: -90 },
  { title: '신혼여행 예약',           cat: '신혼여행', d_offset: -90 },
  { title: '청첩장 발송',             cat: '청첩장', d_offset: -60 },
  { title: '하객 명단·좌석 정리',      cat: '예식장', d_offset: -30 },
  { title: '최종 리허설·피팅',         cat: '스드메', d_offset: -14 },
  { title: '잔금 정산',               cat: '준비',   d_offset: -7 }
];

export async function listChecklist(userId) {
  const c = sb(); if (!c || !userId) return [];
  const { data, error } = await c.from('checklist_items').select('*')
    .eq('user_id', userId).order('sort', { ascending: true });
  return error ? [] : (data || []);
}

export async function seedChecklist(userId, weddingDate) {
  const c = sb(); if (!c || !userId) return [];
  const base = weddingDate ? new Date(weddingDate) : null;
  const rows = DEFAULT_CHECKLIST.map((t, i) => {
    let due = null;
    if (base) { const d = new Date(base); d.setDate(d.getDate() + t.d_offset); due = d.toISOString().slice(0, 10); }
    return { user_id: userId, title: t.title, cat: t.cat, d_offset: t.d_offset, due_date: due, sort: i, is_default: true };
  });
  const { data, error } = await c.from('checklist_items').insert(rows).select();
  return error ? [] : (data || []);
}

export async function toggleChecklist(id, done) {
  const c = sb(); if (!c) return null;
  const { data } = await c.from('checklist_items')
    .update({ done, done_at: done ? new Date().toISOString() : null }).eq('id', id).select().maybeSingle();
  return data;
}

export async function addChecklistItem(userId, title, cat, dueDate) {
  const c = sb(); if (!c) return null;
  const { data } = await c.from('checklist_items')
    .insert({ user_id: userId, title, cat: cat || '기타', due_date: dueDate || null, sort: 999 })
    .select().maybeSingle();
  return data;
}

export async function removeChecklistItem(id) {
  const c = sb(); if (!c) return;
  await c.from('checklist_items').delete().eq('id', id);
}

/* ---- 예산 트래커 ---- */

export const DEFAULT_BUDGET = [
  { cat: '예식장',   ratio: .42 }, { cat: '스드메',   ratio: .16 },
  { cat: '예복·한복', ratio: .08 }, { cat: '예단·예물', ratio: .14 },
  { cat: '신혼여행', ratio: .14 }, { cat: '기타',     ratio: .06 }
];

export async function listBudget(userId) {
  const c = sb(); if (!c || !userId) return [];
  const { data, error } = await c.from('budget_items').select('*')
    .eq('user_id', userId).order('sort', { ascending: true });
  return error ? [] : (data || []);
}

export async function seedBudget(userId, total) {
  const c = sb(); if (!c || !userId) return [];
  const t = total || 0;
  const rows = DEFAULT_BUDGET.map((b, i) => ({
    user_id: userId, cat: b.cat, planned: Math.round(t * b.ratio / 10000) * 10000, actual: 0, sort: i
  }));
  const { data, error } = await c.from('budget_items').insert(rows).select();
  return error ? [] : (data || []);
}

export async function saveBudgetItem(row) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  if (row.id) {
    const { data, error } = await c.from('budget_items').update(row).eq('id', row.id).select().maybeSingle();
    if (error) throw error; return data;
  }
  const { data, error } = await c.from('budget_items').insert(row).select().maybeSingle();
  if (error) throw error; return data;
}

export async function removeBudgetItem(id) {
  const c = sb(); if (!c) return;
  await c.from('budget_items').delete().eq('id', id);
}

/* ---- 커플 연동 ---- */

export async function linkPartner(userId, code) {
  const c = sb(); if (!c) throw new Error('Supabase 미연결');
  const { data: mate, error } = await c.from('profiles')
    .select('id,name,couple_code').eq('couple_code', String(code).toUpperCase().trim()).maybeSingle();
  if (error || !mate) throw new Error('초대코드를 찾을 수 없어요.');
  if (mate.id === userId) throw new Error('본인 코드는 사용할 수 없어요.');
  await c.from('profiles').update({ partner_id: mate.id }).eq('id', userId);
  await c.from('profiles').update({ partner_id: userId }).eq('id', mate.id);
  return mate;
}

export async function unlinkPartner(userId) {
  const c = sb(); if (!c) return;
  const me = await getProfile(userId);
  if (me && me.partner_id) await c.from('profiles').update({ partner_id: null }).eq('id', me.partner_id);
  await c.from('profiles').update({ partner_id: null }).eq('id', userId);
}
