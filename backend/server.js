const express = require('express');
const initSqlJs = require('sql.js');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const mathEngine = require('./mathEngine');
const aiService = require('./aiService');
const verifyService = require('./verifyService');
const app = express();
const PORT = 8000;

/* ================= 登录认证 ================= */
const ACCOUNT = '13617236478';           // 登录账号
const PASSWORD = '123456';               // 登录密码
const TOKEN_SECRET = 'kaoyan-session-secret-2026';
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天有效期

function signToken(account) {
  const payload = Buffer.from(JSON.stringify({ a: account, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expect = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(expect), b = Buffer.from(sig || '');
  if (a.length !== b.length) return null;
  try {
    if (!crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data.a || null;
  } catch (e) { return null; }
}

function getToken(req) {
  const h = req.headers.cookie || '';
  const token = h.split(';').map(s => s.trim()).find(s => s.startsWith('token='));
  return token ? token.slice(6) : null;
}

// 认证中间件：保护 /api 与 /images（登录与状态检查接口除外）
// 注意：必须注册在 express.json() 之后，登录路由才能解析请求体
const authMiddleware = (req, res, next) => {
  const p = req.path;
  if (p === '/login' || p === '/auth/status' || p === '/api/login') return next();
  if (verifyToken(getToken(req))) return next();
  if (req.path.startsWith('/images')) return res.status(401).send('未授权');
  return res.status(401).json({ error: '未登录或登录已过期', code: 'UNAUTHORIZED' });
};
app.use(cors());
app.use(express.json({ limit: '20mb' }));

app.use(['/api', '/images'], authMiddleware);

app.post('/api/login', (req, res) => {
  const { account, password } = req.body || {};
  if (account === ACCOUNT && password === PASSWORD) {
    const token = signToken(account);
    res.setHeader('Set-Cookie', `token=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}; SameSite=Lax`);
    return res.json({ ok: true, message: '登录成功' });
  }
  res.status(401).json({ error: '账号或密码错误' });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  res.json({ authenticated: !!verifyToken(getToken(req)) });
});

app.use(express.static(path.join(__dirname, '../frontend')));

// 静态图片目录
const imagesDir = path.join(__dirname, '..', 'data', 'images');
app.use('/images', express.static(imagesDir));

// 数据库初始化
let db;
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
const dbPath = path.join(dataDir, 'kaoyan.db');

function saveDb() {
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      chapter TEXT,
      question_type TEXT,
      question TEXT NOT NULL,
      my_answer TEXT,
      correct_answer TEXT NOT NULL,
      error_reason TEXT,
      analysis TEXT,
      related_types TEXT,
      difficulty INTEGER DEFAULT 3,
      status TEXT DEFAULT 'unsolved',
      image_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // 兼容旧库：若缺少 image_url 字段则补齐
  try {
    db.exec('ALTER TABLE questions ADD COLUMN image_url TEXT');
    saveDb();
    console.log('已添加 image_url 字段');
  } catch (e) { /* 字段已存在，忽略 */ }
  // 兼容旧库：缺少 solution（解题过程）字段则补齐
  try {
    db.exec('ALTER TABLE questions ADD COLUMN solution TEXT');
    saveDb();
    console.log('已添加 solution 字段');
  } catch (e) { /* 字段已存在，忽略 */ }
  db.run(`
    CREATE TABLE IF NOT EXISTS practice_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT,
      total_count INTEGER DEFAULT 0,
      correct_count INTEGER DEFAULT 0,
      date TEXT
    );
  `);
  saveDb();
  console.log('数据库初始化完成');
}

// 工具函数
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function dbGet(sql, params = []) {
  const rows = dbAll(sql, params);
  return rows[0] || null;
}

function dbRun(sql, params = []) {
  db.run(sql, params);
  // 注意：必须在 export 之前查询，db.export() 会重置 last_insert_rowid
  const changes = db.getRowsModified();
  const lastInsertRowid = db.exec("SELECT last_insert_rowid() as id")[0]?.values[0][0];
  saveDb();
  return { changes, lastInsertRowid };
}

/* 把字段安全转成字符串：数组/对象则序列化，避免 [object Object] 污染 */
function strField(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// 图片上传接口
app.post('/api/upload', (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: '缺少图片数据' });
    const base64 = image.replace(/^data:image\/\w+;base64,/, '');
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: '图片过大(>10MB)' });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    fs.writeFileSync(path.join(imagesDir, filename), buf);
    res.json({ url: `/images/${filename}`, message: '上传成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// OCR 识别（AI 视觉优先输出 LaTeX + PaddleOCR 线性兜底）
app.post('/api/ocr', (req, res) => {
  const { image, forceEngine } = req.body || {};
  if (!image) return res.status(400).json({ error: '缺少图片数据' });

  const tmpDir = path.join(dataDir, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  let base64Data = '';
  try {
    base64Data = image.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(tmpFile, Buffer.from(base64Data, 'base64'));
  } catch (e) {
    return res.status(400).json({ error: '图片数据无效' });
  }

  // 1) AI 视觉优先（数学公式识别的主力，能输出 LaTeX）
  if (aiService.isEnabled() && !forceEngine) {
    return recognizeViaAi(res, base64Data, tmpFile);
  }

  // 2) PaddleOCR 线性兜底（AI 不可用或显式要求引擎时）
  runPaddleOcr(res, base64Data, tmpFile);
});

// 图像预处理增强：为 AI 视觉生成高对比清晰图；失败则用原图
function enhanceForAi(srcBase64) {
  return new Promise(resolve => {
    const tmpDir = path.join(dataDir, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const inFile = path.join(tmpDir, `in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    const outFile = path.join(tmpDir, `enh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    try {
      const raw = Buffer.from(srcBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      fs.writeFileSync(inFile, raw);
    } catch (e) { resolve(srcBase64); return; }

    const script = path.join(__dirname, 'ocr', 'ocr_service.py');
    let output = '';
    const child = spawn('python', [script, inFile, '--enhance-only', `--out=${outFile}`], { windowsHide: true });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} }, 40000);
    child.stdout.on('data', d => output += d.toString());
    child.on('error', () => { resolve(srcBase64); safeUnlink(inFile); clearTimeout(timer); });
    child.on('close', () => {
      clearTimeout(timer);
      safeUnlink(inFile);
      try {
        const lines = output.split('\n').filter(l => l.trim().startsWith('{'));
        const j = lines.length ? JSON.parse(lines[lines.length - 1]) : null;
        if (j && j.ok && fs.existsSync(outFile)) {
          const b64 = fs.readFileSync(outFile).toString('base64');
          safeUnlink(outFile);
          return resolve(`data:image/png;base64,${b64}`);
        }
      } catch (e) { /* 增强失败：用原图 */ }
      safeUnlink(outFile);
      resolve(srcBase64);
    });
  });
}

// AI 视觉识别（主路径：预处理增强 → 多厂家择优 → 结构校验）
async function recognizeViaAi(res, base64Data, tmpFile) {
  try {
    // 1) 图像预处理增强（照片常模糊/低对比，提升 AI 识别率）
    const aiImg = await enhanceForAi(base64Data);

    // 2) 多厂家择优识别
    const ai = await aiService.recognizeImage(aiImg.replace(/^data:image\/png;base64,/, ''));
    if (ai && ai.question) {
      safeUnlink(tmpFile);
      const score = ai.score || 60;
      return res.json({
        text: ai.question,
        lines: [{ text: ai.question, conf: 1 }],
        quality: { avgConf: 1, chars: ai.question.length, score: Math.min(score, 100) },
        source: 'ai',
        aiProvider: ai.source || '',
        aiModel: ai.model || '',
        subject: ai.subject, type: ai.type, difficulty: ai.difficulty,
        items: ai.items || null,
        isMultiple: !!ai.isMultiple,
        confidence: ai.confidence
      });
    }
  } catch (e) { console.error('[ocr] AI 识别失败:', e.message.slice(0, 150)); }

  // AI 不可用/失败 → PaddleOCR 兜底
  runPaddleOcr(res, base64Data, tmpFile);
}

// PaddleOCR 线性识别（兜底）
function runPaddleOcr(res, base64Data, tmpFile) {
  const script = path.join(__dirname, 'ocr', 'ocr_service.py');
  let output = '';
  let done = false;
  const child = spawn('python', [script, tmpFile], { windowsHide: true });
  const timer = setTimeout(() => {
    if (!done) { try { child.kill(); } catch (e) {} }
  }, 60000); // 60s 超时

  child.stdout.on('data', d => { output += d.toString(); });
  child.stderr.on('data', () => { /* 忽略日志 */ });
  child.on('error', err => {
    if (done) return;
    done = true; clearTimeout(timer);
    safeUnlink(tmpFile);
    res.status(500).json({ error: 'OCR 引擎不可用: ' + err.message });
  });
  child.on('close', () => {
    if (done) return;
    done = true; clearTimeout(timer);
    safeUnlink(tmpFile);
    const lines = output.split('\n').filter(l => l.trim().startsWith('{'));
    const last = lines[lines.length - 1];
    if (!last) return res.status(500).json({ error: 'OCR 引擎无输出' });
    let j;
    try { j = JSON.parse(last); } catch (e) {
      return res.status(500).json({ error: 'OCR 结果解析失败' });
    }
    if (!j.ok) return res.status(500).json({ error: j.error || '识别失败' });
    const quality = j.quality || { score: 0 };
    res.json({ text: j.text, lines: j.lines, quality, source: 'ocr' });
  });
}

function safeUnlink(f) {
  try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ }
}

// 所有错题列表
app.get('/api/questions', (req, res) => {
  try {
    const { subject, status, page = 1, limit = 20 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (subject && subject !== 'all') { where += ' AND subject = ?'; params.push(subject); }
    if (status && status !== 'all') { where += ' AND status = ?'; params.push(status); }
    const rows = dbAll(`SELECT * FROM questions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), (Number(page) - 1) * Number(limit)]).map(r => {
        if (r.analysis && typeof r.analysis !== 'string') {
          const s = strField(r.analysis);
          if (/^\s*\{\s*(?:"?\d+"?\s*:\s*0\s*,?\s*)+\}\s*$/.test(s)) r.analysis = '';
          else r.analysis = s;
        }
        return r;
      });
    const total = dbGet(`SELECT COUNT(*) as count FROM questions ${where}`, params).count;
    res.json({ data: rows, total, page: Number(page), limit: Number(limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 单个错题
app.get('/api/questions/:id', (req, res) => {
  try {
    const row = dbGet('SELECT * FROM questions WHERE id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    // 归一化历史脏数据：analysis 若是对象/数组，转字符串；若形如 {"0":0,"1":0,...} 的假数据则视为未分析
    if (row.analysis && typeof row.analysis !== 'string') {
      const s = strField(row.analysis);
      const isGarbageObj = /^\s*\{\s*(?:"?\d+"?\s*:\s*0\s*,?\s*)+\}\s*$/.test(s);
      row.analysis = isGarbageObj ? '' : s;
    }
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 新增错题
app.post('/api/questions', (req, res) => {
  try {
    const { subject, chapter, question_type, question, my_answer, correct_answer, error_reason, difficulty, image_url, analysis, solution } = req.body;
    if (!subject || !question || !correct_answer) return res.status(400).json({ error: '缺少必填字段' });
    const r = dbRun(`INSERT INTO questions (subject, chapter, question_type, question, my_answer, correct_answer, error_reason, difficulty, image_url, analysis, solution)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [subject, strField(chapter), strField(question_type), question, my_answer || '', correct_answer, strField(error_reason), difficulty || 3, image_url || '', strField(analysis), strField(solution)]);
    res.json({ id: r.lastInsertRowid, message: '添加成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 更新错题
app.put('/api/questions/:id', (req, res) => {
  try {
    const fields = ['subject', 'chapter', 'question_type', 'question', 'my_answer', 'correct_answer', 'error_reason', 'analysis', 'solution', 'related_types', 'difficulty', 'status', 'image_url'];
    const updates = []; const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        // analysis/related_types 若为对象/数组，转成字符串存储，避免 [object Object]
        const val = (f === 'analysis' || f === 'solution' || f === 'related_types' || f === 'question_type' || f === 'chapter' || f === 'error_reason' || f === 'subject') ? strField(req.body[f]) : req.body[f];
        updates.push(`${f} = ?`); params.push(val);
      }
    }
    if (updates.length === 0) return res.json({ message: '无变更' });
    params.push(req.params.id);
    dbRun(`UPDATE questions SET ${updates.join(', ')} WHERE id = ?`, params);
    res.json({ message: '更新成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 删除错题
app.delete('/api/questions/:id', (req, res) => {
  try {
    dbRun('DELETE FROM questions WHERE id = ?', [req.params.id]);
    res.json({ message: '删除成功' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 智能解题（数学引擎优先 + 数值校验，AI 兜底；不可数值判定时双模型交叉验证）
app.post('/api/solve', async (req, res) => {
  try {
    const { question, forceAi, subject } = req.body;
    if (!question) return res.status(400).json({ error: '缺少题目内容' });
    const vs = verifyService;
    // 仅数学题目可做数值/交叉验证；其他科目（英语/政治/专业）只生成过程并标注待人工核对
    // 科目为数学，或科目缺失，或题目含典型数学公式特征（积分/求导/极限/根式等）→ 视为数学走完整验证
    const subjectStr = subject ? String(subject).trim() : '';
    const hasMathFeature = /\\int|\b∫|dx\b|\\frac|\\sqrt|\\lim|\\sum|极限|求导|导数|微分|积分|求解方程|\\frac\{|²|³|\\^|求方程|解方程|x\s*[\^⁰¹²³]|\\sin|\\cos|\\tan|\b求\s*[a-z]|\be\^/.test(question);
    const isMath = !subjectStr || /数学|数一|数二|数三/.test(subjectStr) || hasMathFeature;

    // 非数学科目：不跑数学引擎与数值验证，直接走 AI 生成并明确标注
    if (!isMath) {
      if (!aiService.isEnabled()) return res.json({ canSolve: false, message: '暂无法自动求解，请手动填写答案与过程' });
      const ai = await aiService.solveQuestion(question, { subject });
      if (!ai) return res.json({ canSolve: false, message: '这道题暂无法自动求解，请手动填写答案与过程' });
      return res.json({
        canSolve: true, aiUsed: true, aiProvider: ai.source || '', aiModel: ai.model || '',
        type: ai.type, answer: ai.answer, steps: ai.steps,
        verified: null, verifyDetail: '「' + (subject || '') + '」科目暂不做自动数值验证，请人工核对',
        analysis: ai.analysis, approach: ai.approach, points: ai.points, check: ai.check
      });
    }

    const result = mathEngine.solve(question);

    // ---- 引擎路径（推导可靠，视为已校验）----
    if (result.canSolve && !forceAi) {
      const resp = { canSolve: true, source: 'engine', verified: true, type: result.type, answer: result.answer, steps: result.steps };
      // 定积分：自动代入上下限求精确值并数值复核
      const def = vs.extractDefinite(question);
      if (def) {
        const F = vs.latexToExpr(vs.stripConst(result.answer));
        const fb = vs.tryEval(F, { x: def.b });
        const fa = vs.tryEval(F, { x: def.a });
        if (fb !== null && fa !== null) {
          resp.definite = vs.fmt(fb - fa);
          const exact = vs.numericIntegral(def.f, def.a, def.b);
          const ok = vs.closeEnough(fb - fa, exact);
          resp.verified = ok;
          if (!ok) resp.verifyDetail = `引擎结果与数值积分不一致（${vs.fmt(fb - fa)} vs ${vs.fmt(exact)}），请人工确认`;
        }
      }
      return res.json(resp);
    }

    // ---- AI 兜底路径 ----
    if (aiService.isEnabled()) {
      let ai = await aiService.solveQuestion(question);
      if (!ai) return res.json({ canSolve: false, message: '这道题暂无法自动求解，请手动填写答案与过程' });
      let v = vs.verify(question, ai.answer);

      // ① 数值校验明确失败 → 换厂重解一次（沿用）
      if (v.ok === false) {
        if (result.canSolve) {
          return res.json({
            canSolve: true, source: 'engine', verified: true, type: result.type, answer: result.answer, steps: result.steps,
            note: 'AI 答案未通过数值校验，已改用内置引擎结果'
          });
        }
        const retry = await aiService.solveQuestion(question, { skipProvider: ai.source });
        if (retry) {
          const v2 = vs.verify(question, retry.answer);
          if (v2.ok === true || (v2.ok === null && v.ok === false)) {
            ai = retry; v = v2;
          }
        }
      }

      // ② 数值无法判定（v.ok === null）→ 双模型交叉验证
      let crossChecked = false;
      let crossMismatch = false;
      let verifyDetail = v.detail || '';
      if (v.ok === null) {
        const second = await aiService.solveQuestion(question, { skipProvider: ai.source });
        if (second && second.answer) {
          crossChecked = true;
          if (aiService.answersEquivalent(ai.answer, second.answer)) {
            v.ok = true;
            verifyDetail = '两模型独立结果一致，交叉验证通过';
          } else {
            v.ok = false;
            crossMismatch = true;
            verifyDetail = `两模型结果不一致（${ai.source}:${ai.answer.slice(0, 40)} vs ${second.source}:${second.answer.slice(0, 40)}），请人工核对`;
          }
        } else {
          verifyDetail = '本题无法数值校验，且交叉验证未取得第二家结果，请人工核对';
        }
      }

      // 组装大学生式完整流程返回
      const payload = {
        canSolve: true, aiUsed: true, aiProvider: ai.source || '', aiModel: ai.model || '',
        type: ai.type, answer: ai.answer, steps: ai.steps,
        verified: v.ok, verifyDetail,
        crossChecked, crossMismatch,
        analysis: ai.analysis, approach: ai.approach,
        points: ai.points, check: ai.check
      };
      return res.json(payload);
    }

    res.json({ canSolve: false, message: '这道题暂无法用内置引擎自动求解，请手动填写答案与过程' });
  } catch (e) { res.status(500).json({ error: e.message, stack: undefined }); }
});

// AI 分析(规则模拟)
app.post('/api/questions/:id/analyze', (req, res) => {
  try {
    const q = dbGet('SELECT * FROM questions WHERE id = ?', [req.params.id]);
    if (!q) return res.status(404).json({ error: 'Not found' });

    let analysis = '';
    let relatedTypes = [];
    const reason = (q.error_reason || '').toLowerCase();
    const question = (q.question || '').toLowerCase();

    if (reason.includes('计算') || reason.includes('算错') || reason.includes('粗心')) {
      analysis = '计算错误：建议加强运算练习，每天10道计算题，注意检查步骤。';
      relatedTypes = ['计算强化题', '易错运算题', '速算训练'];
    } else if (reason.includes('概念') || reason.includes('定义') || reason.includes('理解')) {
      analysis = '概念理解偏差：建议回顾教材相关章节，制作概念卡片加强记忆。';
      relatedTypes = ['概念辨析题', '定义判断题', '理论基础题'];
    } else if (reason.includes('公式') || reason.includes('定理')) {
      analysis = '公式/定理应用错误：建议整理公式表，反复推导，理解适用条件。';
      relatedTypes = ['公式推导题', '定理应用题', '综合计算题'];
    } else if (question.includes('证明') || question.includes('推导')) {
      analysis = '证明题薄弱：建议学习标准证明范式，从简单证明入手逐步提升。';
      relatedTypes = ['基础证明题', '反证法练习', '数学归纳法'];
    } else if (reason.includes('审题') || reason.includes('看错')) {
      analysis = '审题不仔细：建议读题时标记关键词，列出已知条件和求解目标。';
      relatedTypes = ['审题训练题', '条件分析题', '信息提取题'];
    } else {
      analysis = '通用建议：建议整理错题本，定期复习，归纳同类型题目解题方法。';
      relatedTypes = ['同类强化题', '综合应用题', '变式训练题'];
    }

    if (q.difficulty <= 2) analysis += ' 题目难度较低，注意基础巩固。';
    else if (q.difficulty >= 4) analysis += ' 题目难度较高，建议先掌握基础再挑战。';

    dbRun('UPDATE questions SET analysis = ?, related_types = ? WHERE id = ?', [analysis, relatedTypes.join('|'), req.params.id]);
    res.json({ analysis, related_types: relatedTypes, message: '分析完成' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 统计
app.get('/api/stats', (req, res) => {
  try {
    const total = dbGet('SELECT COUNT(*) as count FROM questions').count;
    const unsolved = dbGet("SELECT COUNT(*) as count FROM questions WHERE status = 'unsolved'").count;
    const solved = dbGet("SELECT COUNT(*) as count FROM questions WHERE status = 'solved'").count;
    const bySubject = dbAll('SELECT subject, COUNT(*) as count FROM questions GROUP BY subject ORDER BY count DESC');
    const byType = dbAll("SELECT question_type, COUNT(*) as count FROM questions WHERE question_type != '' GROUP BY question_type");
    const byDifficulty = dbAll('SELECT difficulty, COUNT(*) as count FROM questions GROUP BY difficulty ORDER BY difficulty');
    const recent = dbAll("SELECT date(created_at) as date, COUNT(*) as count FROM questions GROUP BY date(created_at) ORDER BY date DESC LIMIT 7");
    res.json({ total, unsolved, solved, bySubject, byType, byDifficulty, recent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 启动
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`考研错题工具服务已启动: http://0.0.0.0:${PORT}`);
  });
});