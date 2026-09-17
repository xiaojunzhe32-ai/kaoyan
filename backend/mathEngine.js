/**
 * mathEngine.js — 考研高频数学题型解题引擎
 * 覆盖：一元一次/二次方程、多项式极限(含 0/0 约分)、多项式求导、多项式积分、等差/等比数列
 * 所有输出均为 LaTeX 风格字符串，供前端 KaTeX 渲染
 */

// ---------- 基础工具 ----------

function normalize(s) {
  return (s || '')
    .replace(/＝/g, ' = ').replace(/=/g, ' = ')
    .replace(/×/g, '*').replace(/÷/g, '/')
    .replace(/²/g, '^2').replace(/³/g, '^3').replace(/⁴/g, '^4')
    .replace(/√/g, 'sqrt')
    .replace(/π/g, 'pi').replace(/∞/g, 'inf')
    .replace(/－/g, '-').replace(/＋/g, '+')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/→/g, '->').replace(/↦/g, '->')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .toLowerCase();
}

function gcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; }

function fmtNum(v) {
  if (Math.abs(v) < 1e-12) return '0';
  if (Number.isInteger(v)) return String(v);
  // 尝试转分数（分母 ≤ 200）
  for (let d = 2; d <= 200; d++) {
    const n = Math.round(v * d);
    if (Math.abs(v - n / d) < 1e-9) {
      const g = gcd(n, d);
      const nn = n / g, dd = d / g;
      return dd === 1 ? String(nn) : `${nn}/${dd}`;
    }
  }
  return String(Math.round(v * 10000) / 10000);
}

function isZero(v) { return Math.abs(v) < 1e-12; }

// ---------- 多项式解析 ----------

/**
 * 解析多项式表达式字符串（支持: 3x^2, -2x, x, 5, 1/2x^2, x^2/3）
 * 返回升幂系数数组 [c0, c1, c2, ...]，失败返回 null
 */
function parsePolynomial(expr) {
  if (!expr || typeof expr !== 'string') return null;
  const s = expr.trim().toLowerCase().replace(/\s+/g, '');
  if (!/^[0-9+\-*/^.x]+$/.test(s)) return null;
  if (s.includes('sqrt') || s.includes('pi') || s.includes('sin') || s.includes('cos') || s.includes('log')) return null;
  if (/^[^x]*$/.test(s) && /\d+\/\d+/.test(s)) {
    // 纯常数分数
    const m = s.match(/^([+-]?\d+)\/(\d+)$/);
    if (m) { const g = gcd(+m[1], +m[2]); return [parseFloat(m[1]) / g / (parseFloat(m[2]) / g)]; }
  }
  // 归一化 ** 与 ^
  const clean = s.replace(/\*\*/g, '^').replace(/x\^2|(?<!\d)x2(?!\d)/g, 'x^2');
  if (!/^[+-]?[\d/]*x?(\^\d+)?([+-][\d/]*x?(\^\d+)?)*$/.test(clean)) return null;

  const coefMap = new Map();
  // 拆项：按 x 幂次
  const termRe = /([+-]?)([\d/]*)(x(?:\^(\d+))?)?/g;
  let m;
  while ((m = termRe.exec(clean))) {
    if (m[0] === '') { termRe.lastIndex++; continue; } // 避免末尾空匹配死循环
    const sign = m[1] === '-' ? -1 : 1;
    const hasX = !!m[3];
    const power = hasX ? (m[4] ? parseInt(m[4], 10) : 1) : 0;
    let coef = 1;
    if (m[2]) {
      if (m[2].includes('/')) {
        const [a, b] = m[2].split('/');
        if (!isZero(parseFloat(b))) coef = parseFloat(a) / parseFloat(b);
      } else coef = parseFloat(m[2]);
    }
    if (isNaN(coef)) coef = 1;
    coefMap.set(power, (coefMap.get(power) || 0) + sign * coef);
  }
  if (coefMap.size === 0) return null;
  const maxPow = Math.max(...coefMap.keys());
  if (maxPow > 3) return null; // 仅支持低次多项式
  const arr = new Array(maxPow + 1).fill(0);
  for (const [p, c] of coefMap) arr[p] = c;
  while (arr.length > 1 && isZero(arr[arr.length - 1])) arr.pop();
  return arr;
}

function polyToLatex(coefs, varName = 'x') {
  const parts = [];
  for (let p = coefs.length - 1; p >= 0; p--) {
    const c = coefs[p];
    if (isZero(c)) continue;
    const isFirst = p === coefs.length - 1;
    const sign = c < 0 ? '-' : (isFirst ? '' : '+');
    const absC = Math.abs(c);
    let str;
    if (p === 0) str = `${sign}${fmtNum(absC)}`;
    else {
      const cStr = Math.abs(absC - 1) < 1e-9 ? '' : fmtNum(absC);
      str = `${sign}${cStr}${varName}${p > 1 ? `^{${p}}` : ''}`;
    }
    parts.push(str);
  }
  return parts.join(' ') || '0';
}

function evalPoly(coefs, x) {
  let sum = 0;
  for (let i = coefs.length - 1; i >= 0; i--) sum = sum * x + coefs[i];
  return sum;
}

function deriveCoefs(coefs) {
  const out = [];
  for (let p = 1; p < coefs.length; p++) out[p - 1] = coefs[p] * p;
  while (out.length && isZero(out[out.length - 1])) out.pop();
  return out.length ? out : [0];
}

function integrateCoefs(coefs) {
  const out = [0];
  for (let p = 0; p < coefs.length; p++) out[p + 1] = coefs[p] / (p + 1);
  return out;
}

/** 综合除法: 多项式(升幂) ÷ (x-a)，返回商(升幂)与余数 */
function syntheticDivide(coefsAsc, a) {
  const work = coefsAsc.slice().reverse();
  const b = new Array(work.length).fill(0);
  b[0] = work[0];
  for (let i = 1; i < work.length; i++) b[i] = work[i] + a * b[i - 1];
  const rem = b[b.length - 1];
  return { quotientAsc: b.slice(0, -1).reverse(), rem };
}

// ---------- 题型求解 ----------

/** 解一元二次方程: ax²+bx+c=0 */
function solveQuadratic(a, b, c, steps, tex) {
  if (isZero(a)) {
    if (isZero(b) && !isZero(c)) return null;
    if (!isZero(b)) {
      const root = -c / b;
      steps.push(`这是一元一次方程：$${fmtNum(b)}${tex}${c !== 0 ? (c > 0 ? ' + ' + fmtNum(c) : ' - ' + fmtNum(-c)) : ''} = 0$$`);
      steps.push(`移项得 $${tex} = \\frac{${c > 0 ? '-' + fmtNum(c) : fmtNum(-c)}}{${fmtNum(b)}}$`);
      steps.push(`解得答案 $${tex} = ${fmtNum(root)}$`);
      return { answer: `${tex} = ${fmtNum(root)}`, steps };
    }
    return { answer: '恒等式，任意实数均为解', steps };
  }
  const delta = b * b - 4 * a * c;
  steps.push(`已知二次方程系数 $a = ${fmtNum(a)},\\; b = ${fmtNum(b)},\\; c = ${fmtNum(c)}$`);
  steps.push(`判别式 $\\Delta = b^2 - 4ac = ${fmtNum(b)}^2 - 4 \\times ${fmtNum(a)} \\times ${fmtNum(c)} = ${fmtNum(delta)}$`);
  if (delta < -1e-12) {
    steps.push(`由于 $\\Delta < 0$，方程**无实数解**（存在一对共轭复根）`);
    return { answer: '无实数解', steps, noReal: true };
  }
  if (isZero(delta)) {
    const root = -b / (2 * a);
    steps.push(`$\\Delta = 0$，方程有唯一实数根`);
    steps.push(`$x = -\\frac{b}{2a} = -\\frac{${fmtNum(b)}}{2 \\times ${fmtNum(a)}} = ${fmtNum(root)}$`);
    return { answer: `x = ${fmtNum(root)}`, steps };
  }
  const sq = Math.sqrt(delta);
  const r1 = (-b + sq) / (2 * a);
  const r2 = (-b - sq) / (2 * a);
  steps.push(`$\\Delta > 0$，方程有两个不相等的实数根`);
  steps.push(`$x_{1,2} = \\frac{-b \\pm \\sqrt{\\Delta}}{2a} = \\frac{${fmtNum(-b)} \\pm \\sqrt{${fmtNum(delta)}}}{2 \\times ${fmtNum(a)}}$`);
  steps.push(`化简得答案 $x_1 = ${fmtNum(r1)},\\; x_2 = ${fmtNum(r2)}$`);
  return { answer: `x_1 = ${fmtNum(r1)}, x_2 = ${fmtNum(r2)}`, steps };
}

/** 求解极限: lim(x→a) 多项式 或 多项式之商(支持 0/0 约分) */
function solveLimit(question, steps) {
  // 提取 x->a
  const lm = question.match(/lim\s*[_(]?\s*x\s*(?:->|→)?\s*(-?\d+(?:\.\d+)?)\s*[)_]?/);
  if (!lm) return null;
  const a = parseFloat(lm[1]);
  // 提取表达式: 取 lim 之后的内容（跳过 (x->a)），优先带括号的分式或多项式
  const rest = question.slice(question.indexOf('lim') + lm[0].length);
  let exprStr = '';
  const fracMatch = rest.match(/\(([^()]*)\)\s*\/\s*\(([^()]*)\)/);
  if (fracMatch) exprStr = `${fracMatch[1]}/${fracMatch[2]}`;
  else {
    const paren = rest.match(/\(([^()]*)\)/);
    if (paren && /[0-9x]/.test(paren[1])) exprStr = paren[1];
    else if (rest) {
      const polyOnly = rest.match(/([+-]?[\d./]*x(?:\^?\d+)?)(?:[+-][\d./]*x(?:\^?\d+)?)*([+-][\d./]+)?/);
      if (polyOnly && polyOnly[0]) exprStr = polyOnly[0];
    }
  }
  if (!exprStr) return null;

  const isFrac = exprStr.includes('/');
  let numCoefs, denCoefs = null;
  if (isFrac) {
    const [n, d] = exprStr.split('/');
    numCoefs = parsePolynomial(n);
    denCoefs = parsePolynomial(d);
    if (!numCoefs || !denCoefs) return null;
    steps.push(`题目为分式极限，先代入 $x = ${fmtNum(a)}$ 检验分母是否为 0`);
    const nv = evalPoly(numCoefs, a), dv = evalPoly(denCoefs, a);
    if (!isZero(dv)) {
      steps.push(`代入得 $\\frac{${fmtNum(nv)}}{${fmtNum(dv)}}$`);
      steps.push(`由连续函数代入法得答案 $\\lim = ${fmtNum(nv / dv)}$`);
      return { answer: fmtNum(nv / dv), steps };
    }
    if (!isZero(nv)) {
      steps.push(`分子 $=${fmtNum(nv)}$ 不为 0 而分母为 0，极限不存在（趋于无穷）`);
      return { answer: '极限不存在（发散）', steps };
    }
    steps.push(`分子、分母均为 0，是 $\\frac{0}{0}$ 型，对分子分母因式分解（约去公因式 $(x - ${fmtNum(a)})$）：`);
    const qn = syntheticDivide(numCoefs, a), qd = syntheticDivide(denCoefs, a);
    if (isZero(qn.rem) && isZero(qd.rem)) {
      const qnT = polyToLatex(qn.quotientAsc), qdT = polyToLatex(qd.quotientAsc);
      steps.push(`原式 $= \\frac{${qnT}}{${qdT}}$，消去公因式 $(x - ${fmtNum(a)})$`);
      const rv = evalPoly(qn.quotientAsc, a) / evalPoly(qd.quotientAsc, a);
      steps.push(`再代入 $x = ${fmtNum(a)}$ 得答案 $= ${fmtNum(rv)}$`);
      return { answer: fmtNum(rv), steps };
    }
    steps.push('约分后仍无法直接代入，无法用基础方法求解');
    return null;
  }

  const coefs = parsePolynomial(exprStr);
  if (!coefs) return null;
  steps.push(`直接代入 $x = ${fmtNum(a)}$：`);
  const v = evalPoly(coefs, a);
  steps.push(`$f(${fmtNum(a)}) = ${polyToLatex(coefs)} \\Big|_{x=${fmtNum(a)}} = ${fmtNum(v)}$`);
  steps.push(`由多项式极限的代入法，得答案 $\\lim = ${fmtNum(v)}$`);
  return { answer: fmtNum(v), steps };
}

/** 求导: f(x) = 多项式 */
function solveDerivative(question, steps) {
  const m = question.match(/f\s*\(\s*x\s*\)\s*=\s*((?:[+-]?[\d./]*x(?:\^\d+)?)(?:[+-][\d./]*x(?:\^\d+)?)*(?:[+-][\d./]+)?)/);
  if (!m) return null;
  const coefs = parsePolynomial(m[1]);
  if (!coefs) return null;
  steps.push(`对 $f(x) = ${polyToLatex(coefs)}$ 逐项求导（幂函数求导法则 $(x^n)' = n x^{n-1}$）：`);
  const d = deriveCoefs(coefs);
  if (d.length === 1 && isZero(d[0])) {
    steps.push('常数求导为 0');
    steps.push('答案 $f\'(x) = 0$');
    return { answer: "f'(x) = 0", steps };
  }
  const dt = polyToLatex(d);
  steps.push(`逐项求导得 $f'(x) = ${dt}$`);
  steps.push(`答案 $f'(x) = ${dt}$`);
  return { answer: `f'(x) = ${dt}`, steps };
}

/** 积分: ∫ 多项式 dx */
function solveIntegral(question, steps) {
  const q2 = String(question || '').replace(/\s+/g, '');
  // 安全护栏：带显式上下限的定积分（\int_0^1、∫_0^1 等）→ 交给 AI 完整流程+数值校验
  if (/\\int[_^{\\]*\{?\s*[+-]?\d|\b∫[_^{\\]*\{?\s*[+-]?\d/.test(q2)) return null;
  // 安全护栏：被积函数含超越函数（e^x、sin、cos、tan、ln、log、sqrt 等）或分式 → 引擎多项式积分不接管
  if (/e\s*\\?\^|\\?\b(sin|cos|tan|cot|sec|csc|ln|log|exp|arctan|arcsin|arccos)\b|\\sqrt/.test(q2)) return null;

  let exprStr = null;
  const intMatch = question.match(/\\int|∫/);
  if (intMatch) {
    const rest = question.slice(intMatch.index + 1);
    const m = rest.match(/\(([^()]*)\)\s*d\s*x|([+-]?[\d./]*x(?:\^?\d+)?)(?:[+-][\d./]*x(?:\^?\d+)?)*([+-][\d./]+)?\s*d\s*x/);
    if (m) exprStr = (m[1] || m[2] || '').replace(/dx$/, '');
  }
  if (!exprStr) {
    const explicit = question.match(/积分|求原函数/);
    if (!explicit) return null;
    const m = question.match(/([+-]?[\d./]*x(?:\^\d+)?(?:[+-][\d./]*x(?:\^\d+)?)*[+-][\d./]+)/);
    if (m) exprStr = m[1];
  }
  if (!exprStr) return null;
  const coefs = parsePolynomial(exprStr);
  if (!coefs) return null;
  steps.push(`对 $f(x) = ${polyToLatex(coefs)}$ 逐项积分（幂函数积分公式 $\\int x^n dx = \\frac{x^{n+1}}{n+1}$）：`);
  const it = integrateCoefs(coefs);
  const dt = polyToLatex(it);
  steps.push(`逐项积分得 $\\int ${polyToLatex(coefs)} \\, dx = ${dt} + C$`);
  steps.push(`答案 $\\int ${polyToLatex(coefs)} \\, dx = ${dt} + C$（$C$ 为任意常数）`);
  return { answer: `${dt.replace(/^0\s*/, '') || '0'} + C`, steps };
}

/** 有理函数积分（部分分式法）:
 *  ∫ dx / [(x+d1)(x+d2)]   —— 线性×线性
 *  ∫ dx / [(x+d)(x²+bx+c)] —— 线性×不可约二次（Δ<0）
 *  OCR 文本可能丢失分子/dx，宽容匹配分母因子乘积即可
 */
function solveRationalIntegral(question, steps) {
  if (!/\\int|∫|积分|原函数/.test(question)) return null;

  // 统一符号：全角括号→半角、x²→x^2、去空格
  const q = question.replace(/[（]/g, '(').replace(/[）]/g, ')')
                    .replace(/²/g, '^2').replace(/／/g, '/')
                    .replace(/\s+/g, '');
  // 提取分母乘积: (x+d)(x^2+bx+c) 或 (x+d1)(x+d2)
  const m = q.match(/\(\s*x\s*([+-]\d+)\s*\)\s*\(\s*x\s*\^\s*2\s*([+-]\d+)\s*x\s*([+-]\d+)\s*\)|\(\s*x\s*([+-]\d+)\s*\)\s*\(\s*x\s*([+-]\d+)\s*\)/);
  if (!m) return null;

  const sp = v => (v >= 0 ? '+' : '-') + ' ' + fmtNum(Math.abs(v)); // "± n"

  // 情况一：线性 × 不可约二次
  if (m[1] !== undefined) {
    const d = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    const c = parseFloat(m[3]);
    const disc = b * b - 4 * c;
    if (disc >= 0) return null;

    const denom = c + d * d - b * d;
    if (Math.abs(denom) < 1e-12) return null;
    const A = 1 / denom;
    const B = -A;
    const C = A * (d - b);

    steps.push(`识别为有理函数积分：$\\int \\frac{dx}{(x ${sp(d)})(x^2 ${sp(b)}x ${sp(c)})}$，其中 $x^2 ${sp(b)}x ${sp(c)}$ 判别式 $\\Delta = b^2 - 4c = ${fmtNum(disc)} < 0$，不可再分解`);
    steps.push('用部分分式法分解：');
    steps.push(`设 $\\frac{1}{(x ${sp(d)})(x^2 ${sp(b)}x ${sp(c)})} = \\frac{A}{x ${sp(d)}} + \\frac{Bx + C}{x^2 ${sp(b)}x ${sp(c)}}$`);
    steps.push(`通分比较系数解得 $A = ${fmtNum(A)},\\; B = ${fmtNum(B)},\\; C = ${fmtNum(C)}$`);
    steps.push(`于是 $\\int \\frac{dx}{(x ${sp(d)})(x^2 ${sp(b)}x ${sp(c)})} = ${fmtNum(A)} \\int \\frac{dx}{x ${sp(d)}} + \\int \\frac{${fmtNum(B)}x ${sp(C)}}{x^2 ${sp(b)}x ${sp(c)}} dx$`);

    const b2 = b / 2;
    const k2 = c - b * b / 4;
    const k = Math.sqrt(k2);
    const coeffArctan = (C - B * b2) / k;
    const coeffLn = B / 2;

    steps.push(`第一部分：$${fmtNum(A)} \\ln|x ${sp(d)}|$`);
    steps.push(`第二部分配方：$x^2 ${sp(b)}x ${sp(c)} = (x ${sp(b2)})^2 + (${fmtNum(k)})^2$，令 $u = x ${sp(b2)}$`);
    steps.push(`$\\int \\frac{${fmtNum(B)}x ${sp(C)}}{x^2 ${sp(b)}x ${sp(c)}} dx = ${fmtNum(coeffLn)} \\ln(x^2 ${sp(b)}x ${sp(c)}) + ${fmtNum(coeffArctan)} \\arctan(\\frac{x ${sp(b2)}}{${fmtNum(k)}})$`);

    const ans = `${fmtNum(A)} \\ln|x ${sp(d)}| ${coeffLn >= 0 ? '+' : ''}${fmtNum(coeffLn)} \\ln(x^2 ${sp(b)}x ${sp(c)}) ${coeffArctan >= 0 ? '+' : ''}${fmtNum(coeffArctan)} \\arctan(\\frac{x ${sp(b2)}}{${fmtNum(k)}}) + C`;
    steps.push(`答案：$\\int \\frac{dx}{(x ${sp(d)})(x^2 ${sp(b)}x ${sp(c)})} = ${ans}$（$C$ 为任意常数）`);
    return { answer: ans, steps };
  }

  // 情况二：线性 × 线性
  if (m[4] !== undefined) {
    const d1 = parseFloat(m[4]);
    const d2 = parseFloat(m[5]);
    if (Math.abs(d2 - d1) < 1e-12) {
      steps.push('分母为完全平方，属重根情形，暂不支持');
      return null;
    }
    const A = 1 / (d2 - d1);
    const Other = -A;
    steps.push(`识别为有理函数积分：$\\int \\frac{dx}{(x ${sp(d1)})(x ${sp(d2)})}$`);
    steps.push(`部分分式：$\\frac{1}{(x ${sp(d1)})(x ${sp(d2)})} = \\frac{A}{x ${sp(d1)}} + \\frac{B}{x ${sp(d2)}}$`);
    steps.push(`比较系数得 $A = \\frac{1}{${fmtNum(d2 - d1)}} = ${fmtNum(A)},\\; B = ${fmtNum(Other)}$`);
    steps.push(`$\\int \\frac{dx}{(x ${sp(d1)})(x ${sp(d2)})} = ${fmtNum(A)} \\ln|x ${sp(d1)}| ${Other >= 0 ? '+' : ''}${fmtNum(Other)} \\ln|x ${sp(d2)}| + C$`);
    const ans = `${fmtNum(A)} \\ln|x ${sp(d1)}| ${Other >= 0 ? '+' : ''}${fmtNum(Other)} \\ln|x ${sp(d2)}| + C`;
    steps.push(`也可合并为 $\\ln\\left|\\frac{x ${sp(d1)}}{x ${sp(d2)}}\\right|^{${fmtNum(A)}} + C$`);
    return { answer: ans, steps };
  }
  return null;
}

/** 等差/等比数列 */
function solveSequence(question, steps) {
  const isArith = /算术|等差|arithmetic/i.test(question);
  const isGeo = /等比|geometric/i.test(question);
  if (!isArith && !isGeo) return null;
  const a1 = question.match(/a\s*_?\s*1\s*=\s*(-?\d+(?:\.\d+)?)/);
  const d = question.match(/(?:公差|d)\s*(?:=|:)\s*(-?\d+(?:\.\d+)?)/);
  const q = question.match(/(?:公比|q)\s*(?:=|:)\s*(-?\d+(?:\.\d+)?)/);
  const n = question.match(/(?:第\s*)?n\s*=\s*(\d+)/) || question.match(/求\s*(?:第\s*)?(\d+)\s*项/);
  if (!a1) return null;
  const a1v = parseFloat(a1[1]);
  const nv = n ? parseInt(n[1], 10) : null;
  let answer = '';
  if (isArith) {
    if (d) {
      const dv = parseFloat(d[1]);
      steps.push(`已知等差数列 $a_1 = ${fmtNum(a1v)}$，公差 $d = ${fmtNum(dv)}$`);
      if (nv) {
        const an = a1v + (nv - 1) * dv;
        steps.push(`通项公式 $a_n = a_1 + (n-1)d$`);
        steps.push(`$a_{${nv}} = ${fmtNum(a1v)} + (${nv} - 1) \\times ${fmtNum(dv)} = ${fmtNum(an)}$`);
        const sn = nv * (a1v + an) / 2;
        steps.push(`前 $n$ 项和 $S_n = \\frac{n(a_1 + a_n)}{2}$，$S_{${nv}} = ${fmtNum(sn)}$`);
        answer = `a_${nv} = ${fmtNum(an)}, S_${nv} = ${fmtNum(sn)}`;
      } else {
        steps.push(`通项公式 $a_n = ${fmtNum(a1v)} + (n-1) \\times ${fmtNum(dv)}$`);
        steps.push(`答案 $a_n = ${fmtNum(dv)}n ${a1v - dv >= 0 ? '+' + fmtNum(a1v - dv) : '-' + fmtNum(Math.abs(a1v - dv))}$`);
        answer = `a_n = ${fmtNum(dv)}n + ${fmtNum(a1v - dv)}`;
      }
      return { answer, steps };
    }
  } else if (isGeo) {
    if (q) {
      const qv = parseFloat(q[1]);
      steps.push(`已知等比数列 $a_1 = ${fmtNum(a1v)}$，公比 $q = ${fmtNum(qv)}$`);
      if (nv) {
        const an = a1v * Math.pow(qv, nv - 1);
        steps.push(`通项公式 $a_n = a_1 q^{n-1}$`);
        steps.push(`$a_{${nv}} = ${fmtNum(a1v)} \\times ${fmtNum(qv)}^{${nv - 1}} = ${fmtNum(an)}$`);
        const sn = qv === 1 ? nv * a1v : a1v * (1 - Math.pow(qv, nv)) / (1 - qv);
        steps.push(`前 $n$ 项和 $S_n = a_1\\frac{1 - q^n}{1 - q}$，$S_{${nv}} = ${fmtNum(sn)}$`);
        answer = `a_${nv} = ${fmtNum(an)}, S_${nv} = ${fmtNum(sn)}`;
      } else {
        steps.push(`通项公式 $a_n = ${fmtNum(a1v)} \\cdot ${fmtNum(qv)}^{n-1}$`);
        answer = `a_n = ${fmtNum(a1v)} · ${fmtNum(qv)}^{n-1}`;
      }
      return { answer, steps };
    }
  }
  return null;
}

/** 安全计算器: 仅数字四则与幂 */
function solveArithmetic(question, steps) {
  // 提取 "计算 ..." 或 "求值: ..."
  const m = question.match(/(?:计算|求值|化简|求)\s*[:：]?\s*([0-9+\-*/^(). ]+)/);
  if (!m) return null;
  const expr = m[1].replace(/\^/g, '**');
  if (!/^[0-9+\-*/**(). ]+$/.test(expr) || !/\d/.test(expr)) return null;
  try {
    const val = Function(`"use strict"; return (${expr});`)();
    if (typeof val !== 'number' || !isFinite(val)) return null;
    steps.push(`计算表达式：$${m[1]}$`);
    steps.push(`按四则运算法则计算，得答案 $= ${fmtNum(val)}$`);
    return { answer: fmtNum(val), steps };
  } catch (e) { return null; }
}

// ---------- 主入口 ----------

function solve(question) {
  const q = normalize(question);
  if (!q) return { canSolve: false };
  let steps = [];
  let type = '';

  // 1. 方程（一次/二次）
  const eqParts = q.split('=');
  if (eqParts.length >= 2) {
    // 剥离前导引导词（如 "solve:"、"求方程" 等），只保留多项式片段
    const stripLeading = s => s.replace(/^[^0-9x(+\-]*/, '').replace(/[\s]+/g, '');
    const lhs = stripLeading(eqParts[0]);
    const rhs = stripLeading(eqParts.slice(1).join('='));
    if (/[0-9]/.test(lhs + rhs) && /x/.test(lhs + rhs)) {
      const lc = parsePolynomial(lhs), rc = parsePolynomial(rhs);
      if (lc && rc) {
        const deg = Math.max(lc.length, rc.length) - 1;
        const comb = new Array(deg + 1).fill(0);
        for (let i = 0; i < comb.length; i++) comb[i] = (lc[i] || 0) - (rc[i] || 0);
        if (deg === 1 || deg === 2) {
          while (comb.length > 1 && isZero(comb[comb.length - 1])) comb.pop();
          // 按次数取系数: comb 为升幂 [c0, c1, ...]
          let a, b, c;
          if (deg === 2) { a = comb[2] || 0; b = comb[1] || 0; c = comb[0] || 0; }
          else { a = 0; b = comb[1] || 0; c = comb[0] || 0; }
          const t = polyToLatex(comb);
          steps.push(`识别到方程，移项整理得 $${t} = 0$`);
          const result = solveQuadratic(a, b, c, steps, 'x');
          if (result) return { canSolve: true, type: '一元' + (deg === 1 ? '一次' : '二次') + '方程', answer: result.answer, steps: result.steps };
        }
      }
    }
  }

  // 2. 极限
  steps = [];
  if (/lim/.test(q) && /->/.test(q)) {
    const r = solveLimit(q, steps);
    if (r) return { canSolve: true, type: '极限', answer: r.answer, steps: r.steps };
  }

  // 3. 导数 / 函数求值
  steps = [];
  if (/f\s*\(\s*x\s*\)\s*=/.test(q) && !/lim|=\s*0/.test(q)) {
    // 先尝试 f(a) 代入求值
    const evalAt = q.match(/f\s*\(\s*(-?\d+(?:\.\d+)?|\d+\/\d+)\s*\)/);
    if (evalAt && !/导|deriv|prime/i.test(q)) {
      const fx = q.match(/f\s*\(\s*x\s*\)\s*=\s*([^;，,。]+)/);
      const coefs = fx ? parsePolynomial(fx[1]) : null;
      if (coefs) {
        const av = evalAt[1].includes('/') ? evalAt[1].split('/').reduce((a, b) => a / b, 1) : parseFloat(evalAt[1]);
        const v = evalPoly(coefs, av);
        steps.push(`代入 $x = ${fmtNum(av)}$ 到 $f(x) = ${polyToLatex(coefs)}$`);
        steps.push(`$f(${fmtNum(av)}) = ${polyToLatex(coefs, '') ? polyToLatex(coefs).replaceAll('x', `(${fmtNum(av)})`) : fmtNum(v)}$`);
        steps.push(`计算得答案 $f(${fmtNum(av)}) = ${fmtNum(v)}$`);
        return { canSolve: true, type: '函数求值', answer: `f(${fmtNum(av)}) = ${fmtNum(v)}`, steps };
      }
    }
    const r = solveDerivative(q, steps);
    if (r) return { canSolve: true, type: '求导', answer: r.answer, steps: r.steps };
  }

  // 4. 积分（有理函数部分分式优先）
  steps = [];
  if (/\\int|∫|积分|原函数/.test(q)) {
    const r1 = solveRationalIntegral(q, steps);
    if (r1) return { canSolve: true, type: '有理函数积分（部分分式法）', answer: r1.answer, steps: r1.steps };
    const r2 = solveIntegral(q, steps);
    if (r2) return { canSolve: true, type: '积分', answer: r2.answer, steps: r2.steps };
  }

  // 5. 数列
  steps = [];
  if (/等差|等比/.test(q)) {
    const r = solveSequence(q, steps);
    if (r) return { canSolve: true, type: '数列', answer: r.answer, steps: r.steps };
  }

  // 6. 简单计算
  steps = [];
  if (/计算|求值|化简|求\s*:/.test(q)) {
    const r = solveArithmetic(q, steps);
    if (r) return { canSolve: true, type: '数值计算', answer: r.answer, steps: r.steps };
  }

  return { canSolve: false };
}

module.exports = { solve, normalize, parsePolynomial, polyToLatex, evalPoly };