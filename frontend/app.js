const API = '';

// 页面切换
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + link.dataset.page).classList.add('active');
    if (link.dataset.page === 'list') loadQuestions();
    if (link.dataset.page === 'stats') loadStats();
  });
});

let currentPage = 1;

// 加载错题列表
async function loadQuestions() {
  const subject = document.getElementById('filter-subject').value;
  const status = document.getElementById('filter-status').value;
  const res = await fetch(`${API}/api/questions?subject=${subject}&status=${status}&page=${currentPage}&limit=10`);
  const json = await res.json();
  const list = document.getElementById('question-list');
  list.innerHTML = '';

  if (json.data.length === 0) {
    list.innerHTML = '<div class="empty">暂无错题记录，快去添加吧！</div>';
    return;
  }

  json.data.forEach(q => {
    const card = document.createElement('div');
    card.className = 'question-card';
    card.onclick = () => showDetail(q.id);
    const tags = [];
    if (q.subject) tags.push(`<span class="tag tag-${q.subject}">${q.subject}</span>`);
    if (q.question_type) tags.push(`<span class="tag">${q.question_type}</span>`);
    if (q.difficulty) tags.push(`<span class="tag tag-diff${q.difficulty}">难度${q.difficulty}</span>`);
    if (q.status === 'solved') tags.push('<span class="tag tag-solved">已解决</span>');

    card.innerHTML = `
      <div class="q-tags">${tags.join('')}</div>
      <div class="q-content">${escapeHtml(q.question).substring(0, 120)}${q.question.length > 120 ? '...' : ''}</div>
      <div class="q-meta">
        <span>${q.chapter || '未分类'}</span>
        <span>${q.created_at?.substring(0, 10) || ''}</span>
      </div>
    `;
    list.appendChild(card);
  });

  // 分页
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

// 详情弹窗
async function showDetail(id) {
  const res = await fetch(`${API}/api/questions/${id}`);
  const q = await res.json();
  const body = document.getElementById('detail-body');

  let analysisHtml = '';
  if (q.analysis) {
    analysisHtml = `
      <div class="detail-section analysis-box">
        <h3>AI分析结果</h3>
        <p>${escapeHtml(q.analysis)}</p>
        ${q.related_types ? `<div class="related-types">${q.related_types.split('|').map(t => `<span class="tag tag-related">${t}</span>`).join('')}</div>` : ''}
      </div>`;
  }

  body.innerHTML = `
    <h2>错题详情 #${q.id}</h2>
    <div class="detail-section">
      <p><strong>科目:</strong> ${q.subject} | <strong>章节:</strong> ${q.chapter || '-'} | <strong>题型:</strong> ${q.question_type || '-'}</p>
      <p><strong>题目:</strong></p>
      <pre>${escapeHtml(q.question)}</pre>
    </div>
    <div class="detail-section">
      <p><strong>我的答案:</strong></p>
      <pre class="answer-wrong">${escapeHtml(q.my_answer || '未填写')}</pre>
    </div>
    <div class="detail-section">
      <p><strong>正确答案:</strong></p>
      <pre class="answer-correct">${escapeHtml(q.correct_answer)}</pre>
    </div>
    ${q.error_reason ? `<div class="detail-section"><p><strong>错误原因:</strong></p><p>${escapeHtml(q.error_reason)}</p></div>` : ''}
    ${analysisHtml}
    <div class="detail-actions">
      ${!q.analysis ? `<button class="btn btn-accent" onclick="analyzeQuestion(${q.id})">AI智能分析</button>` : ''}
      ${q.status !== 'solved' ? `<button class="btn btn-success" onclick="markSolved(${q.id})">标记已解决</button>` : ''}
      <button class="btn btn-danger" onclick="deleteQuestion(${q.id})">删除</button>
    </div>
  `;
  document.getElementById('detail-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('detail-modal').style.display = 'none';
}

// AI分析
async function analyzeQuestion(id) {
  const res = await fetch(`${API}/api/questions/${id}/analyze`, { method: 'POST' });
  const json = await res.json();
  alert(json.message + '\n\n' + json.analysis);
  showDetail(id);
}

// 标记已解决
async function markSolved(id) {
  await fetch(`${API}/api/questions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'solved' })
  });
  closeModal();
  loadQuestions();
}

// 删除
async function deleteQuestion(id) {
  if (!confirm('确定删除这道错题吗？')) return;
  await fetch(`${API}/api/questions/${id}`, { method: 'DELETE' });
  closeModal();
  loadQuestions();
}

// 添加表单
document.getElementById('add-form').addEventListener('submit', async e => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const data = Object.fromEntries(formData);
  const res = await fetch(`${API}/api/questions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const json = await res.json();
  if (res.ok) {
    alert('添加成功！');
    e.target.reset();
    document.querySelector('[data-page="list"]').click();
  } else {
    alert('添加失败: ' + (json.error || '未知错误'));
  }
});

// 统计看板
async function loadStats() {
  const res = await fetch(`${API}/api/stats`);
  const s = await res.json();
  const content = document.getElementById('stats-content');

  const subjectBars = s.bySubject.map(item => {
    const pct = s.total > 0 ? (item.count / s.total * 100) : 0;
    return `<div class="stat-bar"><span class="bar-label">${item.subject}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><span class="bar-value">${item.count}</span></div>`;
  }).join('');

  const typeList = s.byType.map(item => `<span class="tag">${item.question_type}: ${item.count}</span>`).join('') || '<span class="empty-text">暂无数据</span>';

  const diffBars = s.byDifficulty.map(item => {
    const pct = s.total > 0 ? (item.count / s.total * 100) : 0;
    return `<div class="stat-bar"><span class="bar-label">难度${item.difficulty}</span><div class="bar-track"><div class="bar-fill bar-fill-diff" style="width:${pct}%"></div></div><span class="bar-value">${item.count}</span></div>`;
  }).join('');

  const recentBars = s.recent.map(item => {
    const max = Math.max(...s.recent.map(r => r.count), 1);
    const pct = (item.count / max * 100);
    return `<div class="stat-bar"><span class="bar-label">${item.date}</span><div class="bar-track"><div class="bar-fill bar-fill-recent" style="width:${pct}%"></div></div><span class="bar-value">${item.count}</span></div>`;
  }).join('');

  content.innerHTML = `
    <div class="stat-card">
      <div class="stat-number">${s.total}</div>
      <div class="stat-label">错题总数</div>
    </div>
    <div class="stat-card">
      <div class="stat-number stat-unsolved">${s.unsolved}</div>
      <div class="stat-label">未解决</div>
    </div>
    <div class="stat-card">
      <div class="stat-number stat-solved">${s.solved}</div>
      <div class="stat-label">已解决</div>
    </div>
    <div class="stat-card">
      <div class="stat-number">${s.total > 0 ? Math.round(s.solved / s.total * 100) : 0}%</div>
      <div class="stat-label">解决率</div>
    </div>
    <div class="stat-panel">
      <h3>科目分布</h3>
      ${subjectBars || '<div class="empty-text">暂无数据</div>'}
    </div>
    <div class="stat-panel">
      <h3>题型分布</h3>
      <div class="tag-list">${typeList}</div>
    </div>
    <div class="stat-panel">
      <h3>难度分布</h3>
      ${diffBars || '<div class="empty-text">暂无数据</div>'}
    </div>
    <div class="stat-panel">
      <h3>近7天记录</h3>
      ${recentBars || '<div class="empty-text">暂无数据</div>'}
    </div>
  `;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// 初始加载
loadQuestions();
