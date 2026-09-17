const API = '';
let currentPage = 1;
let currentImageUrl = '';
let ocrResult = '';
let ocrPerforming = false;
let lastOcrQuality = null;
let lastOcrSource = 'ocr';
let lastOcrAiCls = { subject: '', type: '', difficulty: '' };
let lastOcrItems = null;  // AI 识别出的多道题（第二部分多题选择用）

/* ========== 登录认证 ========== */
const loginOverlay = document.getElementById('login-overlay');

function showLogin() { loginOverlay.classList.add('show'); }
function hideLogin() { loginOverlay.classList.remove('show'); }

function maskAccount(acc) {
  if (!acc || acc.length < 7) return acc || '';
  return acc.slice(0, 3) + '****' + acc.slice(-4);
}

// 会话过期自动回到登录层
const _fetch = window.fetch;
window.fetch = async function (...args) {
  const res = await _fetch(...args);
  const url = String(args[0] || '');
  if (res.status === 401 && !url.includes('/api/login') && !url.includes('/api/auth/status')) {
    showLogin();
  }
  return res;
};

async function checkAuth() {
  try {
    const res = await fetch(`${API}/api/auth/status`);
    const j = await res.json();
    if (j.authenticated) {
      hideLogin();
      loadQuestions();
    } else {
      showLogin();
    }
  } catch (e) {
    showLogin();
  }
}

async function doLogin() {
  const account = document.getElementById('login-account').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  if (!account || !password) { errEl.textContent = '请输入账号和密码'; return; }
  try {
    const res = await fetch(`${API}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, password })
    });
    const j = await res.json();
    if (res.ok) {
      hideLogin();
      document.getElementById('login-password').value = '';
      loadQuestions();
    } else {
      errEl.textContent = j.error || '登录失败';
    }
  } catch (e) {
    errEl.textContent = '网络错误，请重试';
  }
}

async function doLogout() {
  await fetch(`${API}/api/logout`, { method: 'POST' });
  showLogin();
  document.getElementById('login-account').value = '';
  document.getElementById('login-password').value = '';
}

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-account').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('logout-btn').addEventListener('click', doLogout);

/* ---- Photo Upload & OCR ---- */
const photoInput = document.getElementById('photo-input');
const uploadZone = document.getElementById('upload-zone');

uploadZone.addEventListener('click', () => photoInput.click());
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.style.borderColor = 'var(--accent)'; });
uploadZone.addEventListener('dragleave', () => uploadZone.style.borderColor = '');
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.style.borderColor = '';
  if (e.dataTransfer.files[0]) handlePhoto(e.dataTransfer.files[0]);
});

photoInput.addEventListener('change', e => {
  if (e.target.files[0]) handlePhoto(e.target.files[0]);
});

async function handlePhoto(file) {
  if (!file.type.startsWith('image/')) { alert('请选择图片文件'); return; }
  if (file.size > 10 * 1024 * 1024) { alert('图片不能超过 10MB'); return; }

  // 1. 本地预览
  const reader = new FileReader();
  reader.onload = async ev => {
    const dataUrl = ev.target.result;
    document.getElementById('upload-zone').style.display = 'none';
    const preview = document.getElementById('upload-preview');
    preview.style.display = 'block';
    document.getElementById('preview-img').src = dataUrl;

    // 2. 上传到服务器
    const status = document.getElementById('ocr-status');
    status.textContent = '上传中...';
    status.className = 'ocr-status working';
    try {
      const res = await fetch(`${API}/api/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || '上传失败');
      currentImageUrl = json.url;
    } catch (err) {
      status.textContent = '图片上传失败: ' + err.message;
      return;
    }

    // 3. OCR 识别
    runOcr(dataUrl);
  };
  reader.readAsDataURL(file);
}

function resetUpload() {
  currentImageUrl = '';
  ocrResult = '';
  lastSolve = null;
  photoInput.value = '';
  document.getElementById('upload-preview').style.display = 'none';
  document.getElementById('ocr-result').style.display = 'none';
  document.getElementById('solve-panel').style.display = 'none';
  document.getElementById('upload-zone').style.display = '';
}

async function runOcr(imageUrl, forceAi) {
  const status = document.getElementById('ocr-status');
  status.textContent = '识别中（AI 公式引擎，请稍候）...';
  status.className = 'ocr-status working';
  ocrPerforming = true;

  // 优先使用后端 PaddleOCR（中文 + 公式识别质量更高）
  try {
    const res = await fetch(`${API}/api/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageUrl, forceAi: !!forceAi })
    });
    if (res.ok) {
      const j = await res.json();
      if (j.text && j.text.trim()) {
        ocrPerforming = false;
        ocrResult = j.text.trim();
        lastOcrQuality = j.quality || null;
        lastOcrSource = j.source || 'ocr';
        lastOcrAiCls = { subject: j.subject || '', type: j.type || '', difficulty: j.difficulty || '' };
        lastOcrItems = j.items && j.items.length ? j.items : null;
        finishOcr(status);
        return;
      }
    }
    status.textContent = '后端引擎无结果，切换本地引擎...';
  } catch (e) {
    status.textContent = '后端引擎不可用，切换本地引擎...';
  }

  // 降级：tesseract.js 本地识别
  if (typeof Tesseract === 'undefined') {
    document.getElementById('ocr-status').textContent = 'OCR 引擎未加载（请检查网络）';
    return;
  }
  try {
    const { data } = await Tesseract.recognize(imageUrl, 'chi_sim+eng', {
      logger: m => {
        if (m.status === 'recognizing text') {
          const pct = Math.round((m.progress || 0) * 100);
          status.textContent = `本地识别中... ${pct}%`;
        }
      }
    });
    ocrResult = (data.text || '').trim();
    ocrPerforming = false;
    if (!ocrResult) {
      status.textContent = '未识别到文字，可手动填写表单';
      status.className = 'ocr-status';
      return;
    }
    finishOcr(status);
  } catch (err) {
    ocrPerforming = false;
    status.textContent = '识别失败: ' + err.message;
    status.className = 'ocr-status';
  }
}

/* OCR 完成后的通用展示逻辑 */
function finishOcr(status) {
  // 多题识别：进入多题选择，不走单题自动流程
  if (lastOcrItems && lastOcrItems.length > 1) {
    status.textContent = `✅ 识别完成，识别到 ${lastOcrItems.length} 道题`;
    status.className = 'ocr-status done';
    document.getElementById('ocr-result').style.display = 'none';
    showMultiPanel();
    return;
  }

  status.textContent = '✅ 识别完成';
  status.className = 'ocr-status done';

  const resultBox = document.getElementById('ocr-result');
  resultBox.style.display = 'block';
  document.getElementById('ocr-text').innerHTML = mathText(ocrResult);
  document.getElementById('ocr-text').style.whiteSpace = 'pre-wrap';
  renderMath(document.getElementById('ocr-text'));

  // 识别质量提示
  if (lastOcrQuality && lastOcrQuality.score < 50) {
    const hint = document.getElementById('ocr-quality-hint');
    if (hint) hint.remove();
    const box = document.createElement('div');
    box.id = 'ocr-quality-hint';
    box.className = 'ocr-quality-hint';
    box.innerHTML = `<b>⚠ 识别质量较低（${lastOcrQuality.score}/100）</b>，可能是图片模糊、反光或拍到了屏幕。建议<a href="javascript:void(0)" onclick="resetUpload()">重新拍摄清晰原题</a>。`;
    resultBox.insertBefore(box, resultBox.firstChild);
  } else {
    const hint = document.getElementById('ocr-quality-hint');
    if (hint) hint.remove();
  }

  // 识别来源徽标
  const badge = document.getElementById('ocr-source-badge');
  if (badge) {
    if (lastOcrSource === 'ai') {
      badge.style.display = 'inline-block';
      badge.textContent = 'AI 智能识别';
      badge.className = 'ocr-source-badge ai';
    } else if (lastOcrSource === 'ocr') {
      badge.style.display = 'inline-block';
      badge.textContent = '本地 OCR';
      badge.className = 'ocr-source-badge';
    }
  }

  // 自动归类提示（AI 识别时优先用 AI 的分类结果）
  const cls = lastOcrAiCls.subject ? lastOcrAiCls : classifyOcr(ocrResult);
  const chips = ['subject', 'type', 'difficulty'].map(key => {
    const label = { subject: '科目', type: '题型', difficulty: '难度' }[key];
    return `<span class="classify-chip ${cls[key] ? 'match' : ''}">${label}: ${cls[key] || '待定'}</span>`;
  }).join('');
  const chipRow = document.getElementById('ocr-chips');
  if (chipRow) chipRow.remove();
  const div = document.createElement('div');
  div.id = 'ocr-chips';
  div.className = 'classify-chips';
  div.innerHTML = `<span style="font-size:11px;color:var(--ink-3);align-self:center">自动归类</span>${chips}`;
  resultBox.appendChild(div);

  // 智能解题：数学题目自动生成答案与过程
  requestSolve(ocrResult, { subject: cls.subject });

  // 自动填充题目与归类到表单（无需手动点击）
  applyOcrToForm();
  // 切换到 AI 只读结果视图（不显示可编辑框）
  showAiReview(ocrResult, null, null);
}

/* AI 深度识别：强制走大模型视觉识别 */
async function aiDeepOcr() {
  if (ocrPerforming) return;
  const status = document.getElementById('ocr-status');
  status.textContent = 'AI 深度识别中（GLM 视觉模型）...';
  status.className = 'ocr-status working';
  const img = document.getElementById('preview-img');
  if (!img || !img.src) {
    status.textContent = '请先上传题目图片';
    return;
  }
  await runOcr(img.src, true);
}

/* ====== 多题识别：勾选 + 批量生成答案并入库 ====== */
function showMultiPanel() {
  const panel = document.getElementById('multi-panel');
  if (!panel) return;
  panel.style.display = 'block';
  const list = document.getElementById('multi-list');
  list.innerHTML = lastOcrItems.map((it, i) => `
    <div class="multi-item" id="mitem-${i}">
      <div class="multi-row">
        <input type="checkbox" class="multi-cb" data-i="${i}" checked onchange="updateMultiCount()">
        <span class="multi-idx">${i + 1}</span>
        <div class="multi-q" data-math="${i}"></div>
        <span class="multi-state" id="mstate-${i}"></span>
      </div>
      <div class="ma-box" id="mabox-${i}" style="display:none">
        <div class="ma-badge" id="mabadge-${i}"></div>
        <div class="ma-label">正确答案（可修改）</div>
        <textarea class="ma-answer" id="ma-ans-${i}" rows="2" spellcheck="false"></textarea>
        <div class="ma-label ma-label-my">我的答案</div>
        <textarea class="ma-answer ma-myanswer" id="ma-my-${i}" rows="2" spellcheck="false" placeholder="填你写的答案（可不填）"></textarea>
        <details class="ma-details"><summary>解题过程</summary><div class="ma-steps" id="ma-steps-${i}"></div></details>
        <div class="ma-actions">
          <button type="button" class="btn btn-accent mini" onclick="confirmMultiSave(${i})">保存</button>
          <button type="button" class="btn btn-ghost mini" onclick="skipMulti(${i})">跳过</button>
        </div>
      </div>
    </div>`).join('');
  // 渲染每题公式
  list.querySelectorAll('.multi-q').forEach((el, i) => {
    el.innerHTML = mathText(lastOcrItems[i].question || '');
    renderMath(el);
  });
  const go = document.getElementById('multi-go');
  go.disabled = false;
  go.textContent = `开始生成并核对答案`;
  document.getElementById('multi-count').textContent = lastOcrItems.length;
  const all = document.getElementById('multi-all');
  if (all) all.checked = true;
  document.getElementById('multi-progress').style.display = 'none';
  updateMultiCount();
}

function updateMultiCount() {
  const n = document.querySelectorAll('#multi-list .multi-cb:checked').length;
  const btn = document.getElementById('multi-go');
  if (!btn) return;
  btn.disabled = n === 0;
  btn.textContent = n ? `开始生成并核对答案（${n} 道）` : '请选择要生成的题目';
  const all = document.getElementById('multi-all');
  if (all && lastOcrItems) all.checked = n === lastOcrItems.length && n > 0;
}

function toggleBatchAll() {
  const on = document.getElementById('multi-all').checked;
  document.querySelectorAll('#multi-list .multi-cb').forEach(cb => cb.checked = on);
  updateMultiCount();
}

let batchBusy = false;
const multiSolved = {};   // i -> { question, subject, type, difficulty, answer, steps, verified, verifyDetail, crossChecked, crossMismatch }

/* 对单道题：AI 解题 → 展示结果到面板（不自动入库，由用户核对后保存） */
async function solveAndSaveOne(it, i) {
  const st = document.getElementById('mstate-' + i);
  st.textContent = '⏳ 求解中';
  st.className = 'multi-state working';
  try {
    const sres = await fetch(`${API}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: it.question, subject: it.subject || '' })
    });
    const sj = await sres.json();
    if (!sres.ok || !sj.canSolve || !sj.answer) {
      st.textContent = '✗ 无法求解';
      st.className = 'multi-state bad';
      return { i, type: 'nosolve', data: null };
    }
    const cls = (it.subject || it.type || it.difficulty) ? it : classifyOcr(it.question);
    multiSolved[i] = {
      question: it.question,
      subject: it.subject || cls.subject || '数学',
      type: it.type || cls.type || '',
      difficulty: it.difficulty || cls.difficulty || 3,
      answer: sj.answer,
      steps: sj.steps || [],
      verified: sj.verified,
      crossChecked: sj.crossChecked,
      crossMismatch: sj.crossMismatch,
      verifyDetail: sj.verifyDetail || ''
    };
    st.textContent = '✓ 已生成';
    st.className = 'multi-state ok';
    renderMultiAnswer(i, multiSolved[i]);
    return { i, type: 'solved', data: multiSolved[i] };
  } catch (e) {
    st.textContent = '✗ 出错';
    st.className = 'multi-state bad';
    return { i, type: 'error', data: null };
  }
}

/* 在面板内展示某题的 AI 答案与解过程（可编辑、可保存/跳过） */
function renderMultiAnswer(i, d) {
  const box = document.getElementById('mabox-' + i);
  if (!box || !d) return;
  const badge = document.getElementById('mabadge-' + i);
  const ans = document.getElementById('ma-ans-' + i);
  const steps = document.getElementById('ma-steps-' + i);
  let badgeHtml = '', badgeCls = '';
  if (d.verified === true) {
    badgeHtml = d.crossChecked ? '✓ 交叉验证通过（两模型一致）' : '✓ 已通过核验';
    badgeCls = 'ok';
  } else if (d.verified === false) {
    badgeHtml = d.crossMismatch ? '⚠ 两模型结果不一致，请核对' : '⚠ 未通过核验，请复核';
    badgeCls = 'bad';
  } else {
    badgeHtml = 'AI 生成 · 未验证';
    badgeCls = 'none';
  }
  badge.textContent = badgeHtml;
  badge.className = 'ma-badge ' + badgeCls;
  badge.title = d.verifyDetail || '';
  ans.value = d.answer;
  steps.innerHTML = (d.steps || []).map((s, k) =>
    `<span class="step-line"><span class="step-num">${k + 1}.</span>${mathText(s)}</span>`).join('');
  renderMath(steps);
  box.style.display = 'block';
}

/* 用户核对后保存这道题（用面板内可编辑的答案） */
async function confirmMultiSave(i) {
  const d = multiSolved[i];
  const ansEl = document.getElementById('ma-ans-' + i);
  const myEl = document.getElementById('ma-my-' + i);
  const st = document.getElementById('mstate-' + i);
  if (!d) { alert('还没有求解结果'); return; }
  const data = {
    subject: d.subject,
    question_type: d.type,
    question: d.question,
    correct_answer: (ansEl ? ansEl.value.trim() : '') || d.answer,
    my_answer: myEl ? myEl.value.trim() : '',
    difficulty: d.difficulty,
    solution: (d.steps || []).join('\n')
  };
  try {
    const qres = await fetch(`${API}/api/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (qres.ok) {
      st.textContent = '✅ 已保存';
      st.className = 'multi-state ok';
      document.getElementById('mabox-' + i).style.display = 'none';
      return { i, type: 'saved' };
    }
    st.textContent = '✗ 保存失败';
    st.className = 'multi-state bad';
    return { i, type: 'saveerr', data };
  } catch (e) {
    st.textContent = '✗ 出错';
    st.className = 'multi-state bad';
    return { i, type: 'error', data: null };
  }
}

/* 用户跳过该题 */
function skipMulti(i) {
  const st = document.getElementById('mstate-' + i);
  st.textContent = '已跳过';
  st.className = 'multi-state bad';
  const box = document.getElementById('mabox-' + i);
  if (box) box.style.display = 'none';
}

async function processBatch() {
  if (batchBusy) return;
  const idx = [...document.querySelectorAll('#multi-list .multi-cb:checked')].map(cb => +cb.dataset.i);
  if (!idx.length) return;
  batchBusy = true;
  const go = document.getElementById('multi-go');
  go.disabled = true;
  const prog = document.getElementById('multi-progress');
  prog.style.display = 'block';

  const CONC = 3;             // 并发限流，防止触发 API 限流
  const results = [];
  let pos = 0, done = 0;
  async function worker() {
    while (pos < idx.length) {
      const i = idx[pos++];
      const r = await solveAndSaveOne(lastOcrItems[i], i);
      results.push(r);
      done++;
      prog.textContent = `已生成 ${done}/${idx.length} 道，请核对答案后保存`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, idx.length) }, worker));

  const failed = results.filter(r => r.type === 'nosolve' || r.type === 'error');
  prog.textContent = `完成：共生成 ${done} 道` + (failed.length ? `，${failed.length} 道求解失败` : '，请在面板内核对后逐题保存') + '；未保存的不会写入错题本';
  go.disabled = false;
  go.textContent = '重新求解';
  batchBusy = false;
}

/* ---- 数学符号归一化 ---- */
function normalizeMathSymbols(text) {
  return (text || '')
    .replace(/[－–—]/g, '-')
    .replace(/[×✕✖·]/g, ' * ')
    .replace(/÷/g, '/')
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/＝/g, '=')
    .replace(/²/g, '^2').replace(/³/g, '^3')
    .replace(/√/g, 'sqrt ')
    .replace(/π/g, 'pi')
    .replace(/∞/g, '∞')
    .replace(/→/g, '->')
    .replace(/\(/g, ' ( ').replace(/\)/g, ' ) ');
}

/* ---- AI 智能解题：请求引擎生成答案与过程 ---- */
let lastSolve = null;

async function requestSolve(text, opts) {
  const forceAi = !!(opts && opts.forceAi);
  const panel = document.getElementById('solve-panel');
  const fallback = document.getElementById('solve-fallback');
  const typeEl = document.getElementById('solve-type');
  fallback.style.display = 'none';
  try {
    const res = await fetch(`${API}/api/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text, forceAi, subject: (opts && opts.subject) || '' })
    });
    const json = await res.json();
    lastSolve = null;
    if (!json.canSolve) {
      panel.style.display = 'none';
      // AI 未能解答：展开手动编辑框作为兜底
      document.getElementById('manual-fields').style.display = '';
      document.getElementById('ai-review').style.display = 'none';
      // 明确提示不再静默：引导用户补充关键公式信息
      fallback.style.display = 'block';
      fallback.innerHTML = `<b>⚠ AI 暂未能解答此题。</b><br>
        可点击下方「让 AI 解题」重试，或展开输入框手动补充关键信息（如积分号 <code>∫</code>、微分 <code>dx</code>、等号、分数线等）。<br>
        <span class="fb-actions">
          <button type="button" class="btn btn-primary" onclick="aiSolve()">让 AI 解题</button>
          <button type="button" class="btn btn-ghost" onclick="document.getElementById('manual-fields').style.display='';document.getElementById('ai-review').style.display='none';document.querySelector('#add-form textarea[name=question]').focus()">手动填写答案</button>
          <button type="button" class="btn btn-ghost" onclick="resetUpload()">重新拍摄</button>
        </span>`;
      return;
    }
    lastSolve = { answer: json.answer, steps: json.steps, analysis: json.analysis, approach: json.approach, points: json.points, check: json.check, verified: json.verified, crossChecked: json.crossChecked, verifyDetail: json.verifyDetail };
    // 正确性核验徽标（数值校验 / 交叉验证 / 未验证）
    let badge = '';
    if (json.verified === true) {
      badge = json.crossChecked
        ? '<span class="verify-badge ok">✓ 交叉验证通过（两模型一致）</span>'
        : '<span class="verify-badge ok">✓ 已通过核验</span>';
    } else if (json.verified === false) {
      badge = json.crossMismatch
        ? '<span class="verify-badge bad">⚠ 两模型结果不一致，请核对</span>'
        : '<span class="verify-badge bad">⚠ 未通过核验，请复核</span>';
    } else if (json.aiUsed) {
      badge = '<span class="verify-badge none">AI 生成 · 未验证</span>';
    }
    typeEl.innerHTML = (json.aiUsed ? `AI 智能解答 · ${json.aiProvider || ''}` : '引擎推导') + ` · ${json.type || ''} ${badge}`;
    typeEl.title = json.verifyDetail || '';
    // 大学生式完整流程字段（审题/思路/知识点/复核）——有值才显示
    renderSolveRow('lbl-analysis', 'solve-analysis', json.analysis);
    renderSolveRow('lbl-approach', 'solve-approach', json.approach);
    renderSolveRow('lbl-points', 'solve-points', json.points);
    renderSolveRow('lbl-check', 'solve-check', json.check);
    const qNorm = normalizeMathSymbols(text).replace(/\s+/g, ' ').trim();
    const qEl = document.getElementById('solve-question');
    qEl.innerHTML = mathText(qNorm);
    renderMath(qEl);
    const aEl = document.getElementById('solve-answer');
    aEl.innerHTML = mathText(json.answer) + (json.definite !== undefined
      ? `<div class="solve-definite">定积分值 ≈ ${json.definite}</div>` : '');
    renderMath(aEl);
    const sEl = document.getElementById('solve-steps');
    sEl.innerHTML = json.steps.map((s, i) =>
      `<span class="step-line"><span class="step-num">${i + 1}.</span>${mathText(s)}</span>`
    ).join('');
    renderMath(sEl);
    panel.style.display = 'block';
    // 自动填入答案与过程（无需手动点击编辑）
    autoApplySolve();
  } catch (err) {
    panel.style.display = 'none';
  }
}

/* 将引擎输出的 LaTeX 片段包装为可渲染格式 */
/* 将文本中的 LaTeX 公式用 $...$ 包裹，使 KaTeX auto-render 能渲染
   AI 返回的答案可能已含 $...$（直接用），也可能裸 LaTeX（自动包裹）*/
function toLatexInline(s) {
  if (!s) return '';
  let text = String(s);
  // 已含 $...$ 或 $$...$$：直接返回，KaTeX auto-render 会处理
  if (/\$[^$]+\$/.test(text) || /\$\$[\s\S]+\$\$/.test(text)) return text;

  // 裸 LaTeX：若为分段函数等环境（\begin{...} 且多行），用 $$...$$（display 模式）包裹，保证 KaTeX 渲染环境
  if (/\\begin\s*\{[^{}]+\}[\s\S]*\\end\s*\{[^{}]+\}/.test(text)) {
    return '$$' + text.trim() + '$$';
  }

  // 裸 LaTeX：找到含 \命令 的数学段，用 $...$ 包裹
  // 数学段 = 连续的 ASCII 数学字符（含 \命令、数字、运算符、字母、括号、^_{}）
  // 以中文字符/中文标点为分界
  const mathChars = /[0-9a-zA-Z+\-*/=(){}[\]^_.,\\|\s]/;
  const cnBoundary = /[\u4e00-\u9fff，。！？；：、（）]/;
  const latexCmd = /\\[a-zA-Z]+/;

  let out = '';
  let i = 0;
  while (i < text.length) {
    // 如果当前是中文字符，原样输出
    if (cnBoundary.test(text[i])) {
      out += text[i];
      i++;
      continue;
    }
    // 如果是数学字符段的开头
    if (mathChars.test(text[i])) {
      let j = i;
      let hasLatex = false;
      // 扩展到数学段结束（遇到中文边界停止）
      while (j < text.length && mathChars.test(text[j])) {
        if (latexCmd.test(text.slice(i, j + 10))) hasLatex = true;
        j++;
      }
      const seg = text.slice(i, j);
      if (hasLatex) {
        out += '$' + seg.trim() + '$';
      } else {
        out += seg; // 纯数字/运算符无需渲染
      }
      i = j;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

/* 安全渲染含 LaTeX 的文本：先包裹 $...$，再在 $...$ 外部转义 HTML
   这样 KaTeX auto-render 能找到 $...$ 并渲染公式，同时防止 XSS */
function mathText(s) {
  if (!s && s !== 0) return '';
  // 对象/数组：安全转字符串，避免出现 [object Object]
  if (typeof s !== 'string') {
    try { s = JSON.stringify(s); } catch { s = String(s); }
  }
  let text = toLatexInline(String(s));
  let result = '';
  let inMath = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$') {
      result += '$';
      inMath = !inMath;
    } else if (!inMath && text[i] === '&') {
      result += '&amp;';
    } else if (!inMath && text[i] === '<') {
      result += '&lt;';
    } else if (!inMath && text[i] === '>') {
      result += '&gt;';
    } else if (!inMath && text[i] === '"') {
      result += '&quot;';
    } else {
      result += text[i];
    }
  }
  return result;
}

/* 截断含 LaTeX 的文本，避免截断在 $...$ 块中间造成 KaTeX 渲染失败 */
function truncateMath(s, maxLen) {
  if (!s || s.length <= maxLen) return s || '';
  let cut = s.substring(0, maxLen);
  // 统计 $ 数量，奇数说明截断点在 $...$ 块内部
  let dollarCount = (cut.match(/\$/g) || []).length;
  if (dollarCount % 2 === 1) {
    // 回退到最后一个 $ 之前，保证 $...$ 块完整
    let lastDollar = cut.lastIndexOf('$');
    if (lastDollar > 0) cut = cut.substring(0, lastDollar);
  }
  return cut + '...';
}

/* 渲染/隐藏大学生式解题流程的某一行（有值显示，空标签与内容一并隐藏） */
function renderSolveRow(lblId, contentId, value) {
  const label = document.getElementById(lblId);
  const content = document.getElementById(contentId);
  if (!content) return;
  if (value) {
    content.innerHTML = mathText(value);
    renderMath(content);
    content.style.display = '';
    if (label) label.style.display = '';
  } else {
    content.style.display = 'none';
    if (label) label.style.display = 'none';
  }
}

/* 使用 KaTeX auto-render 渲染 $...$ 公式 */
function renderMath(el) {
  if (typeof renderMathInElement === 'undefined') return;
  try {
    renderMathInElement(el, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false }
      ],
      throwOnError: false
    });
  } catch (e) { /* 忽略渲染错误 */ }
}

/* 一键填入答案与过程 */
function applySolveToForm() {
  if (!lastSolve) return;
  const form = document.getElementById('add-form');
  const ans = form.querySelector('textarea[name=correct_answer]');
  if (!ans.value.trim()) ans.value = lastSolve.answer;
  // 解题过程写入 hidden input（表单无 textarea，随提交入库）
  const ana = form.querySelector('input[name=analysis]');
  if (ana) ana.value = `${lastSolve.analysis || ''}${lastSolve.approach ? '\n' + lastSolve.approach : ''}`.trim();
  const sol = form.querySelector('input[name=solution]');
  if (sol) sol.value = (lastSolve.steps || []).map((s, i) => `步骤${i + 1}：${s}`).join('\n');
  const err = form.querySelector('textarea[name=error_reason]');
  const cls = classifyOcr(ocrResult);
  if (!err.value.trim() && cls.subject === '数学') {
    err.value = '计算错误';
  }
}

/* AI 结果只读展示卡（无编辑框，AI 输出即最终内容） */
function showAiReview(question, answer, steps) {
  const review = document.getElementById('ai-review');
  const manual = document.getElementById('manual-fields');
  const qEl = document.getElementById('ai-q');
  if (qEl && question) {
    qEl.innerHTML = mathText(question);
    renderMath(qEl);
  }
  const aEl = document.getElementById('ai-a');
  if (aEl) {
    aEl.innerHTML = answer ? mathText(answer) : '<span class="ai-empty">（暂无 AI 答案）</span>';
    renderMath(aEl);
  }
  const sEl = document.getElementById('ai-s');
  if (sEl) {
    if (steps && steps.length) {
      sEl.innerHTML = steps.map((s, i) =>
        `<div class="ai-step"><span class="step-num">${i + 1}.</span><span>${mathText(s)}</span></div>`
      ).join('');
      renderMath(sEl);
    } else {
      sEl.innerHTML = '<span class="ai-empty">（暂无 AI 解题过程）</span>';
    }
  }
  // 大学生式补充环节（审题/思路/知识点/复核），有值才显示
  const R = lastSolve || {};
  renderReviewRow('fg-analysis', 'ai-analysis', R.analysis);
  renderReviewRow('fg-approach', 'ai-approach', R.approach);
  renderReviewRow('fg-points', 'ai-points', R.points);
  renderReviewRow('fg-check', 'ai-check', R.check);
  manual.style.display = 'none';
  review.style.display = 'block';
}

/* 把一行内的行内公式 $...$ 转成显示模式 $$...$$，使公式居中独占一行 */
function toDisplayMath(s) {
  let out = '';
  let i = 0;
  const t = String(s || '');
  while (i < t.length) {
    // 找到下一对（单个）$ 包裹的片段，但跳过已存在的 $$
    if (t[i] === '$' && t[i + 1] === '$') {
      // 已是显示模式，原样保留
      out += t.substring(i, i + 2);
      i += 2;
      continue;
    }
    if (t[i] === '$') {
      const start = i;
      let j = i + 1;
      while (j < t.length && t[j] !== '$') j++;
      if (j < t.length) {
        const inner = t.substring(start + 1, j).trim();
        if (inner) {
          out += '$$\n' + inner + '\n$$';
        }
        // j 指向闭合的 $，继续从 j+1
        i = j + 1;
        continue;
      }
      out += t[i];
      i++;
      continue;
    }
    out += t[i];
    i++;
  }
  return out;
}

/* 渲染/隐藏 ai-review 面板的某一个环节区块 */
function renderReviewRow(fgId, contentId, value) {
  const fg = document.getElementById(fgId);
  const c = document.getElementById(contentId);
  if (!fg || !c) return;
  if (value) {
    c.innerHTML = mathText(value);
    renderMath(c);
    fg.style.display = '';
  } else {
    fg.style.display = 'none';
  }
}

/* 切换 AI 只读视图 / 手动编辑 */
function toggleManualEdit() {
  const review = document.getElementById('ai-review');
  const manual = document.getElementById('manual-fields');
  const showManual = manual.style.display === 'none' || !manual.style.display;
  if (showManual) {
    manual.style.display = '';
    review.style.display = 'none';
  } else {
    manual.style.display = 'none';
    review.style.display = 'block';
  }
}

/* AI 解题成功后自动填入答案与过程 */
function autoApplySolve() {
  applySolveToForm();
  showAiReview(null, lastSolve.answer, lastSolve.steps);
}

/* 引擎解不了时：强制走 AI 大模型解题 */
function aiSolve() {
  if (!ocrResult) {
    const q = document.getElementById('add-form').querySelector('textarea[name=question]');
    if (q && q.value.trim()) ocrResult = q.value.trim();
  }
  if (!ocrResult) { alert('请先识别或填写题目内容'); return; }
  requestSolve(ocrResult, { forceAi: true });
}

/* 直接用 AI 结果保存：自动填充全部字段后提交 */
function saveWithAi() {
  applyOcrToForm();        // 题目 + 科目/题型/难度
  applySolveToForm();      // 答案 + 过程
  const form = document.getElementById('add-form');
  const q = form.querySelector('textarea[name=question]');
  if (!q.value.trim()) {
    alert('未识别到有效题目内容，请先补充或重新拍摄');
    return;
  }
  if (typeof form.requestSubmit === 'function') form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { cancelable: true }));
}

/* ---- Auto-classification rules ---- */
function classifyOcr(text) {
  const result = { subject: '', type: '', difficulty: '' };
  const t = text.toLowerCase();

  // 学科判定
  if (/lim\s*\(|lim |\d\s*[+－×÷]\s*\d|求导|积分|微积分|不等式|方程|函数|数列|导数|矩阵|向量|概率|sin|cos|tan|π|√|\^2|\^3/.test(t)) {
    result.subject = '数学';
  } else if (/which|what|reading|passage|article|choose the|a\.|b\.|c\.|d\./.test(t) || /[\u4e00-\u9fa5]{4,}.{0,20}(which|what|the|of|is|are|to)/.test(t)) {
    result.subject = '英语';
  } else if (/马克思|社会主义|资本论|哲学|政治|经济基础|上层建筑|矛盾|实践|认识论|辩证法|改革开放/.test(t)) {
    result.subject = '政治';
  } else if (/计算|推导|证明|案例分析|名词解释/.test(t) && !result.subject) {
    result.subject = '专业课';
  }

  // 题型判定
  if (/选择|which|choose/.test(t)) result.type = '选择题';
  else if (/填空/.test(t)) result.type = '填空题';
  else if (/证明|求证|prove/.test(t)) result.type = '证明题';
  else if (/计算|求解|求值|compute/.test(t)) result.type = '计算题';
  else if (/简答|问答|论述|分析/.test(t)) result.type = '解答题';

  // 难度初判（按句子长度 / 题型）
  if (result.type === '证明题') result.difficulty = '4';
  else if (t.length > 300) result.difficulty = '4';
  else if (t.length < 80) result.difficulty = '2';

  return result;
}

function applyOcrToForm() {
  if (!ocrResult) return;
  const form = document.getElementById('add-form');
  const cls = classifyOcr(ocrResult);

  // 填科目
  if (cls.subject) {
    const sel = form.querySelector('select[name=subject]');
    if (![...sel.options].some(o => o.value === cls.subject)) {
      sel.add(new Option(cls.subject, cls.subject));
    }
    sel.value = cls.subject;
  }
  // 填题型
  if (cls.type) {
    const typeSel = form.querySelector('select[name=question_type]');
    if (![...typeSel.options].some(o => o.value === cls.type)) {
      typeSel.add(new Option(cls.type, cls.type));
    }
    typeSel.value = cls.type;
  }
  // 填难度
  if (cls.difficulty) {
    const diffSel = form.querySelector('select[name=difficulty]');
    if (![...diffSel.options].some(o => o.value === cls.difficulty)) {
      diffSel.add(new Option(cls.difficulty + ' - 自动判定', cls.difficulty));
    }
    diffSel.value = cls.difficulty;
  }
  // 填题目内容（使用公式归一化后的文本，便于渲染与再识别）
  const q = form.querySelector('textarea[name=question]');
  if (!q.value.trim()) {
    q.value = normalizeMathSymbols(ocrResult).replace(/\s+/g, ' ').trim();
  }
}

/* ========== Navigation ========== */
document.querySelectorAll('.pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const pageId = 'page-' + btn.dataset.page;
    document.getElementById(pageId).classList.add('active');
    if (btn.dataset.page === 'list') { currentPage = 1; loadQuestions(); }
    if (btn.dataset.page === 'stats') loadStats();
  });
});

/* ========== Load Questions ========== */
async function loadQuestions() {
  const subject = document.getElementById('filter-subject').value;
  const status = document.getElementById('filter-status').value;
  const res = await fetch(`${API}/api/questions?subject=${subject}&status=${status}&page=${currentPage}&limit=10`);
  const json = await res.json();
  const list = document.getElementById('question-list');
  list.innerHTML = '';

  if (json.data.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📝</div>
        <h3>暂无错题记录</h3>
        <p>去添加你的第一道错题吧</p>
        <button class="btn btn-primary" onclick="document.querySelector('[data-page=add]').click()">添加错题</button>
      </div>`;
    document.getElementById('pagination').innerHTML = '';
    return;
  }

  json.data.forEach(q => {
    const card = document.createElement('div');
    card.className = 'question-card';
    card.onclick = () => showDetail(q.id);

    const tags = [];
    if (q.subject) tags.push(`<span class="tag tag-subject">${q.subject}</span>`);
    if (q.question_type) tags.push(`<span class="tag">${q.question_type}</span>`);
    if (q.difficulty) {
      const cls = q.difficulty >= 4 ? 'tag-difficulty-high' : 'tag-difficulty';
      tags.push(`<span class="tag ${cls}">难度${q.difficulty}</span>`);
    }
    if (q.status === 'solved') tags.push('<span class="tag tag-solved">已解决</span>');

    card.innerHTML = `
      <div class="q-tags">${tags.join('')}</div>
      <div class="q-content">${mathText(truncateMath(q.question, 140))}</div>
      <div class="q-meta">
        <span>${q.chapter || '未分类'}</span>
        <span>${q.created_at ? q.created_at.substring(0, 10) : ''}</span>
      </div>`;
    list.appendChild(card);
  });
  renderMath(list); // 渲染列表中的 LaTeX 公式
  // Pagination
  const pag = document.getElementById('pagination');
  const totalPages = Math.ceil(json.total / 10);
  pag.innerHTML = '';
  for (let i = 1; i <= totalPages; i++) {
    const btn = document.createElement('button');
    btn.className = `page-btn ${i === currentPage ? 'active' : ''}`;
    btn.textContent = i;
    btn.onclick = () => { currentPage = i; loadQuestions(); };
    pag.appendChild(btn);
  }
}

/* ========== Detail Modal ========== */
async function showDetail(id) {
  const res = await fetch(`${API}/api/questions/${id}`);
  const q = await res.json();
  const body = document.getElementById('detail-body');

  let analysisHtml = '';
  // 解题过程：优先独立 solution 字段；若 history 数据里把步骤塞在 analysis 中（以"步骤N:"开头），则从 analysis 提取
  let solutionText = '';
  if (q.solution) {
    solutionText = String(q.solution);
  } else if (q.analysis && /步骤\d+[:：]/.test(String(q.analysis))) {
    solutionText = String(q.analysis);
  }
  let solutionHtml = '';
  if (solutionText) {
    const stepHtml = solutionText.split(/\n+/).filter(Boolean).map((s, i) => {
      const clean = s.replace(/^\s*(?:步骤|第\s*\d+\s*步)\s*[:：]?\s*/, '');
      const text = toDisplayMath(clean);
      return `<div class="step-line"><span class="step-num">${i + 1}.</span><div class="step-body">${mathText(text)}</div></div>`;
    }).join('');
    solutionHtml = `
      <div class="detail-section solution-box">
        <div class="detail-label">解题过程</div>
        <div class="detail-steps">${stepHtml}</div>
      </div>`;
  }
  if (q.analysis) {
    analysisHtml = `
      <div class="detail-section analysis-box">
        <div class="detail-label">AI 分析结果</div>
        <div class="detail-text">${mathText(q.analysis)}</div>
        ${q.related_types ? `<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">${q.related_types.split('|').map(t => `<span class="tag tag-related">${t}</span>`).join('')}</div>` : ''}
      </div>`;
  }

  body.innerHTML = `
    <div class="detail-meta">
      <span class="meta-chip">#${q.id}</span>
      ${q.subject ? `<span class="meta-chip">${q.subject}</span>` : ''}
      ${q.question_type ? `<span class="meta-chip">${q.question_type}</span>` : ''}
      ${q.chapter ? `<span class="meta-chip">${q.chapter}</span>` : ''}
      ${q.status === 'solved' ? '<span class="meta-chip" style="color:var(--up)">已解决</span>' : ''}
    </div>

    ${q.image_url ? `
    <div class="detail-section">
      <div class="detail-label">题目图片</div>
      <img src="${q.image_url}" alt="题目图片" style="width:100%;border-radius:var(--r-sm);border:1px solid var(--border);max-height:340px;object-fit:contain;background:var(--page)">
    </div>` : ''}

    <div class="detail-section">
      <div class="detail-label">题目</div>
      <div class="detail-block">${mathText(q.question)}</div>
    </div>

    <div class="detail-section">
      <div class="detail-label">我的答案</div>
      <div class="detail-block wrong">${mathText(q.my_answer || '未填写')}</div>
    </div>

    <div class="detail-section">
      <div class="detail-label">正确答案</div>
      <div class="detail-block correct">${mathText(q.correct_answer)}</div>
    </div>

    ${solutionHtml}

    ${q.error_reason ? `
    <div class="detail-section">
      <div class="detail-label">错误原因</div>
      <div class="detail-text">${mathText(q.error_reason)}</div>
    </div>` : ''}

    ${analysisHtml}

    <div class="modal-actions">
      ${!q.analysis ? `<button class="btn btn-accent" onclick="analyzeQuestion(${q.id})">AI 智能分析</button>` : ''}
      ${q.status !== 'solved' ? `<button class="btn btn-success" onclick="markSolved(${q.id})">标记已解决</button>` : ''}
      <button class="btn btn-danger" onclick="deleteQuestion(${q.id})">删除</button>
    </div>`;

  document.getElementById('detail-modal').classList.add('open');
  renderMath(body); // 渲染 LaTeX 公式
}

function closeModal() {
  document.getElementById('detail-modal').classList.remove('open');
}

/* ========== Actions ========== */
async function analyzeQuestion(id) {
  const res = await fetch(`${API}/api/questions/${id}/analyze`, { method: 'POST' });
  const json = await res.json();
  showDetail(id);
}

async function markSolved(id) {
  await fetch(`${API}/api/questions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'solved' })
  });
  closeModal();
  loadQuestions();
}

async function deleteQuestion(id) {
  if (!confirm('确定删除这道错题吗？')) return;
  await fetch(`${API}/api/questions/${id}`, { method: 'DELETE' });
  closeModal();
  loadQuestions();
}

/* ========== Add Form ========== */
document.getElementById('add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const data = Object.fromEntries(formData);
  // 携带图片地址
  if (currentImageUrl) {
    data.image_url = currentImageUrl;
    data.my_answer = data.my_answer || '[拍照题目] 请对照图片作答';
  }
  const res = await fetch(`${API}/api/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const json = await res.json();
  if (res.ok) {
    const subjectName = { 数学: '数学', 英语: '英语', 政治: '政治', 专业课: '专业课' }[data.subject] || data.subject;
    alert(`✅ 添加成功！\n科目：${subjectName}\n题型：${data.question_type || '未指定'}\n难度：${data.difficulty || 3} 星\n已自动归类并保存图片`);
    e.target.reset();
    // 恢复默认界面（AI 只读视图关闭，回到可添加状态）
    document.getElementById('ai-review').style.display = 'none';
    document.getElementById('manual-fields').style.display = '';
    // 清空图片上传区域 & OCR & AI 解题结果
    currentImageUrl = '';
    ocrResult = '';
    lastSolve = null;
    photoInput.value = '';
    const uploadPreview = document.getElementById('upload-preview');
    uploadPreview.style.display = 'none';
    const ocrRow = document.getElementById('ocr-result');
    if (ocrRow) ocrRow.style.display = 'none';
    const solvePanel = document.getElementById('solve-panel');
    if (solvePanel) solvePanel.style.display = 'none';
    const chipsRow = document.getElementById('ocr-chips');
    if (chipsRow) chipsRow.remove();
    document.getElementById('upload-zone').style.display = '';
    document.querySelector('[data-page="list"]').click();
  } else {
    alert('添加失败: ' + (json.error || '未知错误'));
  }
});

/* ========== Stats ========== */
async function loadStats() {
  const res = await fetch(`${API}/api/stats`);
  const s = await res.json();
  const content = document.getElementById('stats-content');
  const pct = s.total > 0 ? Math.round(s.solved / s.total * 100) : 0;

  const subjectBars = s.bySubject.map(item => {
    const p = s.total > 0 ? (item.count / s.total * 100) : 0;
    return `<div class="stat-bar"><span class="bar-label">${item.subject}</span><div class="bar-track"><div class="bar-fill" style="width:${p}%"></div></div><span class="bar-value">${item.count}</span></div>`;
  }).join('');

  const typeList = s.byType.map(item => `<span class="tag">${item.question_type}: ${item.count}</span>`).join('') || '<span style="color:var(--ink-3);font-size:13px;">暂无数据</span>';

  const diffBars = s.byDifficulty.map(item => {
    const p = s.total > 0 ? (item.count / s.total * 100) : 0;
    return `<div class="stat-bar"><span class="bar-label">难度${item.difficulty}</span><div class="bar-track"><div class="bar-fill diff" style="width:${p}%"></div></div><span class="bar-value">${item.count}</span></div>`;
  }).join('');

  const recentBars = s.recent.slice().reverse().map(item => {
    const max = Math.max(...s.recent.map(r => r.count), 1);
    const p = item.count / max * 100;
    return `<div class="stat-bar"><span class="bar-label">${item.date}</span><div class="bar-track"><div class="bar-fill recent" style="width:${p}%"></div></div><span class="bar-value">${item.count}</span></div>`;
  }).join('');

  content.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">错题总数</div>
        <div class="stat-number">${s.total}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">未解决</div>
        <div class="stat-number unsolved">${s.unsolved}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">已解决</div>
        <div class="stat-number solved">${s.solved}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">解决率</div>
        <div class="stat-number">${pct}%</div>
      </div>
    </div>
    <div class="stat-chart-grid">
      <div class="stat-panel">
        <h3>科目分布</h3>
        ${subjectBars || '<div style="color:var(--ink-3);font-size:13px;">暂无数据</div>'}
      </div>
      <div class="stat-panel">
        <h3>题型分布</h3>
        <div class="tag-list">${typeList}</div>
      </div>
      <div class="stat-panel">
        <h3>难度分布</h3>
        ${diffBars || '<div style="color:var(--ink-3);font-size:13px;">暂无数据</div>'}
      </div>
      <div class="stat-panel">
        <h3>近 7 天记录</h3>
        ${recentBars || '<div style="color:var(--ink-3);font-size:13px;">暂无数据</div>'}
      </div>
    </div>`;
}

/* ========== Utilities ========== */
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ========== Init ========== */
checkAuth(); // 启动时校验登录状态，通过后再加载数据