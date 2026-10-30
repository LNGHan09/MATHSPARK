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

function aggregateDiagnosticErrors(diagnostics) {
  const input = Array.isArray(diagnostics) ? diagnostics : [];
  const wrong = input.filter(item => item && item.isCorrect === false);
  const errorToSkill = {
    L01: 'KT01', L02: 'KT02', L03: 'KT02', L04: 'KT03', L05: 'KT03',
    L06: 'KT04', L07: 'KT05', L08: 'KT06', L09: 'KT07'
  };
  const codeStats = new Map();
  const skillStats = new Map();
  let omissionQuestionCount = 0;
  let uncodedWrongQuestionCount = 0;

  const uniqueCodes = value => [...new Set((Array.isArray(value) ? value : value ? [value] : [])
    .map(validErrorCode).filter(Boolean))];
  const uniqueSkills = value => [...new Set((Array.isArray(value) ? value : value ? [value] : [])
    .map(validSkillCode).filter(Boolean))];

  for (const item of wrong) {
    const questionNumber = Number(item.questionNumber ?? item.number);
    const questionLabel = Number.isFinite(questionNumber) && questionNumber > 0 ? questionNumber : null;
    const codes = uniqueCodes([...(item.errorCodes || []), item.errorCode]);
    const explicitSkills = uniqueSkills([...(item.skillCodes || []), item.skillCode]);
    // Prefer the taxonomy's canonical mapping when a specific error code is available.
    const skills = codes.length
      ? [...new Set(codes.map(code => errorToSkill[code]).filter(Boolean))]
      : explicitSkills;
    const omitted = Array.isArray(item.omittedCorrectOptions) ? item.omittedCorrectOptions.length > 0
      : (Array.isArray(item.omittedCorrect) ? item.omittedCorrect.length > 0 : item.diagnosisKind === 'OMISSION');
    if (omitted) omissionQuestionCount += 1;

    if (!codes.length && !skills.length) uncodedWrongQuestionCount += 1;

    for (const code of codes) {
      const skill = errorToSkill[code] || explicitSkills[0] || '';
      if (!codeStats.has(code)) codeStats.set(code, { code, label: ERROR_NAMES[code] || 'lỗi cần kiểm tra', count: 0, questionNumbers: [], skillCodes: [] });
      const stat = codeStats.get(code);
      stat.count += 1;
      if (questionLabel && !stat.questionNumbers.includes(questionLabel)) stat.questionNumbers.push(questionLabel);
      if (skill && !stat.skillCodes.includes(skill)) stat.skillCodes.push(skill);
    }
    for (const skill of skills) {
      if (!skillStats.has(skill)) skillStats.set(skill, { skillCode: skill, name: SKILL_NAMES[skill] || skill, count: 0, errorCodes: [], questionNumbers: [], hasPersistentGap: false });
      const stat = skillStats.get(skill);
      stat.count += 1;
      if (questionLabel && !stat.questionNumbers.includes(questionLabel)) stat.questionNumbers.push(questionLabel);
      for (const code of codes) if (!stat.errorCodes.includes(code)) stat.errorCodes.push(code);
      if (item.parallelStatus === 'PERSISTENT_GAP') stat.hasPersistentGap = true;
    }
  }

  const errorCodes = [...codeStats.values()]
    .map(item => ({ ...item, questionNumbers: item.questionNumbers.sort((a,b)=>a-b), skillNames: item.skillCodes.map(code=>SKILL_NAMES[code]).filter(Boolean), confidence: item.count >= 2 ? 'repeated' : 'initial' }))
    .sort((a,b)=>b.count-a.count || a.code.localeCompare(b.code));
  const weakAreas = [...skillStats.values()]
    .map(item => ({ ...item, questionNumbers: item.questionNumbers.sort((a,b)=>a-b), errorCodes: item.errorCodes.sort(), confidence: item.hasPersistentGap || item.count >= 2 ? 'repeated' : 'initial' }))
    .sort((a,b)=>b.count-a.count || a.skillCode.localeCompare(b.skillCode));

  const persistentGapCount = wrong.filter(item => item.parallelStatus === 'PERSISTENT_GAP').length;
  const resolvedSlipCount = wrong.filter(item => item.parallelStatus === 'SLIP_RESOLVED').length;
  return {
    totalQuestions: input.length,
    totalWrongQuestions: wrong.length,
    omissionQuestionCount,
    uncodedWrongQuestionCount,
    persistentGapCount,
    resolvedSlipCount,
    errorCodes,
    weakAreas,
    topWeakArea: weakAreas[0] || null,
    interpretation: persistentGapCount
      ? 'confirmed_repeat'
      : (wrong.length ? 'initial_signal' : 'no_error_signal'),
    confidenceNote: persistentGapCount
      ? 'Có ít nhất một dạng bài tương đương bị sai lặp lại; đây là bằng chứng mạnh hơn cho nhu cầu củng cố.'
      : (wrong.length ? 'Đây là tín hiệu từ bài vừa làm, chưa đủ để kết luận học sinh bị hổng kiến thức gốc. Cần đối chiếu thêm câu tương đương ở lần sau.' : 'Không phát hiện tín hiệu lỗi cần ôn từ các câu đã chấm được.')
  };
}

function buildAdaptiveSessions({diagnostics, freeSlots, now = new Date(), maxSessions = 2}) {
  const all = Array.isArray(diagnostics) ? diagnostics : [];
  const wrong = all.filter(item => item && item.isCorrect === false);
  if (!wrong.length) return null;

  const persistent = wrong.filter(item => item.parallelStatus === 'PERSISTENT_GAP');
  const summary = aggregateDiagnosticErrors(wrong);
  const hasCodedArea = summary.weakAreas.length > 0;
  const focusAreas = persistent.length
    ? aggregateDiagnosticErrors(persistent).weakAreas
    : summary.weakAreas;
  const pickedAreas = focusAreas.length ? focusAreas.slice(0, 2) : [{
    skillCode: '', name: 'Rà soát các câu chưa chính xác', count: wrong.length,
    errorCodes: [], questionNumbers: wrong.map(item=>Number(item.questionNumber ?? item.number)).filter(n=>Number.isFinite(n)&&n>0), confidence: 'initial'
  }];

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

  // A first test creates one short, low-confidence review session. A confirmed repeated error
  // may create up to two sessions, as described in the Master Engine specification.
  const requestedSessions = persistent.length ? Math.max(1, Math.min(2, Number(maxSessions) || 2)) : 1;
  const sessions = [];
  const distinctDays = new Set();
  for (const slot of slots) {
    if (sessions.length >= requestedSessions) break;
    if (distinctDays.has(slot.date)) continue;
    const area = pickedAreas[Math.min(sessions.length, pickedAreas.length - 1)];
    const topic = area?.errorCodes?.length
      ? mapSkillToTopic(area.skillCode, area.errorCodes[0])
      : (area?.name || 'Rà soát các câu chưa chính xác');
    const areaQuestions = Array.isArray(area?.questionNumbers) ? area.questionNumbers : [];
    const isPersistentPlan = persistent.length > 0;
    sessions.push({
      sessionNo: sessions.length + 1,
      date: slot.date,
      day: slot.day,
      start: slot.start,
      end: slot.end,
      durationMinutes: 30,
      topic,
      title: isPersistentPlan
        ? (sessions.length === 0 ? `Buổi 1: Ôn nền tảng — ${topic}` : `Buổi 2: Luyện câu tương đương — ${topic}`)
        : `Ôn tập gợi ý — ${topic}`,
      task: isPersistentPlan
        ? (sessions.length === 0
          ? 'Nhắc lại quy tắc, xem một ví dụ mẫu và tự giải thích vì sao từng bước đúng.'
          : 'Làm một câu tương đương với số liệu mới, kiểm tra điều kiện và tự đối chiếu lời giải.')
        : `Xem lại câu ${areaQuestions.length ? areaQuestions.join(', ') : 'chưa chính xác'}; ghi lại bước làm đúng, sau đó thử một câu tương đương để kiểm tra lại.` ,
      errorCodes: Array.isArray(area?.errorCodes) ? area.errorCodes : [],
      skillCode: area?.skillCode || '',
      questionNumbers: areaQuestions,
      parallelKey: persistent[Math.min(sessions.length, persistent.length - 1)]?.parallelKey || '',
      diagnosisConfidence: isPersistentPlan ? 'higher_after_repeat' : 'initial_signal'
    });
    distinctDays.add(slot.date);
  }
  const isPersistentPlan = persistent.length > 0;
  return {
    planTitle: isPersistentPlan ? 'Lộ trình củng cố lỗi lặp lại' : 'Buổi ôn tập gợi ý từ bài vừa làm',
    mappedToStudentFreeSlots: sessions.length > 0,
    totalSessions: sessions.length,
    requiresMoreAvailability: sessions.length < requestedSessions,
    diagnosisConfidence: isPersistentPlan ? 'higher_after_repeat' : 'initial_signal',
    message: !slots.length
      ? 'Đã xác định nội dung nên ôn nhưng chưa có khung giờ rảnh sắp tới. Hãy đánh dấu giờ rảnh trong Lịch trình để thêm buổi ôn.'
      : (isPersistentPlan
        ? (sessions.length === 2 ? 'Đã xếp hai buổi ôn vào các khung giờ rảnh khác ngày vì lỗi dạng tương đương lặp lại.' : 'Đã phát hiện lỗi lặp lại; hiện chỉ tìm thấy một khung giờ phù hợp. Hãy bổ sung giờ rảnh để xếp buổi thứ hai.')
        : 'Đã thêm một buổi ôn ngắn vào Lịch trình dựa trên lỗi trong bài vừa làm. Đây là gợi ý ban đầu; bài tương đương sẽ giúp kiểm tra xem lỗi có lặp lại không.'),
    sessions
  };
}

module.exports = {
  ERROR_CODES, SKILL_CODES, SKILL_NAMES, ERROR_NAMES,
  normalizeLabels, validErrorCode, validSkillCode, normalizeDistractorMap,
  analyzeMultiOptionResponse, classifyParallelAttempt, studentSafeParallelNote,
  studentSafeChoiceFeedback, normalizePreviousEvents, mapSkillToTopic,
  aggregateDiagnosticErrors, buildAdaptiveSessions
};

function addMinutes(time, minutes) {
  const match = String(time || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return time;
  const total = (Number(match[1]) * 60 + Number(match[2]) + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
