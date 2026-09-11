const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const db = new Database('/home/admin/kaoyan-tool/data/kaoyan.db');

db.exec(`
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS practice_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT,
    total_count INTEGER DEFAULT 0,
    correct_count INTEGER DEFAULT 0,
    date TEXT
  );
`);

// 获取所有错题
app.get('/api/questions', (req, res) => {
  const { subject, status, page = 1, limit = 20 } = req.query;
  let sql = 'SELECT * FROM questions WHERE 1=1';
  const params = [];
  if (subject && subject !== 'all') { sql += ' AND subject = ?'; params.push(subject); }
  if (status && status !== 'all') { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), (Number(page) - 1) * Number(limit));
  const rows = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as count FROM questions WHERE 1=1' +
    (subject && subject !== 'all' ? ' AND subject = ?' : '') +
    (status && status !== 'all' ? ' AND status = ?' : '')
  ).get(...(subject && subject !== 'all' ? [subject] : []).concat(status && status !== 'all' ? [status] : []));
  res.json({ data: rows, total: total.count, page: Number(page), limit: Number(limit) });
});

// 获取单个错题
app.get('/api/questions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

// 新增错题
app.post('/api/questions', (req, res) => {
  const { subject, chapter, question_type, question, my_answer, correct_answer, error_reason, difficulty } = req.body;
  if (!subject || !question || !correct_answer) {
    return res.status(400).json({ error: '缺少必填字段' });
  }
  const info = db.prepare(`INSERT INTO questions (subject, chapter, question_type, question, my_answer, correct_answer, error_reason, difficulty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(subject, chapter || '', question_type || '', question, my_answer || '', correct_answer, error_reason || '', difficulty || 3);
  res.json({ id: info.lastInsertRowid, message: '添加成功' });
});

// 更新错题
app.put('/api/questions/:id', (req, res) => {
  const fields = ['subject', 'chapter', 'question_type', 'question', 'my_answer', 'correct_answer', 'error_reason', 'analysis', 'related_types', 'difficulty', 'status'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  updates.push("updated_at = CURRENT_TIMESTAMP");
  params.push(req.params.id);
  db.prepare(`UPDATE questions SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ message: '更新成功' });
});

// 删除错题
app.delete('/api/questions/:id', (req, res) => {
  db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
  res.json({ message: '删除成功' });
});

// AI分析(规则模拟)
app.post('/api/questions/:id/analyze', (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
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

  const difficulty = q.difficulty || 3;
  if (difficulty <= 2) analysis += ' 题目难度较低，注意基础巩固。';
  else if (difficulty >= 4) analysis += ' 题目难度较高，建议先掌握基础再挑战。';

  db.prepare('UPDATE questions SET analysis = ?, related_types = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(analysis, relatedTypes.join('|'), req.params.id);

  res.json({ analysis, related_types: relatedTypes, message: '分析完成' });
});

// 统计看板
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM questions').get().count;
  const unsolved = db.prepare("SELECT COUNT(*) as count FROM questions WHERE status = 'unsolved'").get().count;
  const solved = db.prepare("SELECT COUNT(*) as count FROM questions WHERE status = 'solved'").get().count;

  const bySubject = db.prepare('SELECT subject, COUNT(*) as count FROM questions GROUP BY subject ORDER BY count DESC').all();
  const byType = db.prepare("SELECT question_type, COUNT(*) as count FROM questions WHERE question_type != '' GROUP BY question_type").all();
  const byDifficulty = db.prepare('SELECT difficulty, COUNT(*) as count FROM questions GROUP BY difficulty ORDER BY difficulty').all();
  const recent = db.prepare("SELECT date(created_at) as date, COUNT(*) as count FROM questions GROUP BY date(created_at) ORDER BY date DESC LIMIT 7").all();

  res.json({ total, unsolved, solved, bySubject, byType, byDifficulty, recent });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`考研错题工具服务已启动: http://0.0.0.0:${PORT}`);
});
