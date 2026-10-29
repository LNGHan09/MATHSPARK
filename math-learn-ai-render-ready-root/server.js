require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');
const { PDFDocument } = require('pdf-lib');
const MathSparkDiagnosticEngine = require('./mathspark-diagnostic-engine');

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


// ---------- Admin-managed exam bank and one-question-at-a-time exams ----------
function examPublicFileUrl(filePath) {
  if (!filePath || !supabaseAdmin) return '';
  return supabaseAdmin.storage.from(STORAGE_BUCKET).getPublicUrl(filePath).data.publicUrl;
}
function examAdminView(row) {
  return {
    id: String(row.id), title: row.title, description: row.description || '',
    durationMinutes: Number(row.duration_minutes || 120), status: row.status || 'draft',
    bankType: row.bank_type || 'exam', aiRequest: row.ai_request || '',
    sourceFileName: row.source_file_name || '', sourceFileUrl: examPublicFileUrl(row.source_file_path),
    questionCount: Array.isArray(row.questions) ? row.questions.length : 0,
    questions: Array.isArray(row.questions) ? row.questions : [],
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}
function examStudentView(row) {
  return {
    id: String(row.id), title: row.title, description: row.description || '', bankType: row.bank_type || 'exam',
    durationMinutes: Number(row.duration_minutes || 120), questionCount: Array.isArray(row.questions) ? row.questions.length : 0,
    questionTypes: [...new Set((row.questions || []).map(q => {
      const type = String(q.type || '').toLowerCase();
      if (['multi_select','multiple_select','multiple_choice_multiple_answers','multiple-choice-multiple-answers'].includes(type) || /nhiều.*đáp án|multiple.*answers/i.test(type)) return 'Trắc nghiệm nhiều đáp án';
      if (['short_answer','short-answer','short_answer_photo','short-answer-photo','short_response','fill_in','fill_blank','trả lời ngắn','tra loi ngan'].includes(type)) return 'Trả lời ngắn · chụp ảnh';
      if (['mcq','multiple_choice','multiple-choice','single_choice','single-choice','trắc nghiệm'].includes(type) || (Array.isArray(q.options) && q.options.length >= 4)) return 'Trắc nghiệm một đáp án';
      return 'Tự luận · chụp ảnh';
    }))],
    createdAt: row.created_at
  };
}
function normalizeExamMathText(value) {
  let text = String(value ?? '').replace(/\r\n?/g, '\n');
  // Repair commands that were double-escaped or lost their backslash/braces during extraction.
  text = text.replace(/\\+(?=(?:begin|end|frac|dfrac|tfrac|sqrt|text|cdot|times|leq|geq|neq|triangle|angle|boxed|overline|perp|parallel|approx|sin|cos|tan|left|right)\b)/gi, '\\');
  text = text.replace(/(^|[^A-Za-z\\])\\{0,2}(begin|end)\s*\{?\s*(cases|aligned|array|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\s*\}?/gi,
    (_whole, prefix, command, env) => `${prefix}\\${command.toLowerCase()}{${env.toLowerCase()}}`);

  // In a cases block a malformed \( after a row break is usually a row separator followed by a parenthesis.
  const envPattern = /\\begin\{(cases|aligned|array|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}([\s\S]*?)\\end\{\1\}/gi;
  text = text.replace(envPattern, (whole, env, body, offset, source) => {
    const repairedBody = body.replace(/\\+\s*\(/g, '\\\\ (');
    const prefix = source.slice(0, offset);
    const lastOpen = Math.max(prefix.lastIndexOf('\\('), prefix.lastIndexOf('\\['), prefix.lastIndexOf('$$'));
    const lastClose = Math.max(prefix.lastIndexOf('\\)'), prefix.lastIndexOf('\\]'), prefix.lastIndexOf('$$'));
    const alreadyInsideMath = lastOpen > lastClose;
    const environment = `\\begin{${env}}${repairedBody}\\end{${env}}`;
    return alreadyInsideMath ? environment : `\\[${environment}\\]`;
  });

  // Avoid mangled commands like `begincases...endcases` remaining as literal text.
  return text;
}

function normalizeExamQuestions(input) {
  if (!Array.isArray(input)) throw new Error('Danh sách câu hỏi phải là một mảng.');
  if (input.length > 100) throw new Error('Một đề tối đa 100 câu trong bản hiện tại.');
  const usedQuestionIds = new Set();
  const normalizeChoiceLabels = value => {
    const raw = Array.isArray(value) ? value : (value == null || value === '' ? [] : String(value).split(/[;,\s]+/));
    const mapped = raw.map(item => {
      const text = String(item ?? '').trim().toUpperCase();
      if (/^[0-4]$/.test(text)) return ['A','B','C','D','E'][Number(text)];
      const match = text.match(/^(?:OPTION\s*)?([A-E])(?:[).:]|\s|$)/);
      return match ? match[1] : '';
    }).filter(Boolean);
    return [...new Set(mapped)].sort();
  };
  const explicitMultiTypes = new Set(['multi_select','multi-select','multiple_select','multiple-select','multiple_answers','multiple-answers','multiple_choice_multiple_answers','multiple-choice-multiple-answers','trắc nghiệm nhiều đáp án','trac nghiem nhieu dap an']);
  const explicitSingleTypes = new Set(['mcq','multiple_choice','multiple-choice','single_choice','single-choice','trắc nghiệm','trac nghiem','trắc nghiệm một đáp án','trac nghiem mot dap an']);
  // Short-answer questions are distinct from full essays, but both use photo submissions.
  const explicitShortAnswerTypes = new Set(['short_answer','short-answer','short_answer_photo','short-answer-photo','short_response','short-response','fill_in','fill-in','fill_blank','fill-blank','trả lời ngắn','tra loi ngan','điền đáp án','dien dap an','điền từ','dien tu','câu trả lời ngắn','cau tra loi ngan']);
  const explicitEssayTypes = new Set(['essay','written','free_response','free-response','tự luận','tu luan']);

  return input.map((raw, index) => {
    const q = raw && typeof raw === 'object' ? raw : {};
    const number = index + 1; // The parsed JSON array preserves source/PDF order.
    const qType = String(q.type || '').trim().toLocaleLowerCase('vi');
    const rawOptions = Array.isArray(q.options) ? q.options.slice(0, 5) : [];
    const labelsInOptions = rawOptions.map((op, j) => {
      if (typeof op === 'string') return ['A','B','C','D','E'][j];
      const rawLabel = String(op?.label || ['A','B','C','D','E'][j]).trim().toUpperCase();
      return /^[A-E]$/.test(rawLabel) ? rawLabel : ['A','B','C','D','E'][j];
    });
    const hasCorrectAnswers = Array.isArray(q.correctAnswers) ? q.correctAnswers.length > 0 : (q.correctAnswers != null && String(q.correctAnswers).trim() !== '');
    const rawCorrectValue = hasCorrectAnswers ? q.correctAnswers : q.correctAnswer;
    const correctLabels = normalizeChoiceLabels(rawCorrectValue);
    const hasChoiceOptions = rawOptions.length >= 2;
    const explicitlyMulti = explicitMultiTypes.has(qType) || /nhiều.*đáp án|multiple.*answers/.test(qType);
    const explicitlySingle = explicitSingleTypes.has(qType);
    const explicitlyShortAnswer = explicitShortAnswerTypes.has(qType) || /(trả lời ngắn|tra loi ngan|điền đáp án|dien dap an|điền từ|dien tu)/.test(qType);
    const explicitlyEssay = explicitEssayTypes.has(qType);
    let type;
    if (explicitlyShortAnswer) type = 'short_answer';
    else if (explicitlyEssay) type = 'essay';
    else if (explicitlyMulti) type = 'multi_select';
    else if (explicitlySingle) type = 'mcq';
    else if (correctLabels.length > 1) type = 'multi_select';
    else if (hasChoiceOptions) type = 'mcq';
    else type = 'essay';

    const hasOptionE = rawOptions.length > 4 || labelsInOptions.includes('E') || correctLabels.includes('E');
    const optionLabels = hasOptionE ? ['A','B','C','D','E'] : ['A','B','C','D'];
    let options = rawOptions.map((op, j) => {
      if (typeof op === 'string') return { label: optionLabels[j] || ['A','B','C','D','E'][j], text: normalizeExamMathText(safeText(op, 1600)) };
      const label = String(op?.label || ['A','B','C','D','E'][j]).trim().toUpperCase();
      const safeLabel = /^[A-E]$/.test(label) ? label : (optionLabels[j] || ['A','B','C','D','E'][j]);
      const errorCode = MathSparkDiagnosticEngine.validErrorCode(op?.errorCode || op?.error_code || op?.diagnosticCode);
      return {
        label: safeLabel,
        text: normalizeExamMathText(safeText(op?.text ?? op?.content ?? '', 1600)),
        ...(errorCode ? { errorCode } : {})
      };
    });
    if (type === 'mcq' || type === 'multi_select') {
      // Keep a stable A-D/A-E option layout for the student UI, without exposing diagnostic metadata.
      const byLabel = new Map(options.map(option => [option.label, option]));
      options = optionLabels.map(label => byLabel.get(label) || { label, text: '' });
    } else options = [];

    const rawBox = Array.isArray(q.diagramBbox) ? q.diagramBbox : null;
    const diagramBbox = rawBox && rawBox.length === 4 && rawBox.every(v => Number.isFinite(Number(v)))
      ? rawBox.map(v => Math.max(0, Math.min(1000, Math.round(Number(v))))) : null;
    const sourcePage = Math.max(0, Math.min(500, Number(q.sourcePage) || 0));
    const correctAnswer = type === 'mcq' ? (correctLabels[0] || normalizeChoiceLabels(q.correctAnswer)[0] || '') : '';
    const correctAnswers = type === 'multi_select'
      ? correctLabels
      : (type === 'mcq' ? (correctAnswer ? [correctAnswer] : []) : []);
    const expectedAnswer = normalizeExamMathText(safeText(q.expectedAnswer ?? q.expected_answer ?? q.shortAnswer ?? q.answerText ?? (type === 'short_answer' && typeof q.answer === 'string' ? q.answer : ''), 2200));
    const rawKeywords = q.answerKeywords ?? q.answer_keywords ?? '';
    const answerKeywords = Array.isArray(rawKeywords)
      ? rawKeywords.slice(0, 20).map(value => normalizeExamMathText(safeText(value, 180))).filter(Boolean)
      : String(rawKeywords).split(/[;,\n]/).map(value => normalizeExamMathText(safeText(value, 180))).filter(Boolean).slice(0, 20);
    const sourceQuestionNumber = safeText(q.sourceQuestionNumber ?? q.source_question_number ?? q.originalNumber ?? q.original_number ?? '', 40);
    const providedAnswerSource = String(q.answerSource || '').trim();
    const hasAnyReferenceAnswer = Boolean(correctAnswers.length || correctAnswer || expectedAnswer);
    const answerSource = ['answer_key','ai_solved','unknown','admin_verified'].includes(providedAnswerSource)
      ? providedAnswerSource
      : (hasAnyReferenceAnswer ? 'ai_solved' : 'unknown');
    const baseId = safeText(q.id || `q${number}`, 50).replace(/[^A-Za-z0-9_-]/g, '') || `q${number}`;
    let uniqueId = baseId, suffix = 2;
    while (usedQuestionIds.has(uniqueId)) uniqueId = `${baseId}_${suffix++}`;
    usedQuestionIds.add(uniqueId);
    let distractorMap = {};
    try {
      const rawMap = q.distractorMap && typeof q.distractorMap === 'object' && !Array.isArray(q.distractorMap) ? q.distractorMap : {};
      for (const [label, value] of Object.entries(rawMap)) {
        const key = normalizeChoiceLabels(label)[0];
        const code = MathSparkDiagnosticEngine.validErrorCode(typeof value === 'object' ? value?.errorCode || value?.code : value);
        if (key && code) distractorMap[key] = code;
      }
    } catch {}
    const skillCode = MathSparkDiagnosticEngine.validSkillCode(q.skillCode || q.skill_code);
    const parallelKey = safeText(q.parallelKey || q.parallel_key || '', 120).replace(/[\r\n\t]/g, ' ').trim();
    return {
      id: uniqueId, number, type, sourceQuestionNumber,
      prompt: normalizeExamMathText(safeText(q.prompt, 9000)), options,
      correctAnswer, correctAnswers, expectedAnswer, answerKeywords, answerSource,
      // If the model labels a single-choice item but emits multiple answer keys, retain single-choice behavior and force admin review.
      needsReview: q.needsReview !== false || (explicitlySingle && correctLabels.length > 1),
      solution: normalizeExamMathText(safeText(q.solution, 4000)),
      rubric: normalizeExamMathText(safeText(q.rubric, 3000)),
      points: Math.max(0, Math.min(100, Number(q.points) || (type === 'mcq' || type === 'multi_select' ? 1 : 2))),
      partialCredit: q.partialCredit === true,
      distractorMap, skillCode, parallelKey,
      sourcePage, hasDiagram: Boolean(q.hasDiagram || diagramBbox), diagramBbox,
      origin: q.origin === 'ai_generated' ? 'ai_generated' : (q.origin === 'source' ? 'source' : (sourcePage > 0 ? 'source' : '')),
      diagramDescription: safeText(q.diagramDescription, 1000)
    };
  });
}
function examQuestionPublishValidationError(q) {
  if (!q || !['mcq','multi_select'].includes(q.type)) return '';
  const options = new Map((Array.isArray(q.options) ? q.options : []).map(option => [String(option.label || '').toUpperCase(), String(option.text || '').trim()]));
  const required = ['A','B','C','D'];
  if (options.has('E')) required.push('E');
  const missing = required.filter(label => !options.get(label));
  if (missing.length) return `Câu ${q.number} cần nội dung cho các lựa chọn ${missing.join(', ')}.`;
  const available = new Set(required);
  if (q.answerSource === 'unknown') return `Câu ${q.number} chưa có đáp án đã xác minh.`;
  if (q.type === 'mcq' && (!q.correctAnswer || !available.has(q.correctAnswer))) {
    return `Câu ${q.number} cần một đáp án đúng thuộc các lựa chọn ${required.join(', ')}.`;
  }
  if (q.type === 'multi_select') {
    const correct = Array.isArray(q.correctAnswers) ? q.correctAnswers : [];
    if (!correct.length || correct.some(label => !available.has(label))) return `Câu ${q.number} cần ít nhất một đáp án đúng hợp lệ trong ${required.join(', ')}.`;
  }
  return '';
}

async function getExamRow(id, { publishedOnly = false } = {}) {
  if (!supabaseAdmin) throw new Error('Supabase chưa được cấu hình.');
  let query = supabaseAdmin.from('learning_exams').select('*').eq('id', String(id)).maybeSingle();
  const { data, error } = await query;
  if (error) throw error;
  if (!data || (publishedOnly && data.status !== 'published')) return null;
  return data;
}
app.get('/api/admin/exams', requireAdmin, requireSupabase, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('learning_exams').select('*').eq('bank_type','exam').order('created_at', { ascending: false });
    if (error) throw error;
    res.set('Cache-Control','no-store').json((data || []).map(examAdminView));
  } catch (err) {
    console.error('Admin exam list failed:', err.message);
    res.status(503).json({ error: 'Không tải được kho đề. Hãy chạy supabase/exam-bank.sql trong Supabase SQL Editor.', details: err.message });
  }
});
app.post('/api/admin/exams', requireAdmin, requireSupabase, upload.single('file'), async (req, res) => {
  let uploadedPath = null;
  try {
    const file = req.file;
    if (!file || !/\.pdf$/i.test(file.originalname) || (file.mimetype && !['application/pdf','application/octet-stream'].includes(file.mimetype))) {
      return res.status(400).json({ error: 'Kho đề hiện nhận tệp PDF. Hãy xuất Word/ảnh thành PDF rồi tải lên.' });
    }
    const title = safeText(req.body.title || path.basename(file.originalname, path.extname(file.originalname)), 180);
    if (!title) return res.status(400).json({ error: 'Vui lòng nhập tên đề thi.' });
    const objectPath = `exams/${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${cleanFileName(file.originalname)}`;
    const { error: uploadError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(objectPath, file.buffer, { contentType: 'application/pdf', cacheControl: '3600', upsert: false });
    if (uploadError) throw uploadError;
    uploadedPath = objectPath;
    const row = {
      title, description: safeText(req.body.description || '', 1500),
      duration_minutes: Math.max(10, Math.min(360, Number(req.body.durationMinutes) || 120)),
      status: 'draft', bank_type: 'exam', ai_request: '', source_file_name: file.originalname, source_file_path: uploadedPath,
      questions: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    const { data, error } = await supabaseAdmin.from('learning_exams').insert(row).select('*').single();
    if (error) throw error;
    res.json({ ok: true, exam: examAdminView(data), message: 'Đã tải đề lên. Tiếp theo hãy dùng AI phân tích rồi kiểm tra đáp án trước khi đăng.' });
  } catch (err) {
    if (uploadedPath) await removeSupabaseFile(uploadedPath);
    console.error('Exam upload failed:', err.message);
    res.status(500).json({ error: `Không lưu được đề thi: ${err.message}` });
  }
});
app.post('/api/admin/exams/:id/analyze', requireAdmin, requireSupabase, aiRateLimit(3, 10 * 60 * 1000), ensureOpenAI, async (req, res) => {
  try {
    const row = await getExamRow(req.params.id);
    if (!row || (row.bank_type || 'exam') !== 'exam') return res.status(404).json({ error: 'Không tìm thấy đề thi trong Kho đề luyện thi.' });
    if (!row.source_file_path) return res.status(400).json({ error: 'Đề chưa có tệp PDF gốc.' });
    const { data: blob, error: downloadError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(row.source_file_path);
    if (downloadError) throw downloadError;
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (!buffer.length) return res.status(400).json({ error: 'Tệp PDF rỗng.' });
    const dataUrl = `data:application/pdf;base64,${buffer.toString('base64')}`;
    const prompt = `Bạn đang số hóa một đề Toán Việt Nam cho MathSpark. Đọc PDF theo đúng thứ tự trang và vị trí trên trang. Mục tiêu là tạo ĐÚNG 20 câu hỏi từ nguồn, giữ thứ tự gốc; không đổi chỗ, không gộp hai câu độc lập, không tách các ý a), b), c) của cùng một câu thành câu mới.
Trả duy nhất JSON object có trường questions là mảng. Nếu PDF có từ 20 câu độc lập trở lên, lấy 20 câu đầu tiên theo thứ tự xuất hiện trong tài liệu. Nếu PDF có dưới 20 câu độc lập, không bịa thêm: trả các câu đọc được và thêm validationError giải thích không đủ 20 câu; hệ thống sẽ không lưu kết quả thiếu.
Mỗi câu có cấu trúc: {"number":1,"sourceQuestionNumber":"số/nhãn gốc trong PDF nếu đọc được","type":"mcq | multi_select | short_answer | essay","prompt":"nội dung câu hỏi nguyên vẹn","options":[{"label":"A","text":"..."},{"label":"B","text":"..."},{"label":"C","text":"..."},{"label":"D","text":"..."}],"correctAnswer":"A/B/C/D cho câu chỉ chọn một đáp án","correctAnswers":["A","C"],"expectedAnswer":"đáp án ngắn tham chiếu cho short_answer","answerKeywords":["từ khóa/chấp nhận tương đương nếu có"],"answerSource":"answer_key/ai_solved/unknown","needsReview":true,"solution":"lời giải hoặc hướng dẫn chấm","rubric":"thang điểm từng ý","points":1,"partialCredit":false,"distractorMap":{"B":"L04"},"skillCode":"KT03","parallelKey":"stable-format-key","sourcePage":1,"origin":"source","hasDiagram":false,"diagramBbox":null,"diagramDescription":""}.
QUY TẮC QUAN TRỌNG:
1) Bảo toàn dữ kiện, số liệu, ký hiệu, đơn vị, dấu câu, hình và ý nhỏ. Mảng questions phải theo đúng thứ tự đọc PDF từ trang đầu đến cuối, trên xuống dưới. number là số thứ tự làm bài 1–20; sourceQuestionNumber giữ nhãn câu gốc nếu đọc được. Không sắp xếp theo độ khó.
2) Chỉ có một đáp án đúng và đề yêu cầu chọn một: type=mcq, correctAnswer là một nhãn. Học sinh chỉ được chọn một. Đề yêu cầu chọn tất cả đáp án đúng/nhiều phương án đúng: type=multi_select, correctAnswers là mảng các nhãn đúng, correctAnswer để rỗng; học sinh được chọn nhiều. Không suy ra multi_select chỉ vì một câu có nhiều mệnh đề nếu đề chỉ yêu cầu chọn một phương án.
3) Câu yêu cầu điền/trả lời ngắn bằng chữ, số, biểu thức hoặc kết quả ngắn nhưng không có lựa chọn: type=short_answer. Học sinh sẽ viết đáp án ra giấy và chụp ảnh để AI chấm; điền expectedAnswer ngắn gọn khi xác minh được, answerKeywords nếu có cách viết tương đương. Không tạo ô nhập văn bản thay cho việc chụp ảnh.
4) Câu yêu cầu trình bày lời giải/chứng minh/lập luận nhiều bước: type=essay; học sinh trình bày trên giấy, chụp một hoặc nhiều ảnh; điền rubric theo từng ý. Cả short_answer và essay đều không có options.
5) Đối với mọi công thức trong prompt/options, dùng LaTeX hợp lệ với \\( ... \\) hoặc \\[ ... \\]; escape dấu gạch chéo ngược đúng trong JSON. Dùng \\begin{cases}...\\\\...\\end{cases} cho hệ phương trình.
6) Không tự bịa đáp án chính thức. Nếu đáp án ở cuối PDF và đọc rõ, answerSource=\"answer_key\"; nếu tự giải, answerSource=\"ai_solved\" và needsReview=true; nếu chưa chắc, để đáp án trống/unknown để admin duyệt. Không tự biên soạn câu thay cho câu có nguồn.
7) Mỗi câu trắc nghiệm có 4 lựa chọn A–D (cho phép E nếu PDF có 5 lựa chọn). Gắn distractorMap L01–L09, skillCode KT01–KT07 và parallelKey chỉ khi có căn cứ. Nếu PDF không đủ 20 câu độc lập, không tự sinh thêm câu; trả validationError.
Đề: ${row.title}. Thời gian: ${row.duration_minutes} phút.`;
    const output = await callOpenAI({
      instructions: 'Bạn là chuyên viên số hóa đề thi Toán. Ưu tiên trung thực với nguồn, chính xác toán học, không bịa chữ/hình. Chỉ trả JSON hợp lệ.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_file', filename: row.source_file_name || 'exam.pdf', file_data: dataUrl, detail: 'high' }] }],
      maxOutputTokens: 14000,
      reasoningEffort: 'high'
    });
    const parsed = parseModelJson(output);
    if (parsed.validationError) return res.status(422).json({ error: `Không thể tạo đề 20 câu từ PDF này: ${safeText(parsed.validationError, 500)}. PDF và bản nháp hiện có được giữ nguyên.` });
    if (!Array.isArray(parsed.questions) || !parsed.questions.length) throw new Error('AI chưa tách được câu hỏi. Thử PDF rõ nét hơn hoặc chia đề dài thành các tệp nhỏ hơn.');
    if (parsed.questions.length < 20) return res.status(422).json({ error: `AI chỉ đọc được ${parsed.questions.length}/20 câu độc lập từ PDF. Không lưu bản thiếu và không tự bịa câu; hãy kiểm tra PDF hoặc tải bản rõ/đầy đủ hơn. Bản nháp hiện có được giữ nguyên.` });
    const sourceQuestions = parsed.questions.slice(0, 20); // keep source order; never sort by model numbering
    const questions = normalizeExamQuestions(sourceQuestions);
    if (questions.length !== 20) return res.status(422).json({ error: 'AI chưa tạo đúng 20 câu sau bước chuẩn hóa. Bản nháp hiện có được giữ nguyên; hãy chạy lại hoặc kiểm tra PDF.' });
    if (questions.some(q => !q.prompt)) throw new Error('Có câu được trích xuất nhưng nội dung bị rỗng. Hãy thử lại hoặc sửa trong phần duyệt đề.');
    const { data, error } = await supabaseAdmin.from('learning_exams').update({ questions, status: 'draft', updated_at: new Date().toISOString() }).eq('id', String(req.params.id)).select('*').single();
    if (error) throw error;
    res.json({ ok: true, exam: examAdminView(data), reviewRequired: questions.filter(q => q.needsReview).length, message: `Đã tạo đúng 20 câu theo thứ tự xuất hiện trong PDF. Câu chọn một đáp án, chọn nhiều đáp án, trả lời ngắn bằng ảnh và tự luận bằng ảnh được phân loại riêng. Hãy kiểm tra từng câu/đáp án/công thức trước khi đăng.` });
  } catch (err) {
    console.error('Exam analysis failed:', { message: String(err?.message || err).slice(0, 500), status: err?.status || 0 });
    if (err?.status) return aiEndpointError(res, err);
    res.status(502).json({ error: `Chưa phân tích được đề: ${err.message || 'lỗi không xác định'}` });
  }
});

// ---------- Admin-managed specialty bank: PDF + a natural-language AI extraction brief ----------
app.get('/api/admin/specialty-exams', requireAdmin, requireSupabase, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('learning_exams').select('*').eq('bank_type','specialty').order('created_at',{ascending:false});
    if (error) throw error;
    res.set('Cache-Control','no-store').json((data || []).map(examAdminView));
  } catch (err) {
    console.error('Admin specialty list failed:', err.message);
    res.status(503).json({ error: 'Không tải được kho chuyên đề. Hãy chạy supabase/specialty-bank.sql trong Supabase SQL Editor.', details: err.message });
  }
});
app.post('/api/admin/specialty-exams', requireAdmin, requireSupabase, upload.single('file'), async (req, res) => {
  let uploadedPath = null;
  try {
    const file = req.file;
    if (!file || !/\.pdf$/i.test(file.originalname) || (file.mimetype && !['application/pdf','application/octet-stream'].includes(file.mimetype))) {
      return res.status(400).json({ error: 'Kho chuyên đề hiện nhận PDF. Hãy xuất tài liệu thành PDF rồi tải lên.' });
    }
    const title = safeText(req.body.title || path.basename(file.originalname, path.extname(file.originalname)), 180);
    const aiRequest = safeText(req.body.aiRequest || '', 3000);
    if (!title) return res.status(400).json({ error: 'Vui lòng nhập tên chuyên đề.' });
    if (!aiRequest) return res.status(400).json({ error: 'Hãy nhập yêu cầu AI về số lượng, dạng câu hỏi và nội dung cần lọc.' });
    const objectPath = `specialty-exams/${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${cleanFileName(file.originalname)}`;
    const { error: uploadError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).upload(objectPath,file.buffer,{contentType:'application/pdf',cacheControl:'3600',upsert:false});
    if (uploadError) throw uploadError;
    uploadedPath = objectPath;
    const now = new Date().toISOString();
    const row = {
      title, description: safeText(req.body.description || '',1500),
      duration_minutes: Math.max(10,Math.min(360,Number(req.body.durationMinutes)||60)),
      status:'draft', bank_type:'specialty', ai_request:aiRequest,
      source_file_name:file.originalname, source_file_path:uploadedPath,
      questions:[], created_at:now, updated_at:now
    };
    const { data, error } = await supabaseAdmin.from('learning_exams').insert(row).select('*').single();
    if (error) throw error;
    res.json({ ok:true, exam:examAdminView(data), message:'Đã tải PDF lên Kho chuyên đề và lưu yêu cầu AI. Tiếp theo hãy chạy AI, duyệt câu hỏi rồi đăng.' });
  } catch (err) {
    if (uploadedPath) await removeSupabaseFile(uploadedPath);
    console.error('Specialty upload failed:', err.message);
    res.status(500).json({ error:`Không lưu được chuyên đề: ${err.message}` });
  }
});
// Specialty PDF analysis is a background job: the browser request returns immediately,
// so a large PDF does not hit the web request/proxy timeout while the model is working.
const specialtyAnalysisJobs = new Map();
const activeSpecialtyAnalysisByExam = new Map();
const SPECIALTY_ANALYSIS_TIMEOUT_MS = 240000;
const SPECIALTY_ANALYSIS_JOB_TTL_MS = 2 * 60 * 60 * 1000;
function pruneSpecialtyAnalysisJobs() {
  const now = Date.now();
  for (const [jobId, job] of specialtyAnalysisJobs) {
    if (job.finishedAt && now - job.finishedAt > SPECIALTY_ANALYSIS_JOB_TTL_MS) {
      specialtyAnalysisJobs.delete(jobId);
      if (activeSpecialtyAnalysisByExam.get(String(job.examId)) === jobId) activeSpecialtyAnalysisByExam.delete(String(job.examId));
    }
  }
}
function publicSpecialtyAnalysisJob(job) {
  return {
    jobId: job.jobId, examId: String(job.examId), status: job.status,
    progress: job.progress, message: job.message,
    error: job.error || '', result: job.result || null,
    startedAt: job.startedAt, finishedAt: job.finishedAt || null
  };
}
function specialtyAnalysisFailureMessage(err) {
  const message = String(err?.message || err || 'lỗi không xác định');
  if (/timed?\s*out|timeout|ETIMEDOUT|ECONNRESET|ECONNABORTED|APIConnectionTimeoutError/i.test(message)) {
    return 'AI mất quá 4 phút để xử lý PDF này nên đã hết thời gian chờ. PDF gốc và bản nháp vẫn được giữ nguyên. Hãy thử lại; nếu vẫn lỗi, xuất PDF nhẹ hơn hoặc chia tài liệu thành các phần nhỏ hơn.';
  }
  if (err?.status) return providerError(err).message;
  return `Chưa xử lý được PDF chuyên đề: ${message.slice(0, 450)}`;
}
async function runSpecialtyAnalysisJob(job, row, aiRequest) {
  try {
    job.status = 'downloading'; job.progress = 8; job.message = 'Đang tải PDF nguồn từ kho lưu trữ…';
    const { data: blob, error: downloadError } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(row.source_file_path);
    if (downloadError) throw downloadError;
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (!buffer.length) throw new Error('PDF rỗng. Hãy tải lại tệp PDF nguồn.');
    job.status = 'processing'; job.progress = 18; job.message = `Đã tải PDF (${(buffer.length / (1024 * 1024)).toFixed(1)} MB). AI đang đọc tài liệu và trích câu hỏi; bước này có thể mất vài phút…`;
    const dataUrl = `data:application/pdf;base64,${buffer.toString('base64')}`;
    const prompt = `Bạn đang xử lý PDF nguồn để tạo bài luyện theo chuyên đề trên MathSpark. Đọc PDF theo đúng thứ tự trang/vị trí và làm theo YÊU CẦU CỤ THỂ CỦA QUẢN TRỊ VIÊN.

YÊU CẦU CỦA QUẢN TRỊ VIÊN:
${aiRequest}

Trả duy nhất JSON object {"questions":[...]} hợp lệ, không Markdown bên ngoài. Mỗi câu có cấu trúc {"number":1,"sourceQuestionNumber":"số/nhãn gốc nếu đọc được","type":"mcq | multi_select | short_answer | essay","prompt":"nội dung câu hỏi nguyên vẹn","options":[{"label":"A","text":"..."},{"label":"B","text":"..."},{"label":"C","text":"..."},{"label":"D","text":"..."}],"correctAnswer":"A/B/C/D cho câu một đáp án","correctAnswers":["A","C"],"expectedAnswer":"đáp án ngắn tham chiếu","answerKeywords":["cách trả lời tương đương"],"answerSource":"answer_key/ai_solved/unknown","needsReview":true,"solution":"lời giải/hướng dẫn chấm","rubric":"thang điểm từng ý","points":1,"partialCredit":false,"distractorMap":{"B":"L04"},"skillCode":"KT03","parallelKey":"stable-format-key","sourcePage":1,"origin":"source hoặc ai_generated","hasDiagram":false,"diagramBbox":null,"diagramDescription":""}.

QUY TẮC:
1. Tuân thủ số lượng câu mà quản trị viên yêu cầu. Ưu tiên chọn/lọc và đánh máy lại câu có trong PDF, giữ nguyên dữ kiện, số liệu, ký hiệu, đơn vị, các ý con và thứ tự xuất hiện. Không sắp xếp lại theo độ khó. Câu lấy từ PDF dùng origin="source" và sourcePage từ 1; câu tự biên soạn mới dùng origin="ai_generated", sourcePage=0.
2. type=mcq khi học sinh chỉ được chọn đúng một phương án; lưu một nhãn vào correctAnswer. type=multi_select khi đề yêu cầu chọn nhiều/tất cả phương án đúng; lưu mảng correctAnswers. Không chỉ dựa vào số lượng mệnh đề để quyết định kiểu câu.
3. type=short_answer cho câu điền/trả lời ngắn bằng chữ, số, biểu thức hoặc kết quả mà học sinh sẽ làm trên giấy rồi chụp ảnh; không tạo options, điền expectedAnswer khi xác minh được và answerKeywords nếu có câu trả lời tương đương. type=essay cho câu cần trình bày lời giải/chứng minh nhiều bước và nộp ảnh một hay nhiều trang. Cả hai loại không có options.
4. Không tự bịa đáp án chính thức. Nếu có đáp án cuối PDF và đọc rõ, answerSource="answer_key"; nếu AI tự giải, answerSource="ai_solved" và needsReview=true; nếu chưa chắc, answerSource="unknown" và cần admin xác minh. Tất cả câu mới cần needsReview=true.
5. Mỗi câu trắc nghiệm có 4 lựa chọn A–D (cho phép E nếu nguồn có 5). Có thể gắn distractorMap L01–L09, skillCode KT01–KT07 và parallelKey khi có bằng chứng; không bịa metadata.
6. Công thức dùng LaTeX hợp lệ: inline \\( ... \\), display \\[ ... \\]; escape dấu gạch chéo ngược đúng trong JSON. Dùng \\begin{cases}...\\\\...\\end{cases} cho hệ phương trình.
7. Không bỏ dữ kiện/ý nhỏ quan trọng. Câu có hình thì đánh dấu hasDiagram=true và ước lượng diagramBbox=[x0,y0,x1,y1] từ 0–1000 nếu đủ chắc chắn; nếu không chắc để null và mô tả. Mọi câu đều có solution/rubric tham khảo khi có thể; không đưa đáp án/lời giải lên giao diện làm bài.
Chuyên đề: ${row.title}. Mô tả: ${row.description || 'Không có'}. Thời gian dự kiến: ${row.duration_minutes} phút.`;
    job.progress = 28; job.message = 'Đã chuẩn bị PDF và yêu cầu. Đang gửi tài liệu cho AI…';
    const output = await callOpenAI({
      instructions: 'Bạn là chuyên viên số hóa và biên soạn học liệu Toán. Tuân thủ chặt yêu cầu của quản trị viên, trung thực với PDF, đánh máy chính xác, không bịa nguồn. Chỉ trả JSON hợp lệ.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_file', filename: row.source_file_name || 'specialty.pdf', file_data: dataUrl, detail: 'high' }] }],
      maxOutputTokens: 14000,
      reasoningEffort: 'medium',
      timeoutMs: SPECIALTY_ANALYSIS_TIMEOUT_MS,
      maxRetries: 0
    });
    job.status = 'validating'; job.progress = 83; job.message = 'AI đã trả nội dung. Đang kiểm tra cấu trúc câu hỏi, đáp án và lưu bản nháp…';
    const parsed = parseModelJson(output);
    if (!Array.isArray(parsed.questions) || !parsed.questions.length) throw new Error('AI chưa tạo được câu hỏi phù hợp. Hãy làm rõ yêu cầu hoặc dùng PDF rõ hơn.');
    const questions = normalizeExamQuestions(parsed.questions);
    if (questions.some(q => !q.prompt)) throw new Error('Có câu bị rỗng sau khi trích xuất. Bản nháp cũ được giữ nguyên. Hãy chạy lại hoặc chỉnh trong phần duyệt.');
    const { data, error } = await supabaseAdmin.from('learning_exams').update({ questions, ai_request: aiRequest, status: 'draft', updated_at: new Date().toISOString() }).eq('id', String(row.id)).eq('bank_type', 'specialty').select('*').single();
    if (error) throw error;
    job.result = { ok: true, exam: examAdminView(data), reviewRequired: questions.filter(q => q.needsReview).length, message: `AI đã xử lý ${questions.length} câu theo yêu cầu. ${questions.filter(q => q.origin === 'ai_generated').length} câu được AI biên soạn bổ sung; hãy kiểm tra nội dung, nguồn, công thức và đáp án trước khi đăng.` };
    job.status = 'completed'; job.progress = 100; job.message = 'Đã xử lý PDF thành công. Đang mở phần duyệt câu hỏi…';
  } catch (err) {
    console.error('Specialty analysis job failed:', { examId: String(row.id), jobId: job.jobId, message: String(err?.message || err).slice(0, 500), status: err?.status || 0 });
    job.status = 'failed'; job.progress = 100; job.error = specialtyAnalysisFailureMessage(err); job.message = 'Không xử lý được PDF.';
  } finally {
    job.finishedAt = Date.now();
    if (activeSpecialtyAnalysisByExam.get(String(row.id)) === job.jobId) activeSpecialtyAnalysisByExam.delete(String(row.id));
  }
}
app.post('/api/admin/specialty-exams/:id/analyze', requireAdmin, requireSupabase, aiRateLimit(3,10*60*1000), ensureOpenAI, async (req,res) => {
  try {
    pruneSpecialtyAnalysisJobs();
    const examId = String(req.params.id);
    const activeJobId = activeSpecialtyAnalysisByExam.get(examId);
    const activeJob = activeJobId ? specialtyAnalysisJobs.get(activeJobId) : null;
    if (activeJob && ['queued','downloading','processing','validating'].includes(activeJob.status)) {
      return res.status(202).set('Cache-Control','no-store').json({ ok:true, ...publicSpecialtyAnalysisJob(activeJob), message:'PDF này đang được xử lý. Đang tiếp tục theo dõi tác vụ hiện tại.' });
    }
    const row = await getExamRow(examId);
    if (!row || row.bank_type !== 'specialty') return res.status(404).json({ error:'Không tìm thấy chuyên đề.' });
    if (!row.source_file_path) return res.status(400).json({ error:'Chuyên đề chưa có PDF gốc.' });
    const aiRequest = safeText(req.body?.aiRequest || row.ai_request || '',3000);
    if (!aiRequest) return res.status(400).json({ error:'Chuyên đề chưa có yêu cầu AI.' });
    const jobId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const job = { jobId, examId, status:'queued', progress:2, message:'Đã nhận yêu cầu. Đang xếp hàng xử lý PDF…', error:'', result:null, startedAt:Date.now(), finishedAt:null };
    specialtyAnalysisJobs.set(jobId, job);
    activeSpecialtyAnalysisByExam.set(examId, jobId);
    res.status(202).set('Cache-Control','no-store').json({ ok:true, ...publicSpecialtyAnalysisJob(job) });
    setImmediate(() => { runSpecialtyAnalysisJob(job, row, aiRequest).catch(err => {
      console.error('Uncaught specialty background job failure:', err);
      job.status='failed'; job.progress=100; job.error=specialtyAnalysisFailureMessage(err); job.message='Không xử lý được PDF.'; job.finishedAt=Date.now();
      if(activeSpecialtyAnalysisByExam.get(examId)===jobId)activeSpecialtyAnalysisByExam.delete(examId);
    }); });
  } catch (err) {
    console.error('Specialty analysis queue failed:', { message:String(err?.message||err).slice(0,500), status:err?.status||0 });
    if (err?.status) return aiEndpointError(res,err);
    res.status(502).json({ error:`Không thể bắt đầu xử lý PDF chuyên đề: ${err.message||'lỗi không xác định'}` });
  }
});
app.get('/api/admin/specialty-exams/:id/analyze/:jobId', requireAdmin, requireSupabase, (req,res) => {
  res.set('Cache-Control','no-store');
  const job = specialtyAnalysisJobs.get(String(req.params.jobId));
  if (!job || String(job.examId) !== String(req.params.id)) {
    return res.json({ status:'interrupted', progress:100, error:'Không tìm thấy trạng thái tác vụ này. Có thể máy chủ vừa khởi động lại. PDF gốc và bản nháp vẫn được giữ; hãy chạy AI lại.' });
  }
  res.json(publicSpecialtyAnalysisJob(job));
});
app.put('/api/admin/specialty-exams/:id', requireAdmin, requireSupabase, async (req,res) => {
  try {
    const existing = await getExamRow(req.params.id);
    if (!existing || existing.bank_type !== 'specialty') return res.status(404).json({error:'Không tìm thấy chuyên đề.'});
    const questions = normalizeExamQuestions(req.body.questions);
    if (questions.some(q=>!q.prompt)) return res.status(400).json({error:'Mỗi câu cần có nội dung.'});
    const changes = { questions, title:safeText(req.body.title||existing.title,180), description:safeText(req.body.description??existing.description??'',1500), duration_minutes:Math.max(10,Math.min(360,Number(req.body.durationMinutes)||Number(existing.duration_minutes)||60)), updated_at:new Date().toISOString(), status:'draft' };
    if (req.body.aiRequest !== undefined) changes.ai_request = safeText(req.body.aiRequest,3000);
    const {data,error}=await supabaseAdmin.from('learning_exams').update(changes).eq('id',String(req.params.id)).select('*').single();
    if(error)throw error;res.json({ok:true,exam:examAdminView(data)});
  } catch(err){res.status(400).json({error:`Không lưu được phần duyệt chuyên đề: ${err.message}`})}
});
app.post('/api/admin/specialty-exams/:id/publish', requireAdmin, requireSupabase, async (req,res) => {
  try {
    const row=await getExamRow(req.params.id);
    if(!row||row.bank_type!=='specialty')return res.status(404).json({error:'Không tìm thấy chuyên đề.'});
    const questions=normalizeExamQuestions(row.questions);
    if(!questions.length)return res.status(400).json({error:'Chuyên đề chưa có câu hỏi. Hãy chạy AI trước.'});
    for(const q of questions){if(!q.prompt)return res.status(400).json({error:`Câu ${q.number} chưa có nội dung.`});if(q.needsReview)return res.status(400).json({error:`Câu ${q.number} còn cần duyệt.`});const choiceError=examQuestionPublishValidationError(q);if(choiceError)return res.status(400).json({error:choiceError});}
    const {data,error}=await supabaseAdmin.from('learning_exams').update({status:'published',questions,updated_at:new Date().toISOString()}).eq('id',String(req.params.id)).select('*').single();
    if(error)throw error;res.json({ok:true,exam:examAdminView(data),message:'Đã đăng chuyên đề lên Kho chuyên đề.'});
  }catch(err){res.status(400).json({error:err.message||'Không đăng được chuyên đề.'})}
});
app.delete('/api/admin/specialty-exams/:id', requireAdmin, requireSupabase, async (req,res) => {
  try {
    const row=await getExamRow(req.params.id);
    if(!row||row.bank_type!=='specialty')return res.status(404).json({error:'Không tìm thấy chuyên đề.'});
    const {error}=await supabaseAdmin.from('learning_exams').delete().eq('id',String(req.params.id));
    if(error)throw error;await removeSupabaseFile(row.source_file_path);res.json({ok:true});
  }catch(err){res.status(500).json({error:`Không xóa được chuyên đề: ${err.message}`})}
});

app.put('/api/admin/exams/:id', requireAdmin, requireSupabase, async (req, res) => {
  try {
    const existing = await getExamRow(req.params.id);
    if (!existing || (existing.bank_type || 'exam') !== 'exam') return res.status(404).json({ error: 'Không tìm thấy đề thi trong Kho đề luyện thi.' });
    const questions = normalizeExamQuestions(req.body.questions);
    if (questions.some(q => !q.prompt)) return res.status(400).json({ error: 'Mỗi câu cần có nội dung câu hỏi.' });
    const changes = {
      questions, title: safeText(req.body.title || existing.title, 180),
      description: safeText(req.body.description ?? existing.description ?? '', 1500),
      duration_minutes: Math.max(10, Math.min(360, Number(req.body.durationMinutes) || Number(existing.duration_minutes) || 120)),
      updated_at: new Date().toISOString(), status: 'draft'
    };
    const { data, error } = await supabaseAdmin.from('learning_exams').update(changes).eq('id', String(req.params.id)).select('*').single();
    if (error) throw error;
    res.json({ ok: true, exam: examAdminView(data) });
  } catch (err) { res.status(400).json({ error: `Không lưu được phần duyệt đề: ${err.message}` }); }
});
app.post('/api/admin/exams/:id/publish', requireAdmin, requireSupabase, async (req, res) => {
  try {
    const row = await getExamRow(req.params.id);
    if (!row || (row.bank_type || 'exam') !== 'exam') return res.status(404).json({ error: 'Không tìm thấy đề thi trong Kho đề luyện thi.' });
    const questions = normalizeExamQuestions(row.questions);
    if (!questions.length) return res.status(400).json({ error: 'Đề chưa có câu hỏi. Hãy chạy phân tích AI trước.' });
    for (const q of questions) {
      if (!q.prompt) return res.status(400).json({ error: `Câu ${q.number} chưa có nội dung.` });
      if (q.needsReview) return res.status(400).json({ error: `Câu ${q.number} còn cần duyệt. Hãy kiểm tra lại đáp án/hình/LaTeX rồi bỏ chọn “Cần duyệt” trước khi đăng.` });
      const choiceError = examQuestionPublishValidationError(q);
      if (choiceError) return res.status(400).json({ error: choiceError });
    }
    const { data, error } = await supabaseAdmin.from('learning_exams').update({ status: 'published', questions, updated_at: new Date().toISOString() }).eq('id', String(req.params.id)).select('*').single();
    if (error) throw error;
    res.json({ ok: true, exam: examAdminView(data), message: 'Đã đăng đề lên kho luyện thi.' });
  } catch (err) { res.status(400).json({ error: err.message || 'Không đăng được đề.' }); }
});
app.delete('/api/admin/exams/:id', requireAdmin, requireSupabase, async (req, res) => {
  try {
    const row = await getExamRow(req.params.id);
    if (!row || (row.bank_type || 'exam') !== 'exam') return res.status(404).json({ error: 'Không tìm thấy đề thi trong Kho đề luyện thi.' });
    const { error } = await supabaseAdmin.from('learning_exams').delete().eq('id', String(req.params.id));
    if (error) throw error;
    await removeSupabaseFile(row.source_file_path);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: `Không xóa được đề thi: ${err.message}` }); }
});
app.get('/api/exams', requireSupabase, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from('learning_exams').select('id,title,description,duration_minutes,status,questions,created_at,bank_type').eq('status','published').eq('bank_type','exam').order('created_at',{ascending:false});
    if (error) throw error;
    res.set('Cache-Control','no-store').json((data || []).map(examStudentView));
  } catch (err) {
    console.error('Published exam list failed:', err.message);
    res.status(503).json({ error: 'Chưa tải được kho đề. Quản trị viên cần chạy supabase/exam-bank.sql trước.', details: err.message });
  }
});
app.get('/api/specialty-exams', requireSupabase, async (req,res) => {
  try {
    const {data,error}=await supabaseAdmin.from('learning_exams').select('id,title,description,duration_minutes,status,questions,created_at,bank_type').eq('status','published').eq('bank_type','specialty').order('created_at',{ascending:false});
    if(error)throw error;
    res.set('Cache-Control','no-store').json((data||[]).map(examStudentView));
  }catch(err){
    console.error('Published specialty list failed:',err.message);
    res.status(503).json({error:'Chưa tải được Kho chuyên đề. Quản trị viên cần chạy supabase/specialty-bank.sql.',details:err.message});
  }
});
app.get('/api/exams/:id', requireSupabase, async (req, res) => {
  try {
    const row = await getExamRow(req.params.id, { publishedOnly: true });
    if (!row) return res.status(404).json({ error: 'Không tìm thấy đề hoặc đề chưa được đăng.' });
    const questions = normalizeExamQuestions(row.questions).map(q => ({
      id:q.id, number:q.number, type:q.type, prompt:q.prompt, options:q.options.map(option=>({label:option.label,text:option.text})),
      points:q.points, sourcePage:q.sourcePage, hasDiagram:q.hasDiagram,
      diagramBbox:q.diagramBbox, diagramDescription:q.diagramDescription
    }));
    res.set('Cache-Control','no-store').json({ ...examStudentView(row), sourceUrl:`/api/exams/${encodeURIComponent(row.id)}/source`, questions });
  } catch (err) { res.status(503).json({ error: `Không tải được đề thi: ${err.message}` }); }
});
// The full source PDF is admin-only so an answer key at the end of the paper is never exposed during a student exam.
app.get('/api/admin/exams/:id/source', requireAdmin, requireSupabase, async (req, res) => {
  try {
    const row = await getExamRow(req.params.id);
    if (!row || !row.source_file_path) return res.status(404).json({ error: 'Không tìm thấy PDF gốc.' });
    const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(row.source_file_path);
    if (error) throw error;
    const buffer = Buffer.from(await data.arrayBuffer());
    res.set({ 'Content-Type':'application/pdf', 'Content-Length':String(buffer.length), 'Content-Disposition':`inline; filename="${cleanFileName(row.source_file_name || 'exam.pdf')}"`, 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff' });
    res.end(buffer);
  } catch (err) { res.status(500).json({ error: `Không tải được PDF gốc: ${err.message}` }); }
});
app.get('/api/exams/:id/diagram/:questionId', requireSupabase, async (req,res) => {
  try {
    const row = await getExamRow(req.params.id, { publishedOnly:true });
    if (!row || !row.source_file_path) return res.status(404).json({ error:'Không tìm thấy hình câu hỏi.' });
    const q = normalizeExamQuestions(row.questions).find(item => String(item.id) === String(req.params.questionId));
    if (!q || !q.sourcePage || !q.diagramBbox) return res.status(404).json({ error:'Câu này chưa có vùng hình được duyệt.' });
    const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(row.source_file_path);
    if (error) throw error;
    const sourceBytes = Buffer.from(await data.arrayBuffer());
    const sourceDoc = await PDFDocument.load(sourceBytes);
    const pageIndex = q.sourcePage - 1;
    if (pageIndex < 0 || pageIndex >= sourceDoc.getPageCount()) return res.status(400).json({ error:'Số trang hình không hợp lệ.' });
    const sourcePage = sourceDoc.getPage(pageIndex);
    const { width, height } = sourcePage.getSize();
    const [x0,y0,x1,y1] = q.diagramBbox.map(Number);
    const left = Math.max(0,Math.min(width,x0/1000*width));
    const bottom = Math.max(0,Math.min(height,(1000-y1)/1000*height));
    const cropWidth = Math.max(1,Math.min(width-left,(x1-x0)/1000*width));
    const cropHeight = Math.max(1,Math.min(height-bottom,(y1-y0)/1000*height));
    if (cropWidth < width*.04 || cropHeight < height*.04) return res.status(400).json({ error:'Vùng hình quá nhỏ; hãy chỉnh diagramBbox trong Admin.' });
    const outDoc = await PDFDocument.create();
    const [page] = await outDoc.copyPages(sourceDoc,[pageIndex]);
    outDoc.addPage(page);
    page.setCropBox(left,bottom,cropWidth,cropHeight);
    const bytes = await outDoc.save();
    res.set({ 'Content-Type':'application/pdf', 'Content-Length':String(bytes.length), 'Content-Disposition':'inline; filename="mathspark-diagram.pdf"', 'Cache-Control':'public, max-age=300', 'X-Content-Type-Options':'nosniff' });
    res.end(Buffer.from(bytes));
  } catch (err) { console.error('Diagram crop failed:',err.message); res.status(500).json({ error:'Không tách được hình từ PDF. Hãy kiểm tra vùng hình trong Admin.' }); }
});
const examEssayUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 7 * 1024 * 1024, files: 20 },
  fileFilter: (req,file,cb) => { const ok = /^image\/(png|jpeg|webp)$/.test(file.mimetype || ''); cb(ok ? null : new Error('Ảnh lời giải tự luận phải là PNG, JPG hoặc WEBP.'), ok); }
}).any();
app.post('/api/exams/:id/submit', requireSupabase, aiRateLimit(5, 10 * 60 * 1000), ensureOpenAI, examEssayUpload, async (req, res) => {
  try {
    const row = await getExamRow(req.params.id, { publishedOnly: true });
    if (!row) return res.status(404).json({ error: 'Không tìm thấy đề hoặc đề chưa được đăng.' });
    const questions = normalizeExamQuestions(row.questions);
    let answers = {};
    try { answers = JSON.parse(String(req.body.answers || '{}')); } catch { return res.status(400).json({ error: 'Dữ liệu đáp án không hợp lệ.' }); }
    let rawIntegrity = {};
    try { rawIntegrity = JSON.parse(String(req.body.integrity || '{}')); } catch {}
    let freeSlots = [];
    try { const parsedSlots = JSON.parse(String(req.body.freeSlots || '[]')); if (Array.isArray(parsedSlots)) freeSlots = parsedSlots.slice(0, 350); } catch {}
    const integrity = {
      visibilityHidden: Math.max(0, Math.min(1000, Number(rawIntegrity.visibilityHidden) || 0)),
      fullscreenExits: Math.max(0, Math.min(1000, Number(rawIntegrity.fullscreenExits) || 0)),
      violations: Math.max(0, Math.min(2000, Number(rawIntegrity.violations) || 0))
    };

    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
    let studentId = null;
    if (bearer && supabaseAdmin) {
      try {
        const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(bearer);
        if (!authError && authData?.user?.id) studentId = authData.user.id;
      } catch (authError) { console.warn('Could not identify student for diagnosis history:', String(authError?.message || authError).slice(0, 180)); }
    }

    const files = Array.isArray(req.files) ? req.files : [];
    const byQuestionFile = new Map();
    for (const q of questions) {
      const exactLegacy = `essay_${q.id}`;
      const orderedPrefix = `essay_${q.id}__`;
      const questionFiles = files.filter(f => {
        const field = String(f.fieldname || '');
        return field === exactLegacy || field.startsWith(orderedPrefix);
      }).sort((a,b) => {
        const getOrder = f => {
          const field = String(f.fieldname || '');
          if (field === exactLegacy) return 1;
          return Number(field.slice(orderedPrefix.length)) || 0;
        };
        return getOrder(a)-getOrder(b);
      });
      if (questionFiles.length) byQuestionFile.set(String(q.id), questionFiles);
    }

    // The diagnostic-event table is private and optional during rollout. If its migration has not
    // been run yet, the current submission is still scored and saved; long-term diagnostics wait.
    const parallelKeys = [...new Set(questions.map(q => q.parallelKey).filter(Boolean))];
    let previousByParallelKey = new Map();
    if (studentId && parallelKeys.length) {
      try {
        const { data, error } = await supabaseAdmin.from('mathspark_diagnostic_events')
          .select('parallel_key,is_correct,skill_code,error_code,created_at')
          .eq('user_id', studentId).in('parallel_key', parallelKeys)
          .order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        previousByParallelKey = MathSparkDiagnosticEngine.normalizePreviousEvents(data || []);
      } catch (historyError) {
        console.warn('Diagnostic history unavailable; current grading continues:', String(historyError?.message || historyError).slice(0, 250));
      }
    }

    const results = [];
    const essayInputs = [];
    const mcqNeedingExplanation = [];
    const choiceAnalysisByQuestion = new Map();
    const essayModelDiagnostics = new Map();
    const attemptedEssayIds = new Set();

    for (const q of questions) {
      if (q.type === 'mcq' || q.type === 'multi_select') {
        const rawPicked = answers[q.id];
        const analysisQuestion = q.answerSource === 'unknown' ? { ...q, correctAnswer: '', correctAnswers: [] } : q;
        const rawAnalysis = MathSparkDiagnosticEngine.analyzeMultiOptionResponse(analysisQuestion, rawPicked);
        // A single-answer MCQ has one correct option, not an omission checklist. Reserve
        // selected-vs-omitted diagnostics for explicit multi-select questions.
        const analysis = q.type === 'mcq'
          ? { ...rawAnalysis, omittedCorrect: [], status: rawAnalysis.selectedOptions.length ? (rawAnalysis.isFullCorrect ? 'FULL_CORRECT' : 'SELECTED_DISTRACTOR') : 'NO_ANSWER' }
          : rawAnalysis;
        const hasKnownAnswer = analysis.knownAnswer && q.answerSource !== 'unknown';
        const isCorrect = hasKnownAnswer ? analysis.isFullCorrect : null;
        const pickedForStudent = q.type === 'multi_select' ? analysis.selectedOptions : (analysis.selectedOptions[0] || '');
        const correctForStudent = q.type === 'multi_select' ? analysis.correctAnswers : (analysis.correctAnswers[0] || q.correctAnswer || '');
        const score = hasKnownAnswer ? analysis.score : 0;
        const resultItem = {
          questionId:q.id, number:q.number, type:q.type,
          answer:pickedForStudent, correctAnswer:correctForStudent, correct:isCorrect,
          score, maxScore:q.points,
          feedback: isCorrect === true ? 'Chính xác.' : MathSparkDiagnosticEngine.studentSafeChoiceFeedback({ ...analysis, knownAnswer:hasKnownAnswer }),
          solution: q.solution || '',
          selectionAnalysis: { status: analysis.status, wrongSelected: analysis.wrongSelected, omittedCorrect: analysis.omittedCorrect },
          diagnosticFeedback: '',
          needsTeacherReview: !hasKnownAnswer || q.needsReview === true,
          ...(analysis.parallelKey ? { parallelFeedback: '' } : {})
        };
        results.push(resultItem);
        choiceAnalysisByQuestion.set(String(q.id), { analysis, attempted: analysis.selectedOptions.length > 0, hasKnownAnswer, isCorrect, resultItem });
        if (hasKnownAnswer && isCorrect !== true) mcqNeedingExplanation.push({ q, analysis, resultItem });
      } else {
        const questionFiles = byQuestionFile.get(String(q.id)) || [];
        if (questionFiles.length) {
          essayInputs.push({ q, files:questionFiles });
          attemptedEssayIds.add(String(q.id));
        } else {
          results.push({ questionId:q.id, number:q.number, type:q.type, score:0, maxScore:q.points, feedback:q.type==='short_answer'?'Chưa nộp ảnh câu trả lời ngắn.':'Chưa nộp ảnh lời giải cho câu này.', needsTeacherReview:false, solution:q.solution || '', mistakes:[], correctedApproach:'' });
        }
      }
    }

    if (mcqNeedingExplanation.length) {
      try {
        const questionPayload = mcqNeedingExplanation.map(({q,analysis}) => ({
          questionId:q.id, number:q.number, type:q.type, prompt:q.prompt,
          options:(q.options||[]).map(option=>({label:option.label,text:option.text})),
          studentSelected:analysis.selectedOptions,
          correctOptions:analysis.correctAnswers,
          selectedWrong:analysis.wrongSelected,
          omittedCorrect:analysis.omittedCorrect,
          diagnosis:analysis.status,
          mappedErrorNames:analysis.errorCodes.map(code => MathSparkDiagnosticEngine.ERROR_NAMES[code]).filter(Boolean),
          skillName:MathSparkDiagnosticEngine.SKILL_NAMES[analysis.skillCode] || ''
        }));
        const rawExplanations = await callOpenAI({
          instructions:'Bạn là giáo viên Toán THCS và trợ lý chẩn đoán sư phạm MathSpark. Chỉ giải thích những câu sai, bỏ trống hoặc chọn thiếu; không viết lời giải cho câu đúng. Phân biệt rõ phương án sai đã chọn với phương án đúng bị bỏ sót. Dùng giọng động viên tự nhiên, không nhắc tới mã lỗi nội bộ L01-L09/KT01-KT07. Không suy đoán động cơ hoặc kết luận lỗ hổng kiến thức chỉ từ một câu. Với câu đầu tiên gặp dạng bài, xem chẩn đoán như giả thuyết cần kiểm tra. Công thức dùng LaTeX hợp lệ. Trả duy nhất JSON hợp lệ theo mẫu {"results":[{"questionId":"...","explanation":"...","praise":"...","spotLight":"...","socraticPrompt":"...","actionGuide":"..."}]} .',
          input:[{role:'user',content:[{type:'input_text',text:'Phân tích từng câu trong dữ liệu sau. Giữ nguyên questionId. Nếu đề hoặc đáp án chưa đủ căn cứ thì nêu rõ, không bịa lời giải.\n'+JSON.stringify(questionPayload)}]}],
          maxOutputTokens:Math.min(12000,1800+mcqNeedingExplanation.length*950), reasoningEffort:'medium'
        });
        const parsedExplanations = parseModelJson(rawExplanations);
        const byQuestion = new Map((Array.isArray(parsedExplanations.results)?parsedExplanations.results:[]).map(item=>[String(item.questionId),item]));
        for (const {q,analysis,resultItem} of mcqNeedingExplanation) {
          const generated = byQuestion.get(String(q.id)) || {};
          const explanation = safeText(generated.explanation || '', 6500);
          const coaching = [generated.praise, generated.spotLight, generated.socraticPrompt, generated.actionGuide].map(value=>safeText(value,1200)).filter(Boolean);
          resultItem.diagnosticFeedback = coaching.join('\n\n');
          if (explanation) resultItem.solution = explanation;
          else resultItem.explanationUnavailable = true;
          if (!resultItem.diagnosticFeedback) resultItem.diagnosticFeedback = MathSparkDiagnosticEngine.studentSafeChoiceFeedback(analysis);
        }
      } catch (explanationError) {
        console.warn('Could not generate diagnostic MCQ explanations; submission continues:',String(explanationError?.message||explanationError).slice(0,300));
        for (const {analysis,resultItem} of mcqNeedingExplanation) {
          resultItem.diagnosticFeedback = MathSparkDiagnosticEngine.studentSafeChoiceFeedback(analysis);
          resultItem.explanationUnavailable = true;
        }
      }
    }

    if (essayInputs.length) {
      const dataUrl = f => `data:${f.mimetype};base64,${f.buffer.toString('base64')}`;
      const content = [{ type:'input_text', text:`Bạn là giáo viên chấm Toán lớp 9 và chuyên gia chẩn đoán sư phạm của MathSpark. Hãy chấm độc lập từng câu tự luận theo đề, tất cả ảnh theo thứ tự trang, rubric và lời giải tham khảo. Thang điểm từ 0 đến maxScore; công nhận các bước đúng dù đáp số cuối sai; không trừ hai lần cho cùng một lỗi.

NGUYÊN TẮC ĐỌC BÀI: Trước khi chấm, đọc đúng những gì học sinh đã viết. Không tự sửa dấu, phép tính hay thêm bước giải. Nếu chữ/ký hiệu không rõ, nêu rõ vùng chưa chắc chắn và hạ confidence. Không dùng đáp án mẫu để sửa nội dung bài làm trong đầu; đối chiếu riêng sau khi đã đọc bài làm.

YÊU CẦU NHẬN XÉT: Nếu có lỗi, chỉ rõ bước/phép biến đổi sai, trích ngắn nội dung đó, giải thích vì sao sai, ảnh hưởng của nó và cách sửa đúng. Phân biệt lỗi đọc dữ kiện, đặt ẩn/điều kiện, mô hình hóa/lập phương trình, biến đổi đại số, tính toán, kiểm tra nghiệm và kết luận. Mảng mistakes có từng lỗi cụ thể. correctedApproach hướng dẫn theo thứ tự. Nếu bài đúng, mistakes để mảng rỗng và không bịa lỗi. Sinh teacherFeedback theo giọng sư phạm tự nhiên gồm praise, spotLight, socraticPrompt, actionGuide; không nhắc mã lỗi cho học sinh. Nếu lời giải dùng phương pháp khác đáp án mẫu nhưng các bước hợp lệ và cho kết quả tương đương, vẫn phải công nhận, không trừ điểm; khi đã kiểm chứng được, đặt solutionMethodAssessment="ACCEPTED_CREATIVE". Chỉ dùng "NEEDS_REVIEW" nếu ảnh hoặc lập luận chưa đủ chắc để kết luận.

CHẨN ĐOÁN NỘI BỘ: Với lỗi có bằng chứng rõ, trả về diagnostics gồm errorCode là một trong L01-L09, skillCode là KT01-KT07 và evidence trích dẫn ngắn; nếu không đủ căn cứ, để diagnostics=[] chứ không đoán. Không đưa mã lỗi vào feedback/teacherFeedback cho học sinh.

Công thức dùng LaTeX hợp lệ với \\( ... \\) hoặc \\[ ... \\]. Trả duy nhất JSON hợp lệ, không markdown bên ngoài, đúng dạng: {"results":[{"questionId":"...","score":0,"maxScore":2,"confidence":"high|medium|low","feedback":"...","mistakes":["..."],"correctedApproach":"...","solutionMethodAssessment":"STANDARD|ACCEPTED_CREATIVE|NEEDS_REVIEW","teacherFeedback":{"praise":"...","spotLight":"...","socraticPrompt":"...","actionGuide":"..."},"diagnostics":[{"errorCode":"L06","skillCode":"KT04","evidence":"..."}]}]}. Mã lỗi chỉ là dữ liệu backend và không được nhắc trong lời nhận xét.` }];
      for (const {q,files:questionFiles} of essayInputs) {
        const shortAnswerMode = q.type === 'short_answer';
        const modeInstructions = shortAnswerMode
          ? 'ĐÂY LÀ CÂU TRẢ LỜI NGẮN: ưu tiên đọc đúng đáp án chữ/số/biểu thức ngắn trên giấy và so với expectedAnswer/answerKeywords. Không bắt buộc trình bày lời giải dài nếu đề không yêu cầu; vẫn công nhận cách ghi tương đương đúng về toán học. Nếu câu hỏi yêu cầu lập luận, chấm phần lập luận theo rubric.'
          : 'ĐÂY LÀ CÂU TỰ LUẬN: chấm quá trình lập luận theo từng bước và rubric; giữ điểm từng phần cho bước đúng.';
        content.push({ type:'input_text', text:`\nCÂU ${q.number} · ${shortAnswerMode ? 'TRẢ LỜI NGẮN BẰNG ẢNH' : 'TỰ LUẬN BẰNG ẢNH'} (questionId=${q.id}; điểm tối đa=${q.points}; có ${questionFiles.length} trang ảnh bài làm; parallelKey=${q.parallelKey || 'chưa gán'}; skillCode=${q.skillCode || 'chưa gán'})\nĐề: ${q.prompt}\n${modeInstructions}\nĐáp án ngắn tham chiếu (nếu có): ${q.expectedAnswer || 'Chưa có đáp án ngắn đã xác minh; tự giải và nói rõ độ chắc chắn.'}\nTừ khóa/cách ghi tương đương có thể chấp nhận: ${(q.answerKeywords || []).join('; ') || 'Đánh giá theo ý nghĩa toán học, không chỉ so khớp chuỗi.'}\nRubric: ${q.rubric || 'Chấm theo yêu cầu câu hỏi, công nhận phần đúng.'}\nLời giải tham khảo: ${q.solution || 'Chưa có lời giải tham khảo; tự giải cẩn thận.'}\nẢnh theo thứ tự Trang 1 đến Trang ${questionFiles.length}; đọc các trang như một bài làm liên tục.` });
        for (let pageIndex=0; pageIndex<questionFiles.length; pageIndex++) {
          const file=questionFiles[pageIndex];
          content.push({ type:'input_text', text:`CÂU ${q.number} — Ảnh trang ${pageIndex+1}/${questionFiles.length}. Đọc tiếp mạch lời giải ở trang trước nếu có; không tự sửa lỗi toán của học sinh.` });
          content.push({ type:'input_image', image_url:dataUrl(file), detail:'high' });
        }
      }
      const raw = await callOpenAI({
        instructions:'Bạn là giáo viên chấm tự luận Toán 9. Chấm theo rubric, phân tích đúng bằng chứng, không cho điểm vượt điểm tối đa. Mã lỗi là dữ liệu nội bộ; không hiển thị mã cho học sinh. Kết quả AI là gợi ý cần kiểm tra khi ảnh mờ hoặc confidence thấp.',
        input:[{ role:'user', content }], maxOutputTokens:Math.min(14000,7000+essayInputs.length*1300), reasoningEffort:'medium'
      });
      let parsed = null;
      let gradingJsonFallback = false;
      try { parsed = parseModelJson(raw); }
      catch (parseErr) {
        gradingJsonFallback = true;
        console.error('Essay grading JSON parse failed; preserving submission and flagging essays for review:', String(parseErr?.message || parseErr).slice(0, 300));
        parsed = { results: [] };
      }
      const modelResults = new Map((Array.isArray(parsed.results) ? parsed.results : []).map(item => [String(item.questionId), item]));
      for (const {q} of essayInputs) {
        const item = modelResults.get(String(q.id));
        const score = item ? Math.max(0, Math.min(q.points, Number(item.score) || 0)) : 0;
        const fallbackFeedback = gradingJsonFallback
          ? 'Bài làm đã được nhận, nhưng AI trả kết quả không đúng định dạng nên câu này đang chờ chấm lại/giáo viên kiểm tra. Bạn không cần tải lại ảnh.'
          : 'AI chưa trả về nhận xét riêng cho câu này.';
        const teacher = item?.teacherFeedback && typeof item.teacherFeedback === 'object' ? item.teacherFeedback : {};
        const teacherFeedback = [teacher.praise, teacher.spotLight, teacher.socraticPrompt, teacher.actionGuide].map(value=>safeText(value,1200)).filter(Boolean).join('\n\n');
        const diagnostics = Array.isArray(item?.diagnostics) ? item.diagnostics.slice(0, 8).map(d => ({
          errorCode:MathSparkDiagnosticEngine.validErrorCode(d?.errorCode),
          skillCode:MathSparkDiagnosticEngine.validSkillCode(d?.skillCode),
          evidence:safeText(d?.evidence,500)
        })).filter(d=>d.errorCode || d.skillCode) : [];
        essayModelDiagnostics.set(String(q.id), diagnostics);
        const solutionMethodAssessment = ['STANDARD','ACCEPTED_CREATIVE','NEEDS_REVIEW'].includes(String(item?.solutionMethodAssessment || '').toUpperCase())
          ? String(item.solutionMethodAssessment).toUpperCase() : 'STANDARD';
        results.push({
          questionId:q.id, number:q.number, type:q.type, score, maxScore:q.points,
          correct: item ? score >= q.points - 0.001 : null,
          confidence:['high','medium','low'].includes(item?.confidence) ? item.confidence : 'low',
          feedback:safeText(item?.feedback || fallbackFeedback, 6000),
          teacherFeedback,
          solutionMethodAssessment,
          mistakes:Array.isArray(item?.mistakes)?item.mistakes.slice(0,12).map(x=>safeText(x,500)):[],
          correctedApproach:safeText(item?.correctedApproach || '',5000),
          needsTeacherReview:!item || item?.confidence === 'low' || solutionMethodAssessment === 'NEEDS_REVIEW', solution:q.solution || ''
        });
      }
    }

    results.sort((a,b)=>a.number-b.number);
    const resultById = new Map(results.map(item=>[String(item.questionId),item]));
    const internalEvents = [];
    const diagnosticEvidence = [];
    for (const q of questions) {
      const resultItem = resultById.get(String(q.id));
      if (!resultItem) continue;
      let attempted = false;
      let isCorrect = resultItem.correct === true;
      let errorCode = '';
      let skillCode = q.skillCode || '';
      let selectedOptions = [];
      let omittedCorrectOptions = [];
      let diagnosticEvidenceText = '';
      if (q.type === 'mcq' || q.type === 'multi_select') {
        const choice = choiceAnalysisByQuestion.get(String(q.id));
        if (!choice || !choice.hasKnownAnswer) continue;
        attempted = true;
        isCorrect = choice.isCorrect === true;
        errorCode = choice.analysis.primaryErrorCode || '';
        skillCode = skillCode || choice.analysis.skillCode || '';
        selectedOptions = choice.analysis.selectedOptions;
        omittedCorrectOptions = choice.analysis.omittedCorrect;
        diagnosticEvidenceText = [selectedOptions.length ? `Đã chọn: ${selectedOptions.join(', ')}` : 'Không chọn phương án', choice.analysis.wrongSelected.length ? `Chọn sai: ${choice.analysis.wrongSelected.join(', ')}` : '', omittedCorrectOptions.length ? `Bỏ sót đáp án đúng: ${omittedCorrectOptions.join(', ')}` : ''].filter(Boolean).join('; ');
      } else {
        if (!attemptedEssayIds.has(String(q.id)) || (resultItem.correct !== true && resultItem.correct !== false)) continue;
        attempted = true;
        const modelDiags = essayModelDiagnostics.get(String(q.id)) || [];
        errorCode = modelDiags.find(d=>d.errorCode)?.errorCode || '';
        skillCode = modelDiags.find(d=>d.skillCode)?.skillCode || skillCode;
        diagnosticEvidenceText = modelDiags.find(d=>d.evidence)?.evidence || '';
      }
      if (!attempted) continue;
      const previous = q.parallelKey ? previousByParallelKey.get(q.parallelKey) : null;
      const parallelStatus = MathSparkDiagnosticEngine.classifyParallelAttempt(previous?.is_correct, isCorrect);
      const currentDiag = { questionId:q.id, parallelKey:q.parallelKey, isCorrect, parallelStatus, errorCode, skillCode };
      diagnosticEvidence.push(currentDiag);
      const parallelFeedback = MathSparkDiagnosticEngine.studentSafeParallelNote(parallelStatus, currentDiag);
      if (parallelFeedback) resultItem.parallelFeedback = parallelFeedback;
      internalEvents.push({
        user_id:studentId, exam_id:Number(row.id)||null, question_id:String(q.id), parallel_key:q.parallelKey || null,
        skill_code:skillCode || null, error_code:errorCode || null, evidence:safeText(diagnosticEvidenceText,1000) || null, is_correct:Boolean(isCorrect),
        selected_options:selectedOptions, omitted_correct_options:omittedCorrectOptions, is_repeat_attempt:Boolean(q.parallelKey && previous),
        diagnosis_status:parallelStatus, created_at:new Date().toISOString()
      });
    }

    const maxScore = results.reduce((sum,item)=>sum+Number(item.maxScore||0),0);
    const score = Math.round(results.reduce((sum,item)=>sum+Number(item.score||0),0)*100)/100;
    const adaptiveSchedule = studentId ? MathSparkDiagnosticEngine.buildAdaptiveSessions({ diagnostics:diagnosticEvidence, freeSlots, now:new Date(), maxSessions:2 }) : null;
    const persistentGapCount = diagnosticEvidence.filter(item=>item.parallelStatus==='PERSISTENT_GAP').length;
    const resolvedSlipCount = diagnosticEvidence.filter(item=>item.parallelStatus==='SLIP_RESOLVED').length;
    const diagnosticSummary = persistentGapCount
      ? `MathSpark nhận thấy ${persistentGapCount} dạng bài em từng làm sai vẫn còn khó ở lần làm tương đương. Hãy xem nhận xét từng câu và lịch ôn tập gợi ý.`
      : resolvedSlipCount
        ? 'Em đã sửa được ít nhất một lỗi từng gặp ở câu tương đương. Hãy tiếp tục duy trì cách kiểm tra lại bài.'
        : '';
    const resultJson = { diagnosticEngineVersion:'7.0-core', examId:String(row.id), examTitle:row.title, score, maxScore, results, integrity, submittedAt:new Date().toISOString(), diagnosticSummary, adaptiveSchedule };
    let saved = false;
    let savedAttemptId = null;
    if (studentId && supabaseAdmin) {
      try {
        const { data: inserted, error: insertError } = await supabaseAdmin.from('exam_attempts').insert({ user_id:studentId, exam_id:row.id, exam_title:row.title, score, max_score:maxScore, result_json:resultJson, submitted_at:new Date().toISOString() }).select('id').single();
        if (!insertError) { saved = true; savedAttemptId = inserted?.id || null; }
        else console.warn('Exam attempt not saved:', insertError.message);
      } catch (saveErr) { console.warn('Exam attempt save failed:', saveErr.message); }
    }
    if (saved && savedAttemptId && internalEvents.length) {
      try {
        const rowsToInsert = internalEvents.filter(item=>item.user_id).map(item=>({ ...item, exam_attempt_id:savedAttemptId }));
        if (rowsToInsert.length) {
          const { error } = await supabaseAdmin.from('mathspark_diagnostic_events').insert(rowsToInsert);
          if (error) throw error;
        }
      } catch (logErr) {
        console.warn('Private diagnostic history not saved. Run supabase/mathspark-diagnostic-engine.sql:', String(logErr?.message || logErr).slice(0, 260));
      }
    }
    res.json({ ok:true, ...resultJson, savedToAccount:saved });
  } catch (err) {
    console.error('Exam submit failed:', { message:String(err?.message||err).slice(0,500), status:err?.status||0 });
    if (err?.status) return aiEndpointError(res, err);
    res.status(502).json({ error: `Chưa chấm/nộp được bài thi: ${err.message || 'lỗi không xác định'}` });
  }
});
app.get('/api/exam-attempts', requireSupabase, async (req,res) => {
  const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return res.status(401).json({ error:'Đăng nhập để xem lịch sử thi.' });
  try {
    const { data:authData, error:authError } = await supabaseAdmin.auth.getUser(bearer);
    if (authError || !authData?.user?.id) return res.status(401).json({ error:'Phiên đăng nhập không hợp lệ.' });
    const { data, error } = await supabaseAdmin.from('exam_attempts').select('id,exam_id,exam_title,score,max_score,submitted_at,result_json').eq('user_id',authData.user.id).order('submitted_at',{ascending:false}).limit(50);
    if (error) throw error;
    res.set('Cache-Control','no-store').json(data || []);
  } catch (err) { res.status(500).json({ error:`Không tải được lịch sử thi: ${err.message}` }); }
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
function repairJsonLatexEscapes(source) {
  // Models sometimes emit LaTeX with single backslashes inside JSON strings (e.g. \( ... \), \frac, \sqrt).
  // A single \( is invalid JSON; some other sequences such as \frac can parse as control characters and corrupt the formula.
  const text = String(source || '');
  const out = [];
  let inString = false;
  const latexCommand = /^(?:frac|dfrac|tfrac|sqrt|text|textbf|textit|texttt|begin|end|left|right|leftarrow|rightarrow|leftrightarrow|le|leq|ge|geq|neq|not|notin|nabla|newcommand|times|theta|therefore|tan|top|cdot|cases|boxed|underbrace|underline|uparrow|usepackage|mathrm|mathit|mathbb|mathbf|boldsymbol|infty|int|sum|prod|pi|alpha|beta|gamma|delta|epsilon|omega|lambda|mu|nu|sigma|phi|psi|angle|approx|equiv|pm|mp|binom|overline|lim|log|ln|sin|cos|cot|sec|csc|operatorname|quad|qquad|bigl|bigr|Bigl|Bigr|lVert|rVert|lbrace|rbrace|ldots|cdots|dots|ell|hspace|vspace)(?![A-Za-z])/i;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (i === 0 || text[i - 1] !== '\\' || (() => { let n = 0; for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) n++; return n % 2 === 0; })())) {
      inString = !inString;
      out.push(ch);
      continue;
    }
    if (!inString || ch !== '\\') { out.push(ch); continue; }
    const next = text[i + 1];
    if (next === undefined) { out.push('\\\\'); continue; }
    const following = text.slice(i + 1);
    const isLatexCommand = latexCommand.test(following);
    const validJsonEscape = '"\\/bfnrtu'.includes(next);
    const validUnicodeEscape = next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6));
    if (isLatexCommand || !validJsonEscape || (next === 'u' && !validUnicodeEscape)) {
      // Double only this backslash so JSON.parse retains the literal LaTeX slash.
      out.push('\\\\');
      continue;
    }
    out.push(ch, next);
    i++;
  }
  return out.join('');
}
function parseModelJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const candidates = [cleaned];
  const first = cleaned.indexOf('{'), last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));
  let lastError = null;
  for (const candidate of candidates) {
    for (const input of [repairJsonLatexEscapes(candidate), candidate]) {
      try { return JSON.parse(input); } catch (err) { lastError = err; }
    }
  }
  const error = new Error('AI trả về dữ liệu chưa đúng định dạng JSON. Hãy thử lại; bài làm sẽ không bị mất nếu phần tự luận chưa thể tự chấm.');
  error.cause = lastError;
  throw error;
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
async function callOpenAI({ instructions, input, maxOutputTokens = 1800, reasoningEffort, timeoutMs, maxRetries }) {
  const params = { model: OPENAI_MODEL, instructions, input, max_output_tokens: maxOutputTokens };
  if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
  const requestOptions = {};
  if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) requestOptions.timeout = Number(timeoutMs);
  if (Number.isInteger(Number(maxRetries)) && Number(maxRetries) >= 0) requestOptions.maxRetries = Number(maxRetries);
  const response = Object.keys(requestOptions).length
    ? await openai.responses.create(params, requestOptions)
    : await openai.responses.create(params);
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
    const prompt = `Bạn là trợ lý chấm bài Toán lớp 9 phục vụ luyện thi vào lớp 10 tại Việt Nam. Chấm công bằng theo quá trình, không chỉ so đáp số.\nQUY TẮC HIỂN THỊ TOÁN BẮT BUỘC: mọi biểu thức toán phải dùng LaTeX hợp lệ; công thức trong câu dùng \\( ... \\), công thức tách dòng dùng \\[ ... \\]. Tuyệt đối không dùng ngoặc vuông [ ... ] đơn thuần để bao công thức và không để lệnh LaTeX thô trong câu văn. Viết số mũ rõ như x^{2}, m^{2}, phân số bằng \\frac{a}{b}, phép nhân bằng \\cdot, căn bằng \\sqrt{...}; đơn vị/văn bản trong công thức dùng \\text{...}. Với bảng chấm nhiều cột, ưu tiên từng bước dạng danh sách có nhãn thay vì bảng quá rộng trên điện thoại.\nChuyên đề người học chọn: ${topic}. Thang điểm tối đa: ${scoreScale}.\nYêu cầu thêm: ${notes || 'Không có'}.\n\nHãy đọc ảnh đề bài và ảnh bài làm. Nếu chữ, ký hiệu hay hình không đọc rõ, nêu rõ phần chưa chắc chắn, không tự bịa nội dung. Phân tích theo các mục Markdown sau:\n## Kết quả\nNêu điểm đề xuất x/${scoreScale} và mức độ chắc chắn. Nếu đề không cung cấp thang điểm từng ý, nói rõ đây là điểm ước lượng và đưa ra cách chia điểm hợp lý.\n## Chấm theo từng bước\nKhông dùng bảng Markdown nhiều cột vì học sinh thường đọc trên điện thoại. Hãy trình bày mỗi bước thành một mục riêng với các nhãn **Bước của học sinh**, **Đánh giá**, **Điểm đề xuất**, **Lý do**. Chỉ trừ điểm ở lỗi có căn cứ; công nhận các bước đúng dù đáp số cuối sai.\n## Lỗi sai cụ thể\nTrích ngắn bước sai, giải thích tại sao sai và hướng sửa. Kiểm tra điều kiện xác định, biến đổi tương đương, dấu, đơn vị, kết luận và lập luận hình học nếu liên quan.\n## Phân tích thói quen tư duy (giả thuyết)\nChỉ nêu giả thuyết có căn cứ từ bài này; không kết luận chắc chắn về một lối mòn từ một bài đơn lẻ. Phân biệt lỗi tính toán nhất thời và dấu hiệu cần kiểm tra thêm.\n## Lời giải tham khảo\nTrình bày lời giải đúng, đủ các bước, phù hợp kiến thức Toán 9.\n## Bài tập kiểm tra lại\nĐưa 1-2 câu ngắn nhắm vào lỗi vừa phát hiện, có thể kèm đáp án ở cuối.\nKhông giả vờ là giáo viên đã xác nhận điểm; nhắc rằng kết quả AI là gợi ý cần đối chiếu với đáp án/thang điểm của giáo viên, đặc biệt khi ảnh không rõ.`;
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
        instructions: 'Bạn là gia sư AI của MathSpark dành cho học sinh lớp 9 ôn thi vào lớp 10 tại Việt Nam. Giải thích theo từng bước, hỏi lại khi đề thiếu dữ kiện, không khẳng định điểm/lỗi nếu thiếu bằng chứng. QUY TẮC TOÁN BẮT BUỘC: công thức trong câu phải bọc bằng \( ... \), công thức tách dòng bằng \[ ... \]; không để lệnh LaTeX thô ngoài dấu phân cách; viết số mũ như x^{2}, m^{2}, phân số bằng \frac{a}{b}, căn bằng \sqrt{...}, phép nhân bằng \cdot. Khi người học hỏi bài, ưu tiên hướng dẫn cách nghĩ và kiểm tra điều kiện, không chỉ đưa đáp án.',
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
      const availableSlots = Array.isArray(body.availableSlots) ? body.availableSlots.slice(0, 12) : [];
      const topics = Array.isArray(body.weakTopics) ? body.weakTopics.slice(0, 30) : [];
      const intensityKey = ['light','balanced','intensive','gifted'].includes(String(body.studyIntensity)) ? String(body.studyIntensity) : 'balanced';
      const intensityProfiles = {
        light: { label:'Nhẹ nhàng', sessions:3, minutes:60, approach:'3 buổi/tuần, khoảng 60 phút/buổi; củng cố nền tảng, số bài vừa phải, nghỉ xen kẽ.' },
        balanced: { label:'Cân bằng', sessions:4, minutes:60, approach:'4 buổi/tuần, khoảng 60 phút/buổi; cân bằng kiến thức, luyện tập, chữa lỗi và ôn lặp lại.' },
        intensive: { label:'Tăng tốc', sessions:5, minutes:90, approach:'5 buổi/tuần, khoảng 90 phút/buổi; tăng bài vận dụng, luyện đề theo phần và dành thời gian phân tích lỗi.' },
        gifted: { label:'Học sinh giỏi', sessions:6, minutes:90, approach:'6 buổi/tuần, khoảng 90 phút/buổi; tăng bài nhiều bước, chứng minh, câu vận dụng cao và so sánh nhiều hướng giải; vẫn cần thời gian nghỉ.' }
      };
      const intensity = intensityProfiles[intensityKey];
      const text = await callOpenAI({
        instructions: `Bạn là chuyên gia thiết kế lịch học Toán 9 dựa trên khoa học học tập. Hãy cá nhân hóa nội dung của từng buổi theo hồ sơ đầu vào. Cường độ đã chọn: ${intensity.label}. ${intensity.approach}
Dùng phương pháp truy hồi chủ động (tự nhớ trước khi xem lời giải), ôn lặp lại cách quãng, xen kẽ các dạng bài và tăng độ khó từng bước. Không xếp thêm buổi, không đổi ngày/giờ/thời lượng và không yêu cầu học trong giờ ngủ; danh sách availableSlots đã được thuật toán kiểm tra theo lịch rảnh. Ưu tiên weakTopics và các lỗi có dữ liệu; nếu thiếu dữ liệu lỗi thì xây nền tảng trước. Dùng điểm hiện tại, mục tiêu điểm, khoảng cách điểm và ngày thi để cân chỉnh độ khó, không hứa chắc điểm thi. Với mức Học sinh giỏi, tăng bài chứng minh, bài nhiều bước và tư duy chiến lược chứ không chỉ tăng số lượng máy móc.
Trả JSON duy nhất dạng {"plan":[{"topic":"...","task":"...","level":"...","questionCount":5}]}. Mỗi phần tử phải tương ứng cùng thứ tự với một block trong availableSlots; trả đúng ${availableSlots.length} phần tử, không tạo giờ mới. Mỗi task cần nêu rõ việc học trong khung giờ cho trước, phù hợp thời lượng. questionCount phải thực tế: buổi 60 phút thường 3–6 câu tự luận ngắn/vừa; buổi 90 phút thường 4–8 câu, ít hơn nếu bài khó. Không thêm Markdown ngoài JSON.`,
        input: JSON.stringify({ targetScore: body.targetScore, examName: safeText(body.examName, 120), examDate: safeText(body.examDate, 30), studyIntensity: intensityKey, intensityLabel: intensity.label, targetWeeklySessions: intensity.sessions, targetMinutesPerSession: intensity.minutes, diagnosticScore: body.diagnosticScore, practiceScore: body.practiceScore, scoreGap: body.scoreGap, daysLeft: body.daysLeft, availableSlots, weakTopics: topics }),
        maxOutputTokens: 3000,
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
        instructions: `Bạn là giáo viên Toán lớp 9 Việt Nam, tạo câu hỏi trắc nghiệm chính xác cho đề tuyển sinh lớp 10. Tạo đúng ${count} câu, chủ đề ${topic}, độ khó ${difficulty}. Mỗi câu có đúng 4 lựa chọn, chỉ một đáp án đúng. Kiểm tra lời giải và đáp án trước khi trả. Trả JSON duy nhất: {"questions":[{"topic":"...","difficulty":"co-ban|van-dung|nang-cao","q":"...","options":["...","...","...","..."],"answer":0,"explain":"..."}]}. answer là chỉ số 0-based của đáp án đúng. Trong q, options và explain, công thức phải dùng LaTeX với dấu phân cách inline \( ... \) hoặc display \[ ... \]; viết số mũ như x^{2}, m^{2}, phân số bằng \frac{a}{b}; đảm bảo dấu gạch chéo ngược được escape đúng trong JSON. Không dùng Markdown ngoài JSON.`,
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
