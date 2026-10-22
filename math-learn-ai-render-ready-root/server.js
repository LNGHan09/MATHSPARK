require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'mathspark-documents';
const supabaseBrowserReady = Boolean(SUPABASE_URL && SUPABASE_PUBLIC_KEY);
const supabaseStorageReady = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
const supabaseAdmin = supabaseStorageReady ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }) : null;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC));

// Supabase Storage holds public learning materials. Uploads and metadata mutations run only on this server.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|doc|docx|ppt|pptx|xls|xlsx|png|jpg|jpeg|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Chỉ nhận PDF, Office và ảnh.'), ok);
  }
});

function requireAdmin(req, res, next) {
  const supplied = req.headers['x-admin-key'] || (req.body && req.body.adminKey);
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(503).json({ error: 'Chưa cấu hình ADMIN_PASSWORD trên Render.' });
  if (!supplied || supplied !== expected) return res.status(401).json({ error: 'Mật khẩu quản trị không đúng.' });
  next();
}
function requireSupabase(req, res, next) {
  if (!supabaseStorageReady) return res.status(503).json({ error: 'Chưa cấu hình Supabase Storage. Hãy thêm SUPABASE_URL và SUPABASE_SERVICE_ROLE_KEY vào Environment trên Render.' });
  next();
}
function cleanFileName(name) {
  return path.basename(String(name || 'document')).normalize('NFKC').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').slice(-120) || 'document';
}
function toPublicDocument(row) {
  let fileUrl = '';
  if (row.file_path && supabaseAdmin) fileUrl = supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(row.file_path).data.publicUrl;
  return {
    id: Number(row.id), title: row.title, description: row.description || '', category: row.category || 'chuyen-de',
    tags: row.tags || '', author: row.author || 'Ban quản trị', fileName: row.file_name || '', fileUrl,
    fileType: row.file_type || '', updatedAt: row.updated_at, createdAt: row.created_at
  };
}
async function listDocuments() {
  if (!supabaseAdmin) throw new Error('Supabase Storage chưa được cấu hình.');
  const { data, error } = await supabaseAdmin.from('learning_documents').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(toPublicDocument);
}
async function broadcastDocuments() {
  try {
    const docs = await listDocuments();
    const message = `event: documents\ndata: ${JSON.stringify(docs)}\n\n`;
    clients = clients.filter(response => { try { response.write(message); return true; } catch { return false; } });
  } catch (err) { console.error('Could not broadcast document list:', err.message); }
}
async function uploadToSupabase(file) {
  if (!file) return null;
  const objectPath = `documents/${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${cleanFileName(file.originalname)}`;
  const { error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(objectPath, file.buffer, {
    contentType: file.mimetype || 'application/octet-stream', cacheControl: '3600', upsert: false
  });
  if (error) throw error;
  return objectPath;
}
async function removeSupabaseFile(filePath) {
  if (!filePath || !supabaseAdmin) return;
  const { error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).remove([filePath]);
  if (error) console.warn('Could not remove old Supabase object:', error.message);
}

app.get('/api/config', (req, res) => {
  // Only publishable/anon key is sent to the browser. Never return the server secret.
  res.set('Cache-Control', 'no-store').json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_PUBLIC_KEY, supabaseReady: supabaseBrowserReady });
});
app.get('/api/health', (req, res) => res.json({
  ok: true,
  aiConfigured: Boolean(process.env.GEMINI_API_KEY),
  adminConfigured: Boolean(process.env.ADMIN_PASSWORD),
  supabaseAuthConfigured: supabaseBrowserReady,
  supabaseStorageConfigured: supabaseStorageReady
}));

app.get('/api/documents', async (req, res) => {
  try { res.set('Cache-Control', 'no-store').json(await listDocuments()); }
  catch (err) { console.error('Document list failed:', err.message); res.status(503).json({ error: 'Không tải được tài liệu từ Supabase. Hãy kiểm tra cấu hình và chạy supabase/setup.sql.', details: err.message }); }
});
let clients = [];
app.get('/api/documents/events', async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  clients.push(res);
  req.on('close', () => { clients = clients.filter(client => client !== res); });
  try { res.write(`event: documents\ndata: ${JSON.stringify(await listDocuments())}\n\n`); }
  catch (err) { res.write(`event: setup-error\ndata: ${JSON.stringify({ error: err.message })}\n\n`); }
});
app.post('/api/admin/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Hãy cấu hình ADMIN_PASSWORD trên Render trước.' });
  if (req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Mật khẩu chưa chính xác.' });
  res.json({ ok: true });
});

app.post('/api/admin/documents', requireAdmin, requireSupabase, upload.single('file'), async (req, res) => {
  let uploadedPath = null;
  try {
    const { title, description, category, tags, author } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Vui lòng nhập tên tài liệu.' });
    uploadedPath = await uploadToSupabase(req.file);
    const now = new Date().toISOString();
    const record = { title: title.trim(), description: (description || '').trim(), category: category || 'chuyen-de', tags: (tags || '').trim(), author: (author || '').trim() || 'Ban quản trị', file_name: req.file?.originalname || '', file_path: uploadedPath, file_type: req.file?.mimetype || '', created_at: now, updated_at: now };
    const { data, error } = await supabaseAdmin.from('learning_documents').insert(record).select('*').single();
    if (error) throw error;
    const document = toPublicDocument(data);
    await broadcastDocuments();
    res.json({ ok: true, document });
  } catch (err) {
    if (uploadedPath) await removeSupabaseFile(uploadedPath);
    console.error('Create document failed:', err.message);
    res.status(500).json({ error: `Không lưu được tài liệu vào Supabase: ${err.message}` });
  }
});

app.put('/api/admin/documents/:id', requireAdmin, requireSupabase, upload.single('file'), async (req, res) => {
  let newPath = null;
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'ID tài liệu không hợp lệ.' });
    const { data: existing, error: findError } = await supabaseAdmin.from('learning_documents').select('*').eq('id', id).maybeSingle();
    if (findError) throw findError;
    if (!existing) return res.status(404).json({ error: 'Không tìm thấy tài liệu.' });
    newPath = await uploadToSupabase(req.file);
    const changes = { updated_at: new Date().toISOString() };
    for (const [source, target] of [['title','title'],['description','description'],['category','category'],['tags','tags'],['author','author']]) {
      if (req.body[source] !== undefined) changes[target] = req.body[source];
    }
    if (req.file) { changes.file_name = req.file.originalname; changes.file_path = newPath; changes.file_type = req.file.mimetype; }
    const { data, error } = await supabaseAdmin.from('learning_documents').update(changes).eq('id', id).select('*').single();
    if (error) throw error;
    if (req.file && existing.file_path && existing.file_path !== newPath) await removeSupabaseFile(existing.file_path);
    await broadcastDocuments();
    res.json({ ok: true, document: toPublicDocument(data) });
  } catch (err) {
    if (newPath) await removeSupabaseFile(newPath);
    console.error('Update document failed:', err.message);
    res.status(500).json({ error: `Không cập nhật được tài liệu: ${err.message}` });
  }
});

app.delete('/api/admin/documents/:id', requireAdmin, requireSupabase, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) return res.status(400).json({ error: 'ID tài liệu không hợp lệ.' });
    const { data: existing, error: findError } = await supabaseAdmin.from('learning_documents').select('*').eq('id', id).maybeSingle();
    if (findError) throw findError;
    if (!existing) return res.status(404).json({ error: 'Không tìm thấy tài liệu.' });
    const { error } = await supabaseAdmin.from('learning_documents').delete().eq('id', id);
    if (error) throw error;
    await removeSupabaseFile(existing.file_path);
    await broadcastDocuments();
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete document failed:', err.message);
    res.status(500).json({ error: `Không xóa được tài liệu: ${err.message}` });
  }
});

app.post('/api/ai/:task', (req, res) => res.status(503).json({ error: process.env.GEMINI_API_KEY ? 'Endpoint AI chưa được tích hợp trong bản quản trị này.' : 'Chưa cấu hình GEMINI_API_KEY trên máy chủ.' }));
app.use((err, req, res, next) => {
  console.error(err.message);
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Tệp vượt quá giới hạn 20 MB.' : (err.message || 'Có lỗi xảy ra.') });
});

async function migrateLegacyDocumentsBestEffort() {
  if (!supabaseAdmin) return;
  try {
    const { data: existing, error: checkError } = await supabaseAdmin.from('learning_documents').select('id').limit(1);
    if (checkError) { console.warn('Supabase migration skipped (check the setup SQL):', checkError.message); return; }
    if (existing && existing.length) return;
    const legacyDataPath = path.join(ROOT, 'data', 'documents.json');
    const legacyUploads = path.join(ROOT, 'uploads');
    if (!fs.existsSync(legacyDataPath)) return;
    let legacyDocs = [];
    try { legacyDocs = JSON.parse(fs.readFileSync(legacyDataPath, 'utf8')); } catch { return; }
    if (!Array.isArray(legacyDocs) || !legacyDocs.length) return;
    const mimeByExt = { '.pdf':'application/pdf', '.doc':'application/msword', '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.ppt':'application/vnd.ms-powerpoint', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.xls':'application/vnd.ms-excel', '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
    let migrated = 0;
    for (const old of [...legacyDocs].reverse()) {
      let filePath = null;
      let fileName = old.fileName || '';
      let fileType = old.fileType || '';
      if (old.fileUrl && String(old.fileUrl).startsWith('/uploads/')) {
        const oldFile = path.join(legacyUploads, path.basename(old.fileUrl));
        if (fs.existsSync(oldFile)) {
          const originalName = fileName || path.basename(oldFile);
          const ext = path.extname(originalName).toLowerCase();
          const buffer = fs.readFileSync(oldFile);
          fileType = fileType || mimeByExt[ext] || 'application/pdf';
          filePath = await uploadToSupabase({ buffer, originalname: originalName, mimetype: fileType });
        }
      }
      const row = {
        title: String(old.title || 'Tài liệu cũ'), description: String(old.description || ''),
        category: ['chuyen-de','de-vao-10','de-giua-ky','de-cuoi-ky'].includes(old.category) ? old.category : 'chuyen-de',
        tags: String(old.tags || ''), author: String(old.author || 'Ban quản trị'), file_name: fileName,
        file_path: filePath, file_type: fileType, created_at: old.createdAt || new Date().toISOString(), updated_at: old.updatedAt || old.createdAt || new Date().toISOString()
      };
      const { error: insertError } = await supabaseAdmin.from('learning_documents').insert(row);
      if (insertError) throw insertError;
      migrated++;
    }
    if (migrated) console.log(`Best-effort migration copied ${migrated} legacy document(s) to Supabase.`);
  } catch (err) {
    console.warn('Legacy document migration could not finish; re-upload missing files from Admin if needed:', err.message);
  }
}

(async () => {
  await migrateLegacyDocumentsBestEffort();
  app.listen(PORT, () => {
    console.log(`MathSpark đang chạy tại http://localhost:${PORT}`);
    if (!supabaseBrowserReady) console.warn('Supabase Auth chưa cấu hình: thiếu SUPABASE_URL/SUPABASE_ANON_KEY.');
    if (!supabaseStorageReady) console.warn('Supabase Storage chưa cấu hình: thiếu SUPABASE_SERVICE_ROLE_KEY/SUPABASE_SECRET_KEY.');
  });
})();
