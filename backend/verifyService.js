/**
 * verifyService.js — 数学答案数值校验
 * 目的：保证 AI/引擎生成的答案正确性
 *  1. 定积分 ∫_a^b f(x) dx：将答案（含上下限结果）与 Simpson 数值积分对比
 *  2. 不定积分 ∫ f(x) dx：验证 F'(x) ≈ f(x)（多点抽样，中心差分）
 *  3. 无法数值化的题（证明/文科）：返回 { ok: null }
 * 返回: { ok: true|false|null, detail }
 */
const { create, all } = require('mathjs');
const math = create(all);

const TOL_REL = 1e-3; // 相对容差
const TOL_ABS = 1e-3; // 绝对容差

/* ---------- LaTeX → mathjs 表达式 ---------- */
function latexToExpr(s) {
  let t = String(s || '');
  // 去除 LaTeX 围栏与特殊命令（保留核心结构）
  t = t.replace(/\\\(/g, '').replace(/\\\)/g, '').replace(/\\\[/g, '').replace(/\\\]/g, '');
  // 递归展开 \frac{a}{b} → (a)/(b)
  for (let i = 0; i < 10; i++) {
    const m = t.match(/\\frac\{([^{}]*)\}\{([^{}]*)\}/);
    if (!m) break;
    t = t.slice(0, m.index) + '(' + m[1] + ')/(' + m[2] + ')' + t.slice(m.index + m[0].length);
  }
  t = t
    .replace(/\\sqrt\{([^{}]+)\}/g, (_, a) => 'sqrt(' + a + ')')
    .replace(/\\ln\b/g, 'log')
    .replace(/\\log\b/g, 'log')
    .replace(/\\arctan\b/g, 'atan')
    .replace(/\\arcsin\b/g, 'asin')
    .replace(/\\arccos\b/g, 'acos')
    .replace(/\\sin\b/g, 'sin')
    .replace(/\\cos\b/g, 'cos')
    .replace(/\\tan\b/g, 'tan')
    .replace(/\\cot\b/g, 'cot')
    .replace(/\\sec\b/g, 'sec')
    .replace(/\\csc\b/g, 'csc')
    .replace(/\\exp\b/g, 'exp')
    .replace(/\\abs\b/g, 'abs')
    .replace(/\\pi\b/g, 'pi')
    .replace(/\\cdot\b/g, '*')
    .replace(/\\times\b/g, '*')
    .replace(/\\left\b/g, '').replace(/\\right\b/g, '')
    .replace(/\\mathrm\{([^{}]*)\}/g, '$1')
    .replace(/\\text\{([^{}]*)\}/g, '$1')
    .replace(/\\[a-zA-Z]+(?=\s|\\|$)/g, '') // 剩余未知命令
    .replace(/\\/g, '')
    .replace(/[{}]/g, '')
    .replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/＋/g, '+');
  t = t.trim();

  // 函数名紧贴绝对值（LaTeX 常写作 \ln|x+1|）→ 补空格便于后续解析
  t = t.replace(/\b(sqrt|log|ln|sin|cos|tan|cot|sec|csc|atan|asin|acos|exp|abs)\s*\|/g, '$1 |');

  // 绝对值 |x| → abs(x)（非嵌套，循环处理；先于函数保护，让 abs 一并受保护）
  for (let i = 0; i < 5; i++) {
    const m = t.match(/\|([^|]*)\|/);
    if (!m) break;
    t = t.slice(0, m.index) + 'abs(' + m[1] + ')' + t.slice(m.index + m[0].length);
  }

  // 保护函数名（避免被隐式乘法误伤）：token = \x02函数名\x03（纯字母，不参与数字规则）
  t = t.replace(/\b(sqrt|log|ln|sin|cos|tan|cot|sec|csc|atan|asin|acos|exp|abs)\b/g, m => {
    return '\u0002' + (m === 'ln' ? 'log' : m) + '\u0003';
  });

  // 函数 + 空格 + 紧邻参数 → 函数(参数)（支持嵌套函数/变量/数字/括号组）
  t = t.replace(/(\u0002[a-z]+\u0003)\s+(-?\d+(?:\.\d+)?|\u0002[a-z]+\u0003\s*\([^()]*\)|[a-zA-Z]\w*\s*\([^()]*\)|[a-zA-Z]\w*|\([^()]*\))/g, '$1($2)');

  // 隐式乘法：2x → 2*x，2 x → 2*x，)( → )*(，) x → )*x，x( → x*(
  t = t.replace(/(\d)\s*(?=[a-zA-Z\u0002(])/g, '$1*')
    .replace(/(\))\s*(?=[a-zA-Z\u0002(√])/g, '$1*')
    .replace(/([a-zA-Z\u0002])(?=\d)/g, '$1*')
    .replace(/([a-zA-Z\u0002])(?=\()/g, '$1*');
  // 修复函数调用：token*( → token(（函数不是乘法）
  t = t.replace(/(\u0002[a-z]+\u0003)\*\(/g, '\u0002$1\u0003(');

  // 还原函数 token
  t = t.replace(/\u0002([a-z]+)\u0003/g, '$1');

  // 括号平衡（函数空格化可能缺右括号）
  let o = 0;
  for (const ch of t) { if (ch === '(') o++; else if (ch === ')') o--; }
  if (o > 0) t += ')'.repeat(o);
  return t;
}

/* 数值求值；失败返回 null */
function tryEval(expr, vars) {
  try {
    const v = math.evaluate(expr, vars || {});
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch (e) {
    return null;
  }
}

/* Simpson 数值积分 */
function numericIntegral(expr, a, b, n = 8000) {
  const f = x => tryEval(expr, { x });
  if (!f(a) && f(a) !== 0 && f(a) !== null) return null;
  // 采样判断可计算
  let probe = tryEval(expr, { x: (a + b) / 2 });
  if (probe === null) return null;
  const h = (b - a) / n;
  let sum = f(a) + f(b);
  for (let i = 1; i < n; i++) {
    const x = a + i * h;
    sum += (i % 2 === 0 ? 2 : 4) * f(x);
  }
  return (h / 3) * sum;
}

/* 数值微分（中心差分） */
function numericDerivative(expr, x, h = 1e-5) {
  const f = v => tryEval(expr, { x: v });
  const fp = f(x + h);
  const fm = f(x - h);
  if (fp === null || fm === null) return null;
  return (fp - fm) / (2 * h);
}

/* 提取定积分区间: \int_{a}^{b} 或 ∫_a^b  */
function extractDefinite(question) {
  const q = String(question || '').replace(/\s+/g, '')
    .replace(/\\int/g, '∫').replace(/[（]/g, '(').replace(/[）]/g, ')');
  const m = q.match(/∫[_{]*\{?\s*(-?\d+(?:\.\d+)?)\s*\}?[_{^]*\{?\s*(-?\d+(?:\.\d+)?)\s*\}?/);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[2]);
  if (isNaN(a) || isNaN(b)) return null;
  const seg = q.slice(m.index + m[0].length);
  const dm = seg.match(/^([\s\S]*?)(?:d\s*x|dx)/);
  if (!dm) return null;
  const f = dm[1].trim();
  if (!f) return null;
  return { a, b, f: latexToExpr(f) };
}

/* 去掉答案尾部的任意常数 "+C" / "-C"（不定积分常数不参与数值校验） */
function stripConst(expr) {
  return String(expr)
    .replace(/\s*\+\s*C\s*$/, '')
    .replace(/\s*-\s*C\s*$/, '')
    .replace(/\+\\?,?\s*C\s*$/i, '')
    .trim();
}

/* ---------- 主校验入口 ---------- */
function verify(question, answer) {
  // 1) 定积分
  const def = extractDefinite(question);
  const ansExpr = latexToExpr(stripConst(answer));
  if (def) {
    const val = tryEval(ansExpr, {}); // 最终答案应为常数
    const exact = numericIntegral(def.f, def.a, def.b);
    if (exact === null) return { ok: null, detail: '无法数值积分' };
    if (val === null) {
      // 答案含 x（不定积分形式）→ 校验 F(b)-F(a)
      const fb = tryEval(ansExpr, { x: def.b });
      const fa = tryEval(ansExpr, { x: def.a });
      if (fb !== null && fa !== null) {
        const ok = closeEnough(fb - fa, exact);
        return { ok, detail: `xF差值 ${fmt(fb - fa)} vs 数值积分 ${fmt(exact)}` };
      }
      return { ok: null, detail: '答案无法数值求值' };
    }
    const ok = closeEnough(val, exact);
    return { ok, detail: `答案 ${fmt(val)} vs 数值积分 ${fmt(exact)}（差 ${fmt(Math.abs(val - exact))}）` };
  }

  // 2) 不定积分（答案含 x）
  if (/\\int|∫/.test(question) && /x/.test(answer)) {
    const qStr = String(question).replace(/\\int/g, '∫');
    const im = qStr.match(/∫([\s\S]*?)d\s*x/);
    if (!im) return { ok: null, detail: '无法解析被积函数' };
    let integrandTxt = im[1].trim();
    integrandTxt = integrandTxt.replace(/^[^\x00-\x7F]+/, ''); // 去掉前导中文动词
    const integrand = latexToExpr(integrandTxt);
    if (!integrand) return { ok: null, detail: '被积函数无法转换' };
    // 多点抽样验证 F'(x) ≈ f(x)
    let allGood = true;
    let best = null;
    for (const x0 of [-2, -0.7, 0.5, 1.2, 2.8]) {
      const fx = tryEval(integrand, { x: x0 });
      const fp = numericDerivative(ansExpr, x0);
      if (fx === null || fp === null) { allGood = false; best = { x: x0, fp, fx, un: true }; break; }
      if (!closeEnough(fp, fx)) { allGood = false; best = { x: x0, fp, fx }; break; }
    }
    if (allGood) return { ok: true, detail: `多点校验 F'(x)≈f(x) 通过` };
    if (best) {
      if (best.un) return { ok: null, detail: '被积函数在某点无法求值' };
      const diff = best.fp !== null && best.fx !== null ? Math.abs(best.fp - best.fx) : '?';
      return { ok: false, detail: `x=${best.x} 处 F'(x) 与 f(x) 差 ${fmt(diff)}` };
    }
    return { ok: null, detail: '无法求值' };
  }

  // 3) 其他 → 无法数值校验
  return { ok: null, detail: '暂不支持数值校验的题型' };
}

function closeEnough(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= TOL_ABS + TOL_REL * scale;
}

function fmt(v) {
  if (typeof v !== 'number') return String(v);
  return (Math.round(v * 1e5) / 1e5).toString();
}

module.exports = { verify, latexToExpr, numericIntegral, extractDefinite, closeEnough, tryEval, fmt, stripConst };