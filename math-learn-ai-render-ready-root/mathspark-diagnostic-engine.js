'use strict';

const ERROR_CODES = new Set(['L01','L02','L03','L04','L05','L06','L07','L08','L09']);
const SKILL_CODES = new Set(['KT01','KT02','KT03','KT04','KT05','KT06','KT07']);
const DIAGNOSIS_STATUS = new Set(['FIRST_ATTEMPT','SLIP_RESOLVED','PERSISTENT_GAP','STABLE']);

const SKILL_NAMES = Object.freeze({
  KT01: 'Đọc hiểu và bóc tách dữ kiện',
  KT02: 'Đặt ẩn và xác định điều kiện',
  KT03: 'Mô hình hóa và lập phương trình',
  KT04: 'Biến đổi đại số và tương đương',
  KT05: 'Tính toán và thao tác số học',
  KT06: 'Kiểm tra nghiệm và điều kiện',
  KT07: 'Kết luận, đơn vị và trình bày'
});

const ERROR_NAMES = Object.freeze({
  L01: 'đọc hoặc bóc tách dữ kiện',
  L02: 'đặt ẩn và nêu ý nghĩa đại lượng',
  L03: 'điều kiện xác định hoặc điều kiện nghiệm',
  L04: 'biểu diễn đại lượng bằng công thức',
  L05: 'lập phương trình từ dữ kiện',
  L06: 'biến đổi đại số hoặc quy tắc dấu',
  L07: 'tính toán hoặc quy đồng',
  L08: 'đối chiếu nghiệm với điều kiện',
  L09: 'kết luận, đơn vị hoặc đại lượng cần tìm'
});

function cleanLabel(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (/^[A-E]$/.test(text)) return text;
  const match = text.match(/^([A-E])[).]$/);
  return match ? match[1] : '';
}

function normalizeLabels(value) {
  const values = Array.isArray(value)
    ? value
    : (value == null || value === '' ? [] : String(value).split(/[;,\s]+/));
  return [...new Set(values.map(cleanLabel).filter(Boolean))].sort();
}

function validErrorCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return ERROR_CODES.has(code) ? code : '';
}

function validSkillCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return SKILL_CODES.has(code) ? code : '';
}

function normalizeDistractorMap(question) {
  const map = {};
  const rawMap = question?.distractorMap && typeof question.distractorMap === 'object'
    ? question.distractorMap : {};
  for (const [key, value] of Object.entries(rawMap)) {
    const label = cleanLabel(key);
    const code = validErrorCode(typeof value === 'object' ? value.errorCode || value.code : value);
    if (label && code) map[label] = code;
  }
  for (const option of Array.isArray(question?.options) ? question.options : []) {
    const label = cleanLabel(option?.label);
    const code = validErrorCode(option?.errorCode || option?.error_code || option?.diagnosticCode);
    if (label && code && !map[label]) map[label] = code;
  }
  return map;
}

function questionCorrectLabels(question) {
  const raw = question?.correctAnswers?.length
    ? question.correctAnswers
    : (Array.isArray(question?.correctAnswer) ? question.correctAnswer : question?.correctAnswer);
  return normalizeLabels(raw);
}

function analyzeMultiOptionResponse(question, answer) {
  const selectedOptions = normalizeLabels(answer);
  const correctAnswers = questionCorrectLabels(question);
  const correctSet = new Set(correctAnswers);
  const selectedSet = new Set(selectedOptions);
  const wrongSelected = selectedOptions.filter(label => !correctSet.has(label));
  const omittedCorrect = correctAnswers.filter(label => !selectedSet.has(label));
  const knownAnswer = correctAnswers.length > 0;
  const isFullCorrect = knownAnswer && wrongSelected.length === 0 && omittedCorrect.length === 0;
  let status = 'FULL_CORRECT';
  if (!knownAnswer) status = 'ANSWER_KEY_UNVERIFIED';
  else if (wrongSelected.length && omittedCorrect.length) status = 'WRONG_SELECTED_AND_OMITTED';
  else if (wrongSelected.length) status = 'SELECTED_DISTRACTOR';
  else if (omittedCorrect.length) status = selectedOptions.length ? 'OMITTED_CORRECT' : 'NO_ANSWER';
  const distractorMap = normalizeDistractorMap(question);
  const errorCodes = [...new Set(wrongSelected.map(label => distractorMap[label]).filter(Boolean))];
  const validOptions = (Array.isArray(question?.options) ? question.options : [])
    .map(option => cleanLabel(option?.label)).filter(Boolean);
  let score = isFullCorrect ? Number(question?.points || 0) : 0;
  // Partial credit is opt-in and never awards points for an unmarked correct option or a marked distractor.
  if (knownAnswer && question?.partialCredit === true && wrongSelected.length === 0 && correctAnswers.length) {
    score = Number(question?.points || 0) * (selectedOptions.filter(label => correctSet.has(label)).length / correctAnswers.length);
  }
  return {
    selectedOptions,
    correctAnswers,
    wrongSelected,
    omittedCorrect,
    errorCodes,
    primaryErrorCode: errorCodes[0] || '',
    skillCode: validSkillCode(question?.skillCode || question?.skill_code),
    parallelKey: String(question?.parallelKey || question?.parallel_key || '').trim().slice(0, 120),
    knownAnswer,
    isFullCorrect,
    status,
    score: Math.round(score * 100) / 100,
    validOptionLabels: validOptions
  };
}

function classifyParallelAttempt(previousIsCorrect, currentIsCorrect) {
  if (typeof previousIsCorrect !== 'boolean') return 'FIRST_ATTEMPT';
  if (previousIsCorrect === false && currentIsCorrect === true) return 'SLIP_RESOLVED';
  if (previousIsCorrect === false && currentIsCorrect === false) return 'PERSISTENT_GAP';
  return 'STABLE';
}

function studentSafeParallelNote(status, analysis) {
  if (status === 'SLIP_RESOLVED') {
    return 'Rất tốt! Ở lần trước em còn vướng dạng bài này, nhưng lần làm mới đã đúng. Đây có thể là sơ suất nhất thời và em đã biết cách tự sửa.';
  }
  if (status === 'PERSISTENT_GAP') {
    const skillName = SKILL_NAMES[analysis?.skillCode];
    return `Dạng bài tương tự này vẫn còn là một điểm cần củng cố${skillName ? `, đặc biệt ở phần ${skillName.toLocaleLowerCase('vi')}` : ''}. Em nên ôn lại quy tắc nền tảng rồi thử một câu tương đương khác số liệu.`;
  }
  return '';
}

function studentSafeChoiceFeedback(analysis) {
  if (!analysis?.knownAnswer) return 'Đáp án chính thức của câu này chưa được xác minh; kết quả cần được giáo viên kiểm tra.';
  const wrong = analysis.wrongSelected || [];
  const omitted = analysis.omittedCorrect || [];
  if (analysis.status === 'NO_ANSWER' || (!(analysis.selectedOptions || []).length && !wrong.length)) return 'Em chưa chọn đáp án. Hãy đọc lại yêu cầu và thử phân tích từng phương án.';
  if (!wrong.length && !omitted.length) return 'Em đã chọn đủ các phương án đúng.';
  if (wrong.length && omitted.length) return `Em đã chọn nhầm phương án ${wrong.join(', ')} và bỏ sót phương án đúng ${omitted.join(', ')}. Hãy đối chiếu từng lựa chọn với điều kiện của đề.`;
  if (wrong.length) return `Phương án ${wrong.join(', ')} chưa đúng. Em hãy kiểm tra lại dữ kiện và lập luận dẫn đến lựa chọn đó.`;
  if (omitted.length) return `Em đã bỏ sót phương án đúng ${omitted.join(', ')}. Hãy rà soát tất cả phương án thay vì dừng lại khi đã tìm được một kết quả hợp lý.`;
  return 'Em chưa chọn đáp án. Hãy đọc lại yêu cầu và thử phân tích từng phương án.';
}

function normalizePreviousEvents(rows) {
  const latest = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.parallel_key || '').trim();
    if (!key || latest.has(key) || typeof row?.is_correct !== 'boolean') continue;
    latest.set(key, row);
  }
  return latest;
}

function mapSkillToTopic(skillCode, errorCode) {
  const byError = {
    L01: 'Đọc kỹ đề và tóm tắt dữ kiện', L02: 'Đặt ẩn và nêu điều kiện', L03: 'Điều kiện xác định và nghiệm',
    L04: 'Biểu diễn đại lượng bằng công thức', L05: 'Lập phương trình từ dữ kiện', L06: 'Biến đổi đại số và quy tắc dấu',
    L07: 'Kỹ năng tính toán và quy đồng', L08: 'Thử lại nghiệm với điều kiện', L09: 'Kết luận và đơn vị'
  };
  return byError[validErrorCode(errorCode)] || SKILL_NAMES[validSkillCode(skillCode)] || 'Củng cố dạng bài đang mắc lỗi';
}

function buildAdaptiveSessions({diagnostics, freeSlots, now = new Date(), maxSessions = 2}) {
  const persistent = (Array.isArray(diagnostics) ? diagnostics : []).filter(item => item?.parallelStatus === 'PERSISTENT_GAP');
  if (!persistent.length) return null;
  const rawSlots = Array.isArray(freeSlots) ? freeSlots : [];
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const used = new Set();
  const slots = rawSlots.map(slot => {
    const date = String(slot?.date || '').slice(0, 10);
    const start = String(slot?.start || slot?.time || '').match(/\b([01]\d|2[0-3]):[0-5]\d\b/)?.[0] || '';
    const end = String(slot?.end || '').match(/\b([01]\d|2[0-3]):[0-5]\d\b/)?.[0] || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !start) return null;
    const startAt = Date.parse(`${date}T${start}:00+07:00`);
    if (!Number.isFinite(startAt) || startAt <= nowMs || used.has(`${date}_${start}`)) return null;
    used.add(`${date}_${start}`);
    return { date, start, end: end || addMinutes(start, Number(slot?.duration) || 30), startAt, day: String(slot?.day || ''), slotKey: String(slot?.key || '') };
  }).filter(Boolean).sort((a, b) => a.startAt - b.startAt);
  const sessions = [];
  const distinctDays = new Set();
  for (const slot of slots) {
    if (sessions.length >= Math.max(1, Math.min(2, Number(maxSessions) || 2))) break;
    if (distinctDays.has(slot.date)) continue;
    const diagnosis = persistent[Math.min(sessions.length, persistent.length - 1)];
    const topic = mapSkillToTopic(diagnosis.skillCode, diagnosis.errorCode);
    sessions.push({
      sessionNo: sessions.length + 1,
      date: slot.date,
      day: slot.day,
      start: slot.start,
      end: slot.end,
      durationMinutes: 30,
      topic,
      title: sessions.length === 0 ? `Buổi 1: Ôn nền tảng — ${topic}` : `Buổi 2: Luyện câu tương đương — ${topic}`,
      task: sessions.length === 0
        ? 'Nhắc lại quy tắc, xem một ví dụ mẫu và tự giải thích vì sao từng bước đúng.'
        : 'Làm một câu tương đương với số liệu mới, kiểm tra điều kiện và tự đối chiếu lời giải.',
      parallelKey: diagnosis.parallelKey
    });
    distinctDays.add(slot.date);
  }
  return {
    planTitle: 'Lộ trình củng cố lỗi lặp lại',
    mappedToStudentFreeSlots: sessions.length > 0,
    totalSessions: sessions.length,
    requiresMoreAvailability: sessions.length < 2,
    message: sessions.length === 2
      ? 'Đã xếp hai buổi ôn vào các khung giờ rảnh khác ngày.'
      : sessions.length === 1
        ? 'Chỉ tìm thấy một khung giờ rảnh phù hợp trong tuần hiện tại; hãy bổ sung giờ rảnh để xếp buổi thứ hai.'
        : 'Đã phát hiện lỗi lặp lại nhưng chưa tìm thấy khung giờ rảnh sắp tới. Hãy đánh dấu thêm giờ rảnh trong Lịch trình.',
    sessions
  };
}

module.exports = {
  ERROR_CODES, SKILL_CODES, SKILL_NAMES, ERROR_NAMES,
  normalizeLabels, validErrorCode, validSkillCode, normalizeDistractorMap,
  analyzeMultiOptionResponse, classifyParallelAttempt, studentSafeParallelNote,
  studentSafeChoiceFeedback, normalizePreviousEvents, mapSkillToTopic,
  buildAdaptiveSessions
};

function addMinutes(time, minutes) {
  const match = String(time || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return time;
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
