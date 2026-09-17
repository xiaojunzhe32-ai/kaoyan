/**
 * aiService.js — 多 Provider AI 兜底服务
 *  - 视觉识别: qwen3-vl-flash（阿里，主） → GLM-4.5V（智谱，备）
 *  - 推理解题: qwen-flash（阿里，主） → GLM-4.5-Flash（智谱，备）
 *  统一走 OpenAI 兼容 Chat Completions 接口，按 providers 顺序自动跨厂降级
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

function getConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')).ai || {};
  } catch (e) {
    return {};
  }
}

function allProviders() {
  return getConfig().providers || [];
}

function isEnabled() {
  return allProviders().some(p => p && p.apiKey);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 容错 JSON 解析：AI 在 JSON 字符串里常只写单个反斜杠（如 \int、\frac），
 *  那在 JSON 中是非法转义（\i），会导致 JSON.parse 失败。
 *  修复规则：把「前面不是反斜杠、且后跟非 " 或 \ 」的单个 \ 补成 \\（合法转义）。
 *  已正确写成 \\ 的双反斜杠不会被动。 */
function repairAndParse(raw) {
  if (typeof raw !== 'string') return null;
  const fixed = raw.replace(/(^|[^\\])\\(?!["\\])/g, '$1\\\\');
  try { return JSON.parse(fixed); } catch (e) { return null; }
}

/** 单次请求单个模型 */
function chatOnce(provider, model, messages, opts) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      messages,
      temperature: opts.temperature !== undefined ? opts.temperature : 0.3,
      max_tokens: opts.maxTokens || 2048
    });
    const base = (provider.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
    const req = https.request(base + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.apiKey}`
      },
      timeout: opts.timeout || 90000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.choices && j.choices[0] && j.choices[0].message) {
            resolve(j.choices[0].message.content);
          } else {
            reject(new Error(`AI 返回异常: ${j.error ? j.error.message || JSON.stringify(j.error) : data.slice(0, 200)}`));
          }
        } catch (e) {
          reject(new Error(`AI 响应解析失败: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('AI 请求超时')));
    req.write(body);
    req.end();
  });
}

/**
 * 多 Provider 遍历调用。
 * opts.role: 'vision' | 'text' 决定用各 provider 的视觉/文本模型链
 * 返回 { content, provider, model }
 */
async function chat(messages, opts = {}) {
  const role = opts.role || 'text';
  const skipProvider = opts.skipProvider;
  const providers = allProviders();
  let lastErr = null;

  for (const p of providers) {
    if (!p || !p.apiKey) continue;
    if (skipProvider && skipProvider === (p.name || 'unknown')) continue;
    const models = role === 'vision'
      ? [p.visionModel, ...(p.fallbackVisionModels || [])].filter(Boolean)
      : [p.textModel, ...(p.fallbackTextModels || [])].filter(Boolean);
    if (!models.length) continue;

    for (const model of models) {
      try {
        const content = await chatOnce(p, model, messages, opts);
        return { content, provider: p.name || 'unknown', model };
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || '');
        const isHardError = !/访问量过大|请求过多|限流|429|Ratelimit|rate.?limit|过于频繁|does not exist|Not Found|ModelNotFound|not have access|超时|timeout/i.test(msg);
        if (isHardError) break; // 认证/配置类硬错误：换下一家 provider
        await sleep(1800); // 限流：稍等再试下一模型/厂家
      }
    }
  }
  if (lastErr) throw lastErr;
  throw new Error('未配置可用的 AI Provider');
}

/* ---- OCR 结果结构评分（用于多厂家择优 & 置信反馈）----
   既看 AI 自报 confidence，也做本地结构校验：
   - $...$ 是否闭合、是否含 LaTeX 命令、是否含数学结构（积分/分数/根号/上下标/dx）
   - 是否含 UI 噪词或无意义乱码 */
const UI_NOISE = /一键填充|自动归类|识别完成|重新拍摄|OCR识别|正确答案|解题过程|拍照或上传|登录|退出|错题列表|添加错题|统计看板/;

function scoreOcrResult(parsed) {
  const q = (parsed && parsed.question || '').trim();
  if (!q) return 0;
  let s = 40; // 基础分
  // 长度适中加分（太短说明信息不全）
  s += Math.min(q.length, 160) * 0.15;

  // $ 闭合检查
  const dollars = (q.match(/\$/g) || []).length;
  if (q.includes('$') && dollars % 2 === 0) s += 20;
  else if (dollars % 2 === 1) s -= 25;

  // 含 LaTeX 命令
  if (/\\[a-zA-Z]+/.test(q)) s += 15;
  // 数学结构完整
  const mathHits = [
    /\\frac/, /\\int|\b∫/, /\\sqrt/, /\^/, /[a-z]dx\b|\bdx\b|\bdt\b/,
    /\|.*\|/, /\\to|→/, /\\cdot|·|\\times/
  ];
  mathHits.forEach(re => { if (re.test(q)) s += 6; });

  // 去掉 $ 和 LaTeX 命令后，检查是否有大量非数学的未知乱码（如 sx、cx 这类碎片）
  const stripped = q.replace(/\$[^$]*\$/g, ' ').replace(/\\[a-zA-Z]+\s?/g, ' ');
  const noise = (stripped.match(/[^·;:，。0-9a-zA-Z+\-*/=(){}[\],|<>^~ ]/g) || []).length;
  if (noise > 2) s -= 15;

  // UI 噪词
  if (UI_NOISE.test(q)) s -= 30;

  // 综合 AI 自报置信度（0-1），占 40% 权重
  const conf = parseFloat(parsed.confidence);
  const confScore = !isNaN(conf) ? conf * 40 : 16;
  return Math.round(s + confScore);
}

/** 单次视觉识别（一个厂家一个模型），解析 JSON 返回 } */
async function recognizeOnce(p, model, base64Data) {
  const system = `你是考研数学题识别引擎，专门将数学题目图片转成 LaTeX 文本。输出紧凑 JSON，不要任何其他文字，不要代码围栏：
{"items":[{"question":"一道题的完整内容；所有数学公式必须用 $...$ 包裹且保留完整 LaTeX 结构（如 $\\\\frac{a}{b}$、$x^2$、$\\\\int_{0}^{1} f(x)\\\\,dx$、绝对值 $|t|$、根号 $\\\\sqrt{1-\\\\sin x}$、指数 $e^{-\\\\cos x}$）","subject":"数学|英语|政治|专业课","type":"选择题|填空题|计算题|证明题|解答题","difficulty":"1-5"}],"confidence":0.0}
严格要求：
- 若图片内有多道题，按图片顺序拆分成多个 items，切勿粘连成一段；
- 必须保留积分号 $\\\\int$、上下限、被积函数、dx/dt、绝对值、根号、指数等所有数学符号的完整 LaTeX 结构，禁止省略或用中文描述替代；
- 删掉与题目无关的标题、页码、分值、注意事项等；识别不清则对应的 question 输出空字符串；
- confidence 为 0~1，表示你对整张图片识别内容的确信度，识别不出或图片模糊时给低分。`;
  const r = await chatOnce(p, model, [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', text: '识别图片中的题目并输出 JSON。' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Data}` } }
      ]
    }
  ], { temperature: 0.1, maxTokens: 1024 });

  const m = r.match(/\{[\s\S]*\}/);
  if (!m) return { question: '' };
  const j = JSON.parse(m[0]);

  if (Array.isArray(j.items) && j.items.length) {
    const items = j.items.map(it => ({
      question: String(it.question || '').trim(),
      subject: it.subject || '',
      type: it.type || '',
      difficulty: it.difficulty ? String(it.difficulty) : ''
    })).filter(it => it.question);
    return {
      question: items[0]?.question || '',
      items,
      subject: items[0]?.subject || '',
      type: items[0]?.type || '',
      difficulty: items[0]?.difficulty || '',
      isMultiple: items.length > 1,
      confidence: parseFloat(j.confidence),
      source: p.name || 'unknown',
      model
    };
  }
  return {
    question: String(j.question || '').trim(),
    items: [{ question: String(j.question || '').trim(), subject: j.subject || '', type: j.type || '', difficulty: j.difficulty ? String(j.difficulty) : '' }],
    isMultiple: false,
    confidence: parseFloat(j.confidence),
    subject: j.subject || '',
    type: j.type || '',
    difficulty: j.difficulty ? String(j.difficulty) : '',
    source: p.name || 'unknown',
    model
  };
}

/** 视觉识别题目图片 → 多厂家择优，返回质量最高识别结果 */
async function recognizeImage(base64Data) {
  const providers = allProviders().filter(p => p && p.apiKey);
  let best = null;
  let tried = 0;
  let lastErr = null;

  for (const p of providers) {
    const models = [p.visionModel, ...(p.fallbackVisionModels || [])].filter(Boolean);
    for (const model of models) {
      tried++;
      try {
        const parsed = await recognizeOnce(p, model, base64Data);
        const q = (parsed.question || '').trim();
        if (!q) continue;   // 空结果：换下一家
        parsed.score = scoreOcrResult(parsed);
        if (!best || parsed.score > best.score) best = parsed;
        // 结构完整（含公式）且置信较高 → 提前返回，不再额外消耗 API
        if (parsed.score >= 75) return parsed;
      } catch (e) {
        lastErr = e;
        await sleep(800);   // 限流稍候再试
      }
    }
  }

  if (best) return best;
  if (lastErr) throw lastErr;
  return { question: '', source: providers[0]?.name || 'unknown', tried };
}

/** 解题兜底：生成答案与分步过程（输出 JSON）；opts.skipProvider 可跳过某厂商重试 */
async function solveQuestion(questionText, opts = {}) {
  const isMath = !opts.subject || /数学|数一|数二|数三/.test(String(opts.subject)) || /\\int|\b∫|dx\b|\\frac|\\sqrt|\\lim|\\sum|极限|求导|导数|微分|积分|求解方程|\\frac\{|²|³|\\^|求方程|解方程|x\s*[\^⁰¹²³]|\\sin|\\cos|\\tan|\b求\s*[a-z]|\be\^/.test(String(questionText));
  // 非数学科目（英语/政治/专业等）：用通用解题流程，不强求数学公式
  if (!isMath) {
    const gsystem = `你是考研辅导老师。请按"大学生规范解题思路"解题，过程完整、严谨、有依据，输出紧凑 JSON，不要任何解释文字，不要代码围栏：
{
"analysis":"【审题】明确题目考查的知识点、要求与题型。",
"approach":"【解题思路】说明准备用什么方法解答、为什么，以及整体步骤安排（2~3 句）。",
"points":"【涉及知识点】罗列本题考查的知识点。",
"steps":["第1步：...","第2步：...","第3步：..."],
"answer":"最简最终答案",
"check":"【复核】说明如何检查答案合理（如对照题目要求、核对推理是否自洽）并给结论。"
}
推导要求：
- 步骤完整、严谨、有序，每一步说明做法并逐步推进至上一步结果，不得跳跃省略；
- 思考顺序符合大学生解题逻辑：先审题 → 选方法 → 逐步推导 → 写答案 → 复核；
- answer 只给最简最终结果，不含过程；
- 不要输出 markdown 代码块或解释性文字。`;
    let gr;
    try {
      gr = await chat([
        { role: 'system', content: gsystem },
        { role: 'user', content: `题目：${questionText}\n请按规范流程完整解题并输出 JSON。` }
      ], { temperature: 0.2, maxTokens: 3000, skipProvider: opts.skipProvider });
    } catch (e) {
      console.error('[solveQuestion] 调用失败:', e.message.slice(0, 150));
      return null;
    }
    const gm = gr.content.match(/\{[\s\S]*\}/);
    if (gm) {
      try {
        const j = repairAndParse(gm[0]);
        if (j.answer) {
          return {
            answer: String(j.answer).trim(),
            steps: Array.isArray(j.steps) ? j.steps.map(s => String(s)) : [],
            type: j.type ? String(j.type) : '智能解答',
            analysis: j.analysis ? String(j.analysis).trim() : '',
            approach: j.approach ? String(j.approach).trim() : '',
            points: j.points ? String(j.points).trim() : '',
            check: j.check ? String(j.check).trim() : '',
            source: gr.provider, model: gr.model
          };
        }
      } catch (e) { /* 落到数学分支重试 */ }
    }
    return null;
  }

  const system = `你是考研数学老师。请模仿大学生在草稿纸上的规范解题思路，像人手写标准答案那样逐步推导，过程完整、严谨、有依据，绝不跳跃省略。输出紧凑 JSON，不要任何解释文字，不要代码围栏：
{
"analysis":"【审题】明确已知条件、所求目标、题型分类（如求极限/求导/不定积分/定积分/求极值/证明题）、定义域或前提约束。",
"approach":"【观察与思路】先说观察到题目的什么特征（例如：被积函数是 x∙eˣ 型、分母可因式分解、含 eᶜᵒˢˣ 等），据此判定题型，再说明准备使用哪个方法及为什么这个方法适用，最后写整体的计算规划（先做哪步、再做哪步、用哪个公式）。",
"points":"【涉及知识/公式】罗列本题实际用到的知识点：公式、定理、方法及其适用条件。",
"steps":["第1步：...（每步先讲这句在做什么、依据哪个公式，再写完整变形过程，公式用 $...$ 包裹）","第2步：...","第3步：..."],
"answer":"最简最终答案（不定积分必须含常数 C；定积分必须代入上下限写出精确值；公式用 $...$ 包裹，如 $\\\\frac{1}{2}\\\\ln 2$）",
"check":"【复核】说明用什么方式验证答案成立（如：对不定积分结果求导回验是否等于被积函数、把定积分代入上下限求值、用特殊值代入检验），并给出验证结论。"
}
推导要求（务必逐条遵守）：
- 分步推导以"第1步/第2步/..."逐条给出；**适中粒度**：每一步完成一个关键代数变形或一次公式代入，同类的小变形可在同一句内写完，但不得用"化简可得""代入后"直接把一大段跳成最终结果；
- 每一步必须交代：这一步在做什么 → 依据哪个公式/定理 → 写出具体的变形式子。式子要完整（如 xⁿ 求导写成 $n\\\\,x^{n-1}$，分部积分要写出 $\\\\int u\\\\,dv=uv-\\\\int v\\\\,du$ 再代入）；
- 积分题要写出被积函数、选 $u$/$dv$、换元 $t=...$ 等关键中间式，不得一步出答案；
- 若为定积分，求完原函数后必须写出代入上下限的算式与精确结果；
- 思考顺序严格符合大学生解题逻辑：先审题明确定义域/条件 → 观察特征选方法 → 逐步推导 → 写最简答案 → 反向复核；
- answer 一律只给最简最终结果，不含推导过程；
- 全程不得输出 markdown 代码块、不得输出"最终答案""解得"这类总结性修饰，直接给结构字段。`;
  let r;
  try {
    r = await chat([
      { role: 'system', content: system },
      { role: 'user', content: `题目：${questionText}\n请按规范流程完整解题并输出 JSON。` }
    ], { temperature: 0.2, maxTokens: 3500, skipProvider: opts.skipProvider });
  } catch (e) {
    console.error('[solveQuestion] 调用失败:', e.message.slice(0, 150));
    return null;
  }

  const m = r.content.match(/\{[\s\S]*\}/);
  if (!m) {
    console.error('[solveQuestion] 无JSON:', JSON.stringify(r.content).slice(0, 300), '| provider:', r.provider, r.model);
    return null;
  }
  try {
    const j = repairAndParse(m[0]);
    if (!j.answer) {
      console.error('[solveQuestion] 空answer:', JSON.stringify(r.content).slice(0, 300));
      return null;
    }
    return {
      answer: String(j.answer).trim(),
      steps: Array.isArray(j.steps) ? j.steps.map(s => String(s)) : [],
      type: j.type ? String(j.type) : '智能解答',
      analysis: j.analysis ? String(j.analysis).trim() : '',
      approach: j.approach ? String(j.approach).trim() : '',
      points: j.points ? String(j.points).trim() : '',
      check: j.check ? String(j.check).trim() : '',
      source: r.provider,
      model: r.model
    };
  } catch (e) {
    console.error('[solveQuestion] 解析失败:', e.message, '| raw:', JSON.stringify(r.content).slice(0, 300));
    return null;
  }
}

/* ---- 答案等价性比较（用于双模型交叉验证）----
   归一化后比较，忽略 $、空白、\frac 括号化、\ln 写法、不定积分常数 C 等差异。 */
function normalizeAnswer(s) {
  if (!s) return '';
  return String(s)
    .replace(/\$/g, '').replace(/\\,/g, '').replace(/\\\\/g, '\\')
    .replace(/\\displaystyle/g, '').replace(/\\text\{[^}]*\}/g, '')
    .replace(/\\left\s*/g, '').replace(/\\right\s*/g, '')
    .replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '($1)/($2)')
    .replace(/\\ln\|?([a-z0-9()])\|?/g, 'ln$1')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function stripConst(s) {
  return s.replace(/[+\-]c\b/g, '').replace(/[+\-]c$/g, '');
}

/* 两个 LaTeX 答案是否等价：归一化后相同，或去除常数项后相近则判为一致 */
function answersEquivalent(a, b) {
  const A = normalizeAnswer(a);
  const B = normalizeAnswer(b);
  if (!A || !B) return false;
  if (A === B) return true;
  const As = stripConst(A), Bs = stripConst(B);
  return As === Bs || (As.length > 6 && (As.includes(Bs) || Bs.includes(As)));
}

module.exports = { isEnabled, chat, recognizeImage, solveQuestion, answersEquivalent, getConfig, allProviders };