require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'mathspark-documents';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY, timeout: 90000, maxRetries: 1 }) : null;
const supabaseBrowserReady = Boolean(SUPABASE_URL && SUPABASE_PUBLIC_KEY);
const supabaseStorageReady = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
const supabaseAdmin = supabaseStorageReady ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } }) : null;

app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
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
  aiConfigured: Boolean(OPENAI_API_KEY),
  aiProvider: 'OpenAI',
  aiModel: OPENAI_MODEL,
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

// OpenAI-backed learning features. Keep OPENAI_API_KEY on the server only.
const aiUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 7 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpeg|webp)$/.test(file.mimetype || '');
    cb(ok ? null : new Error('Ảnh phải ở định dạng PNG, JPG hoặc WEBP.'), ok);
  }
});
const aiLimitBuckets = new Map();
function aiRateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip || req.socket.remoteAddress || 'unknown'}:${req.path}`;
    let entry = aiLimitBuckets.get(key);
    if (!entry || now >= entry.resetAt) entry = { count: 0, resetAt: now + windowMs };
    entry.count += 1;
    aiLimitBuckets.set(key, entry);
    if (aiLimitBuckets.size > 2000) {
      for (const [k, v] of aiLimitBuckets) if (now >= v.resetAt) aiLimitBuckets.delete(k);
    }
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    if (entry.count > max) return res.status(429).json({ error: 'Bạn gửi yêu cầu AI quá nhanh. Vui lòng đợi một chút rồi thử lại.' });
    next();
  };
}
function ensureOpenAI(req, res, next) {
  if (!openai) return res.status(503).json({ error: 'Máy chủ chưa có OPENAI_API_KEY. Hãy kiểm tra Environment trên Render.' });
  next();
}
function responseText(response) {
  const text = String(response?.output_text || '').trim();
  if (!text) throw new Error('AI không trả về nội dung. Hãy thử lại với yêu cầu ngắn hơn.');
  return text;
}
function parseModelJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {}
  const first = cleaned.indexOf('{'), last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
  throw new Error('AI trả về dữ liệu chưa đúng định dạng. Vui lòng thử lại.');
}
function providerError(err) {
  const status = Number(err?.status || err?.statusCode || 0);
  console.error('OpenAI request failed:', { status, message: String(err?.message || 'unknown').slice(0, 350) });
  if (status === 401 || status === 403) return { status: 502, message: 'OpenAI từ chối API key hoặc quyền truy cập. Kiểm tra OPENAI_API_KEY và quyền của key trong Render.' };
  if (status === 404) return { status: 502, message: `Không tìm thấy model ${OPENAI_MODEL} hoặc project chưa có quyền dùng model này. Kiểm tra model ID trong OpenAI API.` };
  if (status === 429) return { status: 429, message: 'OpenAI đang giới hạn yêu cầu hoặc tài khoản hết hạn mức API. Kiểm tra Usage/Billing trên OpenAI Platform.' };
  if (status === 400) return { status: 400, message: 'Yêu cầu gửi đến AI chưa hợp lệ. Hãy thử lại với ảnh rõ hơn hoặc nội dung ngắn hơn.' };
  return { status: 502, message: 'OpenAI chưa xử lý được yêu cầu lúc này. Vui lòng thử lại sau.' };
}
async function callOpenAI({ instructions, input, maxOutputTokens = 1800, reasoningEffort }) {
  const params = { model: OPENAI_MODEL, instructions, input, max_output_tokens: maxOutputTokens };
  if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
  const response = await openai.responses.create(params);
  return responseText(response);
}
function aiEndpointError(res, err) {
  const mapped = providerError(err);
  return res.status(mapped.status).json({ error: mapped.message });
}
function safeText(value, max = 6000) { return String(value ?? '').trim().slice(0, max); }

app.post('/api/ai/grade-solution', aiRateLimit(5, 10 * 60 * 1000), ensureOpenAI, aiUpload.fields([{ name: 'problemImage', maxCount: 1 }, { name: 'solutionImage', maxCount: 1 }]), async (req, res) => {
  try {
    const problem = req.files?.problemImage?.[0];
    const solution = req.files?.solutionImage?.[0];
    if (!problem || !solution) return res.status(400).json({ error: 'Hãy tải cả ảnh đề bài và ảnh lời giải.' });
    const topic = safeText(req.body.topic || 'Chưa xác định', 150);
    const scoreScale = ['1','4','10'].includes(String(req.body.scoreScale)) ? String(req.body.scoreScale) : '10';
    const notes = safeText(req.body.notes || '', 1500);
    const dataUrl = f => `data:${f.mimetype};base64,${f.buffer.toString('base64')}`;
    const prompt = `Bạn là trợ lý chấm bài Toán lớp 9 phục vụ luyện thi vào lớp 10 tại Việt Nam. Chấm công bằng theo quá trình, không chỉ so đáp số.\nChuyên đề người học chọn: ${topic}. Thang điểm tối đa: ${scoreScale}.\nYêu cầu thêm: ${notes || 'Không có'}.\n\nHãy đọc ảnh đề bài và ảnh bài làm. Nếu chữ, ký hiệu hay hình không đọc rõ, nêu rõ phần chưa chắc chắn, không tự bịa nội dung. Phân tích theo các mục Markdown sau:\n## Kết quả\nNêu điểm đề xuất x/${scoreScale} và mức độ chắc chắn. Nếu đề không cung cấp thang điểm từng ý, nói rõ đây là điểm ước lượng và đưa ra cách chia điểm hợp lý.\n## Chấm theo từng bước\nDùng bảng: bước/lập luận của học sinh, đánh giá, điểm đề xuất, lý do. Chỉ trừ điểm ở lỗi có căn cứ; công nhận các bước đúng dù đáp số cuối sai.\n## Lỗi sai cụ thể\nTrích ngắn bước sai, giải thích tại sao sai và hướng sửa. Kiểm tra điều kiện xác định, biến đổi tương đương, dấu, đơn vị, kết luận và lập luận hình học nếu liên quan.\n## Phân tích thói quen tư duy (giả thuyết)\nChỉ nêu giả thuyết có căn cứ từ bài này; không kết luận chắc chắn về một lối mòn từ một bài đơn lẻ. Phân biệt lỗi tính toán nhất thời và dấu hiệu cần kiểm tra thêm.\n## Lời giải tham khảo\nTrình bày lời giải đúng, đủ các bước, phù hợp kiến thức Toán 9.\n## Bài tập kiểm tra lại\nĐưa 1-2 câu ngắn nhắm vào lỗi vừa phát hiện, có thể kèm đáp án ở cuối.\nKhông giả vờ là giáo viên đã xác nhận điểm; nhắc rằng kết quả AI là gợi ý cần đối chiếu với đáp án/thang điểm của giáo viên, đặc biệt khi ảnh không rõ.`;
    const feedback = await callOpenAI({
      instructions: 'Trả lời bằng tiếng Việt rõ ràng, thân thiện, đúng kiến thức Toán 9. Ưu tiên kiểm chứng lập luận; không đoán khi ảnh không đọc được.',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: prompt },
        { type: 'input_text', text: 'Ảnh 1: Đề bài.' },
        { type: 'input_image', image_url: dataUrl(problem), detail: 'high' },
        { type: 'input_text', text: 'Ảnh 2: Bài làm tự luận của học sinh.' },
        { type: 'input_image', image_url: dataUrl(solution), detail: 'high' }
      ] }],
      maxOutputTokens: 3000,
      reasoningEffort: 'medium'
    });
    res.json({ ok: true, model: OPENAI_MODEL, feedback });
  } catch (err) { aiEndpointError(res, err); }
});
app.post('/api/ai/:task', aiRateLimit(24, 60 * 1000), ensureOpenAI, async (req, res) => {
  const task = req.params.task;
  try {
    if (task === 'chat') {
      const messages = Array.isArray(req.body.messages) ? req.body.messages.slice(-20) : [];
      const input = messages.map(m => ({ role: ['assistant','model'].includes(m.role) ? 'assistant' : 'user', content: safeText(m.text || m.content, 3000) })).filter(m => m.content);
      if (!input.length) return res.status(400).json({ error: 'Hãy nhập câu hỏi trước khi gửi.' });
      const reply = await callOpenAI({
        instructions: 'Bạn là gia sư AI của MathSpark dành cho học sinh lớp 9 ôn thi vào lớp 10 tại Việt Nam. Giải thích theo từng bước, hỏi lại khi đề thiếu dữ kiện, không khẳng định điểm/lỗi nếu thiếu bằng chứng. Dùng LaTeX cho công thức khi phù hợp. Khi người học hỏi bài, ưu tiên hướng dẫn cách nghĩ và kiểm tra điều kiện, không chỉ đưa đáp án.',
        input,
        maxOutputTokens: 1300,
        reasoningEffort: 'low'
      });
      return res.json({ ok: true, model: OPENAI_MODEL, reply });
    }
    if (task === 'search') {
      const query = safeText(req.body.query, 300);
      const items = Array.isArray(req.body.items) ? req.body.items.slice(0, 120).map(item => ({ id: item.id, title: safeText(item.title, 160), description: safeText(item.description, 300), tags: safeText(item.tags, 300), category: safeText(item.category, 100) })) : [];
      if (!query || !items.length) return res.json({ ids: [] });
      const text = await callOpenAI({ instructions: 'Chỉ xếp hạng tài liệu phù hợp với truy vấn người dùng. Không bịa ID. Trả về duy nhất JSON: {"ids":[...]} theo thứ tự phù hợp giảm dần.', input: JSON.stringify({ query, items }), maxOutputTokens: 700, reasoningEffort: 'low' });
      const parsed = parseModelJson(text);
      const byId = new Map(items.map(item => [String(item.id), item.id]));
      const ids = Array.isArray(parsed.ids) ? [...new Set(parsed.ids.map(String).filter(id => byId.has(id)).map(id => byId.get(id)))] : [];
      return res.json({ ids });
    }
    if (task === 'study-plan') {
      const body = req.body || {};
      const availableSlots = Array.isArray(body.availableSlots) ? body.availableSlots.slice(0, 80) : [];
      const topics = Array.isArray(body.weakTopics) ? body.weakTopics.slice(0, 30) : [];
      const text = await callOpenAI({
        instructions: 'Bạn là chuyên gia lập lộ trình ôn thi Toán 9 vào lớp 10. Chỉ dùng các khoảng thời gian đã cung cấp, không tự tạo thêm buổi hoặc đổi giờ. Ưu tiên chủ đề yếu, ôn xen kẽ và tăng độ khó dần. Trả JSON duy nhất dạng {"plan":[{"topic":"...","task":"...","level":"...","questionCount":5}]}. Mỗi phần tử tương ứng cùng thứ tự một block đầu vào.',
        input: JSON.stringify({ targetScore: body.targetScore, examName: safeText(body.examName, 120), examDate: safeText(body.examDate, 30), diagnosticScore: body.diagnosticScore, practiceScore: body.practiceScore, scoreGap: body.scoreGap, daysLeft: body.daysLeft, availableSlots, weakTopics: topics }),
        maxOutputTokens: 2200,
        reasoningEffort: 'medium'
      });
      const parsed = parseModelJson(text);
      const plan = Array.isArray(parsed.plan) ? parsed.plan.slice(0, availableSlots.length).map(item => ({ topic: safeText(item.topic, 120), task: safeText(item.task, 400), level: safeText(item.level, 40), questionCount: Math.min(30, Math.max(1, Number(item.questionCount) || 5)) })).filter(item => item.topic || item.task) : [];
      return res.json({ plan });
    }
    if (task === 'generate-questions') {
      const body = req.body || {};
      const count = Math.min(12, Math.max(1, Number(body.count) || 5));
      const topic = safeText(body.topic || 'Đề tổng hợp vào lớp 10', 150);
      const difficulty = ({'co-ban':'cơ bản','van-dung':'vận dụng','nang-cao':'nâng cao'})[body.difficulty] || 'vận dụng';
      const text = await callOpenAI({
        instructions: `Bạn là giáo viên Toán lớp 9 Việt Nam, tạo câu hỏi trắc nghiệm chính xác cho đề tuyển sinh lớp 10. Tạo đúng ${count} câu, chủ đề ${topic}, độ khó ${difficulty}. Mỗi câu có đúng 4 lựa chọn, chỉ một đáp án đúng. Kiểm tra lời giải và đáp án trước khi trả. Trả JSON duy nhất: {"questions":[{"topic":"...","difficulty":"co-ban|van-dung|nang-cao","q":"...","options":["...","...","...","..."],"answer":0,"explain":"..."}]}. answer là chỉ số 0-based của đáp án đúng. Không dùng Markdown ngoài JSON.`,
        input: JSON.stringify({ topic, difficulty, count, grade: 9, examType: safeText(body.examType || 'tuyển sinh vào lớp 10', 100) }),
        maxOutputTokens: Math.min(6000, 750 + count * 380),
        reasoningEffort: 'medium'
      });
      const parsed = parseModelJson(text);
      if (!Array.isArray(parsed.questions)) throw new Error('AI chưa trả về danh sách câu hỏi đúng định dạng.');
      const questions = parsed.questions.slice(0, count).filter(q => typeof q.q === 'string' && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(Number(q.answer)) && Number(q.answer) >= 0 && Number(q.answer) < 4).map(q => ({ topic: safeText(q.topic || topic, 150), difficulty: ['co-ban','van-dung','nang-cao'].includes(q.difficulty) ? q.difficulty : body.difficulty || 'van-dung', q: safeText(q.q, 1000), options: q.options.map(option => safeText(option, 400)), answer: Number(q.answer), explain: safeText(q.explain, 1200) }));
      if (!questions.length) throw new Error('AI chưa tạo được câu hỏi hợp lệ. Vui lòng thử lại.');
      return res.json({ questions });
    }
    return res.status(404).json({ error: 'Chức năng AI này chưa được hỗ trợ.' });
  } catch (err) {
    if (err instanceof SyntaxError) return res.status(502).json({ error: 'AI trả về dữ liệu chưa đúng định dạng. Hãy thử lại.' });
    return aiEndpointError(res, err);
  }
});
app.use((err, req, res, next) => {
  console.error(err.message);
  const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  res.status(status).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Tệp vượt giới hạn dung lượng cho phép (ảnh chấm bài tối đa 7 MB mỗi ảnh; tài liệu Admin tối đa 20 MB).' : (err.message || 'Có lỗi xảy ra.') });
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
    if (!openai) console.warn('OpenAI chưa cấu hình: thiếu OPENAI_API_KEY.');
    else console.log(`OpenAI ready; default model: ${OPENAI_MODEL}`);
  });
})();
