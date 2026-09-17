# -*- coding: utf-8 -*-
"""
ocr_service.py — PaddleOCR 识别服务（由 Node 后端 spawn 调用）
用法:
  python ocr_service.py <image_path>            # 常规识别
  python ocr_service.py <image_path> --enhanced # 图像增强后识别（低质量兜底）
输出: JSON {ok, lines:[{text,conf}], text, quality:{avgConf, chars, score}}
"""
import sys, io, json, re, os

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# ---- UI 文案黑名单（截图干扰过滤）----
UI_BLACKLIST = [
    '一键填充', '自动归类', '识别完成', '重新拍摄', 'OCR识别出的题目',
    '等待识别', '上传中', '识别中', '科目：', '题型：', '难度:',
    '科目*', '拍照或上传', '支持手机拍照', '登录', '退出登录',
    '错题列表', '添加错题', '统计看板', '考研错题本',
    '识别失败', '识别引擎', '本地识别', '答案与过程', '智能解题',
    '正确答案', '解题过程', '识别题目', '公式归一化',
]

def ui_noise(text):
    t = text.replace(' ', '').replace('-', '一').replace('—', '一')
    for kw in UI_BLACKLIST:
        k = kw.replace(' ', '')
        if k in t or t in k:
            return True
    return False

# ---- 数学符号映射 ----
def map_symbols(text):
    t = text
    # 积分号: OCR 常把 ∫ 识别为 Jo / J0 / Js / 1o 等，行首出现时替换
    t = re.sub(r'^\s*(?:Jo|jo|J0|1o|l0|了o|Js|々o|JI|J)\s*', '∫ ', t)
    t = t.replace('，', ', ').replace('。', '. ')
    if re.fullmatch(r'[-_=—一]{2,}', t.strip()):
        return '/'
    t = re.sub(r'[一—]{1,2}', '-', t)
    t = re.sub(r'(?<!\w)x\s*2(?!\d)', 'x^2', t)
    # 常见 OCR 混淆修正（仅当独立成词时）
    t = re.sub(r'\bO\b', '0', t)
    return t

def build_lines(result):
    rows = []
    for page in result:
        for line in page or []:
            box, (text, conf) = line
            xs = [p[0] for p in box]; ys = [p[1] for p in box]
            rows.append({'text': text, 'conf': round(float(conf), 3),
                         'x': round(min(xs)), 'y': round(min(ys)),
                         'h': round(max(ys) - min(ys))})
    if not rows:
        return []
    rows.sort(key=lambda r: (r['y'], r['x']))
    bands = []
    for r in rows:
        placed = False
        for b in bands:
            if abs(b['y'] - r['y']) <= max(14, r['h'] * 0.8):
                b['items'].append(r)
                b['y'] = min(b['y'], r['y'])
                placed = True
                break
        if not placed:
            bands.append({'y': r['y'], 'items': [r]})
    lines = []
    for b in bands:
        items = sorted(b['items'], key=lambda i: i['x'])
        text = ''.join(i['text'] for i in items)
        conf = min(i['conf'] for i in items)
        lines.append({'text': text, 'conf': conf, 'y': b['y'], 'x': min(i['x'] for i in items)})
    lines.sort(key=lambda l: l['y'])
    return lines

def postprocess(lines):
    out = []
    for l in lines:
        t = l['text'].strip()
        if not t:
            continue
        if ui_noise(t):
            continue
        if l['conf'] < 0.35:
            continue
        out.append({'text': map_symbols(t), 'conf': l['conf']})
    return out

def assess_quality(lines):
    """质量评分 0-100：平均置信度 + 文本密度 + 有效字符占比"""
    if not lines:
        return {'avgConf': 0, 'chars': 0, 'score': 0}
    avg_conf = sum(l['conf'] for l in lines) / len(lines)
    chars = sum(len(l['text']) for l in lines)
    # 有效字符：汉字/数字/字母/数学符号
    valid = 0
    for l in lines:
        valid += len(re.findall(r'[\u4e00-\u9fa5A-Za-z0-9+\-*/^=()∫√≥≤π.，,\s]', l['text']))
    ratio = valid / max(chars, 1)
    score = int(avg_conf * 55 + min(chars / 8, 15) + ratio * 30)
    return {'avgConf': round(avg_conf, 3), 'chars': chars, 'score': min(score, 100)}

def enhance_image(src, dst, for_paddle=True):
    """图像增强: 放大 + 灰度 + CLAHE + 锐化
    - for_paddle=True: 强二值化（适合 PaddleOCR 线性识别）
    - for_paddle=False: 保留连续灰阶（适合 AI 视觉模型理解）"""
    import cv2
    img = cv2.imread(src, cv2.IMREAD_COLOR)
    if img is None:
        return False
    # 放大（长边目标 ~1600px，AI 视觉对分辨率适度更友好）
    h, w = img.shape[:2]
    target = 1000 if for_paddle else 1600
    scale = min(2.0, target / max(h, w))
    if scale > 1.02:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if gray.mean() > 200:          # 若整体过亮(白字白纸)风险，先取反突出内容
        gray = 255 - gray
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blur = cv2.GaussianBlur(enhanced, (0, 0), 3)
    enhanced = cv2.addWeighted(enhanced, 1.5, blur, -0.5, 0)
    if for_paddle:
        binary = cv2.adaptiveThreshold(enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                       cv2.THRESH_BINARY_INV, 31, 11)
        if binary.mean() < 127:
            binary = cv2.bitwise_not(binary)
        cv2.imwrite(dst, binary)
    else:
        cv2.imwrite(dst, enhanced)
    return True

def run_ocr(ocr, img):
    res = ocr.ocr(img, cls=True)
    lines = build_lines(res)
    cleaned = postprocess(lines)
    return cleaned

def main():
    img = sys.argv[1]

    if '--enhance-only' in sys.argv:
        # 仅输出 AI 用增强图（保留灰阶），不跑 PaddleOCR
        try:
            dst = None
            for a in sys.argv:
                if a.startswith('--out='):
                    dst = a[len('--out='):]
            if not dst:
                dst = img + '.enh.png'
            ok = enhance_image(img, dst, for_paddle=False)
            print(json.dumps({'ok': ok, 'path': dst}))
        except Exception as e:
            print(json.dumps({'ok': False, 'error': str(e)}))
        return

    enhanced = '--enhanced' in sys.argv
    try:
        from paddleocr import PaddleOCR
        ocr = PaddleOCR(use_angle_cls=True, lang='ch', show_log=False)

        cleaned = run_ocr(ocr, img)

        # 低质量自动增强二次识别
        if not enhanced and '--no-retry' not in sys.argv:
            q = assess_quality(cleaned)
            if q['score'] < 50:
                tmp = img + '.enh.png'
                if enhance_image(img, tmp):
                    retry = run_ocr(ocr, tmp)
                    q2 = assess_quality(retry)
                    if q2['score'] > q['score']:
                        cleaned = retry
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass

        quality = assess_quality(cleaned)
        text = '\n'.join(l['text'] for l in cleaned)
        print(json.dumps({'ok': True, 'lines': cleaned, 'text': text, 'quality': quality}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))

if __name__ == '__main__':
    main()