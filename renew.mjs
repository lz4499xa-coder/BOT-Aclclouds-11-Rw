#!/usr/bin/env node
import { chromium } from 'playwright';
import Tesseract from 'tesseract.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const rawBase = (process.env.ACL_BASE_URL || '').trim();
const BASE = (rawBase || 'https://aclclouds.com').replace(/\/+$/, '');
const USER = (process.env.ACL_USERNAME || process.env.ACL_EMAIL || '').trim();
const PASS = process.env.ACL_PASSWORD || '';
const SERVER_ID = (process.env.ACL_SERVER_ID || '').trim();
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const AUTH = path.resolve(process.env.ACL_AUTH_STATE || 'auth.json');
const SHOT = path.resolve('shots');

const VOCAB = [
  'Panel', 'VPS', 'Bot', 'Serveur', 'Server', 'Cloud', 'ACLClouds',
  'Minecraft', 'Discord', 'Housing', 'Tunnel', 'Dedicated',
  'Free', 'Upgrade', 'Renew', 'Game', 'Node', 'Credit', 'Support',
  'Host', 'Hosting', 'Container', 'Project', 'Database', 'Backup', 'Web'
];

const OCR_MIN_SCORE = Math.max(30, Math.min(100, Number.parseInt(process.env.ACL_CAPTCHA_OCR_MIN_SCORE || '55', 10)));
const CAPTCHA_MAX_ATTEMPTS = Math.max(1, Math.min(6, Number.parseInt(process.env.ACL_CAPTCHA_MAX_ATTEMPTS || '4', 10)));

fs.mkdirSync(SHOT, { recursive: true });
const shots = [];

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isShortServerId(id) {
  return /^[a-f0-9]{8}$/i.test(String(id || '').trim());
}

function isHostingSubId(id) {
  return /^hosting-/i.test(String(id || '').trim());
}

function score(a, b) {
  a = norm(a);
  b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 82;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  const maxLen = Math.max(a.length, b.length);
  const ratioScore = Math.round((1 - dp[a.length][b.length] / maxLen) * 100);
  const fixedScore = 100 - dp[a.length][b.length] * 25;
  return Math.max(0, ratioScore, fixedScore);
}

function ocrScore(text, guess, prompt) {
  return Math.max(score(text, prompt), score(guess, prompt));
}

function decodeCaptchaOption(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function pickByOptionText(prompt, options = []) {
  const ranked = options
    .map((raw, i) => {
      const text = decodeCaptchaOption(raw);
      return { i, raw, text, s: score(text, prompt) };
    })
    .sort((a, b) => b.s - a.s);

  if (!ranked.length) return null;
  const top = ranked[0];
  const second = ranked[1]?.s ?? -1;
  const hasStrongMatch = top.s >= 80;
  const hasClearLead = top.s >= 65 && top.s - second >= 15;

  if (hasStrongMatch || hasClearLead) {
    return top;
  }
  return null;
}

async function shot(page, name) {
  try {
    const p = path.join(SHOT, name);
    await page.screenshot({ path: p, fullPage: true });
    shots.push(p);
    log('截图 ' + name);
    return p;
  } catch (e) {
    log('截图失败 ' + name + ': ' + e.message);
    return null;
  }
}

async function sendTgPhoto(chat, token, photoPath, caption) {
  token = String(token || '').trim();
  chat = String(chat || '').trim();
  if (!photoPath || !fs.existsSync(photoPath) || fs.statSync(photoPath).size < 100 || !token || !chat) return;
  try {
    const form = new FormData();
    form.append('chat_id', chat);
    form.append('photo', new Blob([fs.readFileSync(photoPath)], { type: 'image/png' }), path.basename(photoPath));
    if (caption) form.append('caption', caption);
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendPhoto', { method: 'POST', body: form });
    if (!r.ok) log('TG 图片发送失败 ' + path.basename(photoPath) + ': ' + (await r.text()));
    else log('TG 图片已发送: ' + path.basename(photoPath));
  } catch (e) {
    log('TG 图片发送异常: ' + e.message);
  }
}

async function tg(text, { photo = null } = {}) {
  const token = String(process.env.TG_BOT_TOKEN || '').trim();
  const chat = String(process.env.TG_CHAT_ID || '').trim();
  if (!token || !chat) {
    log('未配置 TG_BOT_TOKEN/TG_CHAT_ID,跳过通知');
    return;
  }
  try {
    const msg = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!msg.ok) {
      await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
      });
    }
    log('TG 文本已发送');
  } catch (e) {
    log('TG 发送异常 (非致命): ' + e.message);
  }

  if (photo) {
    await sendTgPhoto(chat, token, photo);
  }
}

function formatTgMessage({ failed, results = [], errorMsg = '' }) {
  const beijingTime = new Date().toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const hasRenewed = results.some((r) => r.ok && !r.skip);
  const allSkipped = results.length > 0 && results.every((r) => r.ok && r.skip);

  let title = '✅ <b>【ACLClouds 自动续期成功】</b>';
  let badge = '🎉 服务续期成功';
  if (failed) {
    title = '❌ <b>【ACLClouds 自动续期失败】</b>';
    badge = '⚠️ 续期任务异常';
  } else if (allSkipped) {
    title = '⏳ <b>【ACLClouds 续期检查 - 未到窗口】</b>';
    badge = 'ℹ️ 暂未到可续期时间';
  }

  const currentAccount = USER || '未设置';
  const lines = [
    title,
    '━━━━━━━━━━━━━━━━━━━━',
    '🕒 <b>执行时间</b>: ' + beijingTime + ' (北京时间)',
    '👤 <b>当前账号</b>: <code>' + currentAccount + '</code>',
    '📊 <b>任务状态</b>: ' + badge,
    '━━━━━━━━━━━━━━━━━━━━',
    '<b>服务详情</b>:',
  ];

  if (failed && errorMsg) {
    lines.push('• 异常原因: ' + errorMsg);
  }

  for (const r of results) {
    const icon = r.ok ? (r.skip ? '⏳' : '✅') : '❌';
    lines.push('• ' + icon + ' ' + r.text);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━');
  if (failed) {
    lines.push('⚠️ 请及时查看 GitHub Actions 运行日志与失败截图排查。');
  } else if (hasRenewed) {
    lines.push('✨ 服务已成功延期，将在下次预定周期继续自动守护。');
  } else {
    lines.push('📌 站点限制到期前开放续期，下次执行将自动处理。');
  }

  return lines.join('\n');
}

async function dismissCookieBanner(page) {
  try {
    const cookieBtn = page.locator("button:has-text('Accept all'), button:has-text('Reject all'), button:has-text('Tout accepter'), button:has-text('Tout refuser')").first();
    if (await cookieBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      log('关闭左下角 Cookie 弹窗...');
      await cookieBtn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  } catch {}
}

async function ocrPick(dir, prompt, n) {
  const worker = await Tesseract.createWorker('eng');
  await worker.setParameters({
    tessedit_pageseg_mode: '7',
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  });
  const results = [];
  for (let i = 0; i < n; i++) {
    const file = path.join(dir, i + '.png');
    const r = await worker.recognize(file);
    const text = (r.data.text || '').replace(/\s+/g, '').trim();
    const best = VOCAB.map((v) => ({ v, s: score(text, v) })).sort((p, q) => q.s - p.s)[0];
    results.push({ i, text, guess: best.v, vsPrompt: ocrScore(text, best.v, prompt) });
  }
  await worker.terminate();
  results.sort((a, b) => b.vsPrompt - a.vsPrompt);

  const summaryStr = results
    .map((x) => {
      const label = x.text ? x.text : x.guess;
      return x.i + ':' + label + '(' + x.vsPrompt + ')';
    })
    .join(' ');
  log('OCR prompt=' + prompt + ' ' + summaryStr);

  if (!results[0]) throw new Error('OCR 无结果: ' + prompt);
  if (results[0].vsPrompt < OCR_MIN_SCORE) {
    const secondScore = results[1]?.vsPrompt ?? 0;
    if (results[0].vsPrompt >= 40 && results[0].vsPrompt - secondScore >= 20) {
      log('OCR 分数(' + results[0].vsPrompt + ')低于阈值(' + OCR_MIN_SCORE + ')但明显领先,兜底选择 option ' + results[0].i);
      return results[0].i;
    }
    throw new Error('OCR 未匹配 ' + prompt + ' (阈值:' + OCR_MIN_SCORE + '): ' + JSON.stringify(results));
  }
  return results[0].i;
}

async function isCaptchaSolved(page, rootSelector = '') {
  return page.evaluate((rootSel) => {
    const scope = (rootSel && document.querySelector(rootSel)) || document;

    const roleCb = scope.querySelector("[role='checkbox']");
    if (roleCb && roleCb.getAttribute('aria-checked') === 'true') return true;

    const inputs = scope.querySelectorAll('input[name*="captcha"], input[name*="cap"], input[name*="token"]');
    for (const inp of inputs) {
      if (inp.value && inp.value.trim().length > 15) return true;
    }

    const capWidget = scope.querySelector('cap-widget, [data-cap], .cap-widget');
    if (capWidget) {
      if (capWidget.getAttribute('data-state') === 'verified' || capWidget.hasAttribute('verified')) return true;
      if (capWidget.value && String(capWidget.value).length > 10) return true;
      const sr = capWidget.shadowRoot;
      if (sr) {
        const srCb = sr.querySelector("[role='checkbox'], input[type='checkbox'], .checkbox, button");
        if (srCb && (srCb.getAttribute('aria-checked') === 'true' || srCb.checked === true || srCb.classList.contains('verified') || srCb.classList.contains('checked') || srCb.classList.contains('success'))) {
          return true;
        }
        const srText = (sr.textContent || '').toLowerCase();
        if (srText.includes('verified') || srText.includes('human verified') || srText.includes('vérifié')) {
          return true;
        }
      }
    }

    const allText = (scope.innerText || '').toLowerCase();
    if (allText.includes("you're human") === false && (allText.includes('verified') || allText.includes('vérifié'))) {
      return true;
    }
    return false;
  }, rootSelector).catch(() => false);
}

async function solveCaptcha(page, prefix = '', apiContext = 'login') {
  await dismissCookieBanner(page);
  const root = prefix ? prefix + ' ' : '';

  if (await isCaptchaSolved(page, prefix)) {
    log('验证码已处于通过状态');
    return null;
  }

  let clicked = false;
  const clickTargets = [
    page.locator(root + "text=/Verify you're human|Vérifiez que vous êtes humain/i").first(),
    page.locator(root + 'cap-widget').first(),
    page.locator(root + "div[role='checkbox']").first(),
    page.locator(root + "input[type='checkbox']").first(),
  ];

  for (const loc of clickTargets) {
    if (await loc.isVisible().catch(() => false)) {
      log('找到可见验证码组件，执行点击...');
      try {
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width > 100) {
          await page.mouse.click(box.x + 28, box.y + box.height / 2);
        } else {
          await loc.click({ timeout: 5000, force: true });
        }
        clicked = true;
        break;
      } catch (e) {
        log('常规点击验证码异常: ' + e.message);
      }
    }
  }

  await page.evaluate((rootSel) => {
    const scope = (rootSel && document.querySelector(rootSel)) || document;
    const cap = scope.querySelector('cap-widget');
    if (cap && cap.shadowRoot) {
      const btn = cap.shadowRoot.querySelector('input[type="checkbox"], [role="checkbox"], button, .checkbox, label');
      if (btn) btn.click();
    }
  }, prefix).catch(() => {});

  log('已触发验证码点击，等待 Cap 算力验证或图片加载...');

  const startTime = Date.now();
  let hasImgOptions = false;

  while (Date.now() - startTime < 12000) {
    if (await isCaptchaSolved(page, prefix)) {
      log('Cap / UI 验证码无感验证通过！');
      await page.waitForTimeout(800);
      return null;
    }

    const imgCount = await page.locator(root + '.auth-captcha-option-img').count().catch(() => 0);
    if (imgCount > 0 && await page.locator(root + '.auth-captcha-option-img').first().isVisible().catch(() => false)) {
      hasImgOptions = true;
      break;
    }
    await page.waitForTimeout(500);
  }

  if (hasImgOptions) {
    log('检测到传统图片验证码，启动 OCR 识别...');
    await page.waitForFunction(
      (sel) => {
        const imgs = [...document.querySelectorAll(sel)];
        return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0 && i.clientHeight > 0);
      },
      root + '.auth-captcha-option-img',
      { timeout: 15000 }
    );

    const promptRaw = await page.locator(root + '.auth-captcha-prompt').first().innerText();
    const prompt = promptRaw
      .replace(/^(?:Click on|Cliquez sur|Select|Choisissez)\s*(?:the|le|la|l')?\s*/i, '')
      .replace(/[.:!?\s]+$/, '')
      .trim();

    const imgs = page.locator(root + '.auth-captcha-option-img');
    const n = await imgs.count();
    const dir = path.join(SHOT, 'captcha');
    fs.mkdirSync(dir, { recursive: true });

    for (let i = 0; i < n; i++) {
      const src = await imgs.nth(i).getAttribute('src');
      const url = src.startsWith('http') ? src : BASE + (src.startsWith('/') ? '' : '/') + src;
      const bytes = await page.evaluate(async (u) => {
        const r = await fetch(u, { credentials: 'include' });
        return Array.from(new Uint8Array(await r.arrayBuffer()));
      }, url);
      fs.writeFileSync(path.join(dir, i + '.png'), Buffer.from(bytes));
    }

    await shot(page, '02-captcha.png');
    const pick = await ocrPick(dir, prompt, n);
    await page.locator(root + '.auth-captcha-option').nth(pick).evaluate((el) => el.click());

    await page.waitForTimeout(2000);
    log('图片验证码点击完成: ' + prompt + ' -> option ' + (pick + 1));
    return null;
  }

  log('尝试通过 API 求解验证码作为双保险 (context: ' + apiContext + ')...');
  try {
    const token = await solveCaptchaApi(page, apiContext);
    if (token) {
      await page.evaluate((tk) => {
        const names = ['captcha_token', 'captcha', 'token', 'cap-token', 'cf-turnstile-response'];
        const form = document.querySelector('form') || document.body;
        for (const name of names) {
          let inp = document.querySelector(`input[name="${name}"]`);
          if (!inp) {
            inp = document.createElement('input');
            inp.type = 'hidden';
            inp.name = name;
            form.appendChild(inp);
          }
          inp.value = tk;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, token);
      log('成功获取并注入 API 验证码 Token');
      return token;
    }
  } catch (e) {
    log('API 验证码兜底未返回 token (若 UI Cap 已点击成功可忽略): ' + e.message);
  }

  if (clicked) {
    log('已执行 UI 验证码点击，继续后续提交流程');
    return null;
  }

  throw new Error('未能定位或通过验证码');
}

async function solveCaptchaApi(page, context = 'renewal_gate') {
  log('通过 API 求解验证码 (context: ' + context + ')...');
  let lastErr = null;

  for (let attempt = 1; attempt <= CAPTCHA_MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        log('API 验证码重试 ' + attempt + '/' + CAPTCHA_MAX_ATTEMPTS);
      }

      const challengeRes = await api(page, '/auth/captcha/challenge?context=' + encodeURIComponent(context));
      if (challengeRes.status !== 200 || !challengeRes.data?.id) {
        throw new Error('获取验证码 challenge 失败: HTTP ' + challengeRes.status + ' ' + JSON.stringify(challengeRes.data));
      }
      const chal = challengeRes.data;
      await page.waitForTimeout(1300);

      const initialVerify = await api(page, '/auth/captcha', 'POST', {
        context: chal.context || context,
        id: chal.id,
        ts: chal.ts,
        sig: chal.sig,
        elapsed: 1450,
      });

      if (initialVerify.status !== 200) {
        throw new Error('验证码初始验证失败: HTTP ' + initialVerify.status + ' ' + JSON.stringify(initialVerify.data));
      }

      const ver = initialVerify.data;
      if (ver.passed && ver.token) {
        log('验证码无感直通成功');
        return ver.token;
      }

      if (!ver.interactive || !ver.target || !Array.isArray(ver.options)) {
        throw new Error('验证码返回非交互态: ' + JSON.stringify(ver));
      }

      const target = String(ver.target)
        .replace(/^(?:Click on|Cliquez sur|Select|Choisissez)\s*(?:the|le|la|l')?\s*/i, '')
        .trim();
      const options = ver.options;
      const directPick = pickByOptionText(target, options);
      let pick = -1;

      if (directPick) {
        pick = directPick.i;
        log('验证码命中文本选项: prompt=' + target + ' option=' + directPick.text + ' score=' + directPick.s);
      } else {
        const dir = path.join(SHOT, 'captcha_api');
        fs.mkdirSync(dir, { recursive: true });

        for (let i = 0; i < options.length; i++) {
          const optStr = String(options[i]);
          const imgUrl = optStr.startsWith('http')
            ? optStr
            : optStr.startsWith('/')
            ? BASE + optStr
            : BASE + '/auth/captcha/image?t=' + encodeURIComponent(optStr);

          const bytes = await page.evaluate(async (u) => {
            const r = await fetch(u, { credentials: 'include' });
            return Array.from(new Uint8Array(await r.arrayBuffer()));
          }, imgUrl);
          fs.writeFileSync(path.join(dir, i + '.png'), Buffer.from(bytes));
        }

        pick = await ocrPick(dir, target, options.length);
      }

      const selectedOption = options[pick];
      await page.waitForTimeout(800);

      const submitVerify = await api(page, '/auth/captcha', 'POST', {
        context: ver.context || context,
        id: ver.id,
        ts: ver.ts,
        sig: ver.sig,
        answer: selectedOption,
        answer_sig: ver.answer_sig || '',
        target: ver.target,
        elapsed: 2400,
      });

      if (submitVerify.status === 200 && submitVerify.data?.passed && submitVerify.data?.token) {
        log('API 验证码成功解决: ' + target + ' -> token 获得');
        return submitVerify.data.token;
      }

      throw new Error('API 验证码选项提交未通过: ' + JSON.stringify(submitVerify.data));
    } catch (e) {
      lastErr = e;
      log('API 验证码第 ' + attempt + ' 次失败: ' + e.message);
      if (attempt < CAPTCHA_MAX_ATTEMPTS) {
        await page.waitForTimeout(1500);
      }
    }
  }

  const lastMsg = lastErr ? lastErr.message : '未知错误';
  throw new Error('API 验证码连续失败 ' + CAPTCHA_MAX_ATTEMPTS + ' 次: ' + lastMsg);
}

async function api(page, p, method = 'GET', body, extraHeaders = {}) {
  const fullUrl = p.startsWith('http') ? p : BASE + (p.startsWith('/') ? '' : '/') + p;
  return page.evaluate(
    async ({ fullUrl, method, body, extraHeaders }) => {
      try {
        const token = document.cookie
          .split('; ')
          .find((c) => c.startsWith('XSRF-TOKEN='))
          ?.split('=')[1];
        const metaCsrf = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');

        const headers = {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...(token ? { 'X-XSRF-TOKEN': decodeURIComponent(token) } : {}),
          ...(metaCsrf && !token ? { 'X-CSRF-TOKEN': metaCsrf } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        };

        const res = await fetch(fullUrl, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          credentials: 'include',
        });
        const text = await res.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = text.slice(0, 400);
        }
        return { status: res.status, data };
      } catch (err) {
        return { status: 0, data: { error: err.message } };
      }
    },
    { fullUrl, method, body, extraHeaders }
  );
}

async function loggedIn(page) {
  if (/\/dashboard/i.test(page.url()) && !/\/auth\/login/i.test(page.url())) return true;
  const r = await api(page, '/api/client/account');
  if (r.status === 200 && (r.data?.object === 'user' || r.data?.attributes || r.data?.id || r.data?.username)) {
    return true;
  }
  const r2 = await api(page, '/api/client');
  return r2.status === 200 && typeof r2.data === 'object';
}

async function fillLoginCredentials(page) {
  await dismissCookieBanner(page);
  const userLoc = page.locator('#username, input[name="username"], input[name="email"], input[type="email"], input[type="text"]').first();
  const passLoc = page.locator('#password, input[name="password"], input[type="password"]').first();
  await userLoc.waitFor({ state: 'visible', timeout: 15000 });
  await userLoc.fill(USER);
  await passLoc.fill(PASS);
}

async function login(page) {
  log('登录 ' + BASE + ' as ' + USER);
  await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1000);

  if (await loggedIn(page)) {
    log('已有有效会话,跳过登录验证码');
    await page.context().storageState({ path: AUTH }).catch(() => {});
    return;
  }

  if (fs.existsSync(AUTH)) {
    log('缓存会话已失效,清理并重新登录');
    try { fs.unlinkSync(AUTH); } catch {}
  }

  await page.goto(BASE + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await fillLoginCredentials(page);
  await shot(page, '01-login.png');

  let loggedInSuccess = false;
  for (let i = 0; i < 4 && !loggedInSuccess; i++) {
    try {
      const capToken = await solveCaptcha(page, '', 'login');
      await shot(page, '02-after-login-captcha.png');

      const submitBtn = page.locator("button[type='submit'], button:has-text('Sign in'), button:has-text('Login'), input[type='submit']").first();
      await submitBtn.click();

      const jumped = await page
        .waitForFunction(() => !window.location.pathname.includes('/auth/login'), { timeout: 15000 })
        .then(() => true)
        .catch(() => false);

      if (jumped || (await loggedIn(page))) {
        loggedInSuccess = true;
        break;
      }

      if (capToken) {
        log('表单提交未跳转，尝试通过 API 直接登录...');
        await api(
          page,
          '/auth/login',
          'POST',
          {
            username: USER,
            email: USER,
            password: PASS,
            captcha_token: capToken,
            captcha: capToken,
            token: capToken,
          },
          { 'X-Captcha-Token': capToken }
        );
        await page.goto(BASE + '/dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        if (await loggedIn(page)) {
          loggedInSuccess = true;
          break;
        }
      }

      const errText = await page.locator('.alert, .error, [role="alert"], .text-red-500').first().innerText().catch(() => '');
      throw new Error('点击登录后仍停留在登录页' + (errText ? ' (' + errText.trim() + ')' : ''));
    } catch (e) {
      log('登录尝试失败(' + (i + 1) + '/4): ' + e.message);
      if (i < 3) {
        await page.goto(BASE + '/auth/login', { waitUntil: 'domcontentloaded' });
        await fillLoginCredentials(page);
      }
    }
  }

  if (!loggedInSuccess && !(await loggedIn(page))) {
    throw new Error('登录连续 4 次失败');
  }

  await page.context().storageState({ path: AUTH });
  log('登录成功,会话写入 ' + AUTH);
}

function formatRemaining(expiresAt) {
  if (!expiresAt) return null;
  const target = new Date(expiresAt).getTime();
  const diff = target - Date.now();
  if (isNaN(diff)) return null;
  if (diff <= 0) return '已到期';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const expStr = new Date(target).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return d + '天' + h + '小时 (到期: ' + expStr + ')';
}

function detectNotYetAvailable(text) {
  const s = String(text || '');
  const patterns = [
    /Free renewal opens on[^\n.]*/i,
    /Renewal opens on[^\n.]*/i,
    /Renewal will be available[^\n.]*/i,
    /renouvellement(?:\s+gratuit)?\s+(?:sera disponible|ouvre)[^\n.]*/i,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

function extractRemainingText(text, expiresAt) {
  const s = String(text || '');
  const m1 = s.match(/(?:Time remaining|Expire dans)\s*:?\s*([0-9]+[dj](?:\s*[0-9]+h)?)/i);
  if (m1) return m1[1].trim();
  const m2 = s.match(/(\d+\s*(?:days?|hours?|d|h|j)\s*(?:left|remaining))/i);
  if (m2) return m2[1].trim();
  return formatRemaining(expiresAt);
}

async function scrapeShortServerIdsFromPage(page) {
  return page
    .evaluate(() => {
      const found = [];
      const urlMatch = window.location.href.match(/\/(?:server|servers|projects)\/([a-f0-9]{8})(?:\/|$|\?)/i);
      if (urlMatch) found.push(urlMatch[1]);

      document.querySelectorAll('[data-server-id], [data-server], [data-identifier]').forEach((el) => {
        const val =
          el.getAttribute('data-server-id') ||
          el.getAttribute('data-server') ||
          el.getAttribute('data-identifier');
        if (val && /^[a-f0-9]{8}$/i.test(val.trim())) found.push(val.trim());
      });
      document.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/(?:server|servers|projects)\/([a-f0-9]{8})(?:\/|$|\?)/i);
        if (m) found.push(m[1]);
      });
      const html = document.documentElement.innerHTML;
      const regex = /"(?:identifier|server_identifier)"\s*:\s*"([a-f0-9]{8})"/gi;
      let match;
      while ((match = regex.exec(html)) !== null) {
        found.push(match[1]);
      }
      return [...new Set(found)];
    })
    .catch(() => []);
}

async function discover(page) {
  const list = [];

  const upsertServer = (s) => {
    if (!s) return;
    const rawId = String(s.id || '').trim();
    const serverId = String(s.serverId || (isShortServerId(rawId) ? rawId : '')).trim();
    const subscriptionId = String(s.subscriptionId || (isHostingSubId(rawId) ? rawId : '')).trim();
    const primaryId = serverId || rawId || subscriptionId;
    if (!primaryId || primaryId === 'undefined' || primaryId === 'null') return;

    const nameKey = s.name && s.name !== rawId ? norm(s.name) : '';
    const existing = list.find(
      (item) =>
        (serverId && item.serverId === serverId) ||
        (subscriptionId && item.subscriptionId === subscriptionId) ||
        item.id === primaryId ||
        (s.uuid && item.uuid && item.uuid === s.uuid) ||
        (nameKey && item.name && norm(item.name) === nameKey)
    );

    if (existing) {
      if (serverId) {
        existing.serverId = serverId;
        existing.id = serverId;
      }
      if (subscriptionId) existing.subscriptionId = subscriptionId;
      if (s.uuid && !existing.uuid) existing.uuid = s.uuid;
      if (s.name && s.name !== rawId && (!existing.name || existing.name === existing.id)) {
        existing.name = s.name;
      }
      if (s.expiresAt && !existing.expiresAt) existing.expiresAt = s.expiresAt;
      if (typeof s.canRenew === 'boolean') existing.canRenew = s.canRenew;
    } else {
      list.push({
        id: primaryId,
        serverId: serverId || null,
        subscriptionId: subscriptionId || null,
        uuid: s.uuid || primaryId,
        name: s.name || primaryId,
        expiresAt: s.expiresAt || null,
        canRenew: typeof s.canRenew === 'boolean' ? s.canRenew : null,
      });
    }
  };

  if (SERVER_ID) {
    upsertServer({ id: SERVER_ID, serverId: isShortServerId(SERVER_ID) ? SERVER_ID : '', uuid: SERVER_ID, name: SERVER_ID });
  }

  const r1 = await api(page, '/api/client');
  if (r1.status === 200) {
    const items = Array.isArray(r1.data?.data) ? r1.data.data : Array.isArray(r1.data?.servers) ? r1.data.servers : [];
    for (const item of items) {
      const attr = item.attributes || item;
      const sid = attr.identifier || attr.server_identifier || '';
      const id = sid || attr.id || attr.uuid;
      if (id) {
        upsertServer({
          id,
          serverId: isShortServerId(sid) ? sid : undefined,
          uuid: attr.uuid || id,
          name: attr.name || attr.project_name || String(id),
          expiresAt: attr.expires_at || attr.renews_at || null,
          canRenew: typeof attr.can_renew === 'boolean' ? attr.can_renew : undefined,
        });
      }
    }
  }

  const r2 = await api(page, '/api/client/credits/subscriptions');
  if (r2.status === 200) {
    const rawList = Array.isArray(r2.data?.data)
      ? r2.data.data
      : Array.isArray(r2.data?.subscriptions)
      ? r2.data.subscriptions
      : Array.isArray(r2.data)
      ? r2.data
      : [];
    for (const item of rawList) {
      const attr = item.attributes || item.server || item;
      const shortId =
        attr.server_identifier ||
        attr.identifier ||
        item.server_identifier ||
        item.identifier ||
        item.server?.identifier ||
        '';
      const subId = isHostingSubId(item.id || attr.id) ? (item.id || attr.id) : '';
      const id = shortId || subId || attr.server_id || attr.id;
      if (id) {
        upsertServer({
          id,
          serverId: isShortServerId(shortId) ? shortId : undefined,
          subscriptionId: subId || undefined,
          uuid: attr.uuid || item.uuid || id,
          name: attr.name || attr.server_name || item.name || String(id),
          expiresAt: attr.expires_at || item.expires_at || attr.renews_at || null,
          canRenew:
            typeof attr.can_renew === 'boolean'
              ? attr.can_renew
              : typeof item.can_renew === 'boolean'
              ? item.can_renew
              : undefined,
        });
      }
    }
  }

  await page.goto(BASE + '/dashboard/projects', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1500);
  const domIds = await scrapeShortServerIdsFromPage(page);
  for (const id of domIds) {
    if (list.length === 1 && !list[0].serverId) {
      list[0].serverId = id;
    } else if (!list.some((s) => s.serverId === id || s.id === id)) {
      upsertServer({ id, serverId: id, uuid: id, name: id });
    }
  }

  let servers = list;
  if (SERVER_ID) {
    const matched = servers.filter(
      (s) => s.id === SERVER_ID || s.serverId === SERVER_ID || s.subscriptionId === SERVER_ID || s.uuid === SERVER_ID
    );
    if (matched.length > 0) servers = matched;
  }

  const serverLogStr = servers
    .map((s) => {
      const exp = s.expiresAt ? s.expiresAt : '未知';
      const idLabel = s.serverId && s.subscriptionId ? `${s.serverId}/${s.subscriptionId}` : s.id;
      return s.name + '(' + idLabel + ') 到期:' + exp;
    })
    .join(', ');
  log('发现服务: ' + (serverLogStr ? serverLogStr : '(无)'));
  return servers;
}

function classifyRenew(r) {
  if (r.status === 200) {
    const exp = r.data?.expires_at ? ' (到期: ' + r.data.expires_at + ')' : '';
    const msg = r.data?.message ? r.data.message : JSON.stringify(r.data).slice(0, 120);
    return {
      ok: true,
      skip: false,
      captcha: false,
      text: '续期成功' + exp + ' ' + msg,
    };
  }
  const blob = JSON.stringify(r.data || {});
  if (
    r.status === 400 &&
    (r.data?.error === 'renewal_not_available' ||
      r.data?.code === 'renewal_not_available' ||
      /renewal_not_available|not_available|pas encore disponible/i.test(blob))
  ) {
    const rem = r.data?.days_remaining ?? r.data?.hours_remaining ?? '?';
    return {
      ok: true,
      skip: true,
      captcha: false,
      text: '未到续期窗口 剩余 ' + rem + ' 天/小时',
    };
  }
  if ((r.status === 403 || r.status === 400 || r.status === 422) && /captcha_required|captcha/i.test(blob)) {
    return { ok: false, skip: false, captcha: true, text: 'HTTP ' + r.status + ' captcha_required' };
  }
  return { ok: false, skip: false, captcha: false, text: 'HTTP ' + r.status + ' ' + blob.slice(0, 180) };
}

function looksLikeRenewAction(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s || s.length > 60) return false;
  if (
    s.includes('?') ||
    /\brenewals?\b/.test(s) ||
    /\brenouvellements?\b/.test(s) ||
    /\b\d+\s+to\s+renew\b/.test(s) ||
    /\bto\s+renew\b/.test(s) ||
    /opens?\s+on|available|ouvre/i.test(s)
  ) {
    return false;
  }
  return /\brenew\b/.test(s) || /\brenouveler\b/.test(s) || /\bextend\b/.test(s) || /续期|延长/.test(s);
}

async function findVisibleRenewButton(page, server) {
  const locator = page.locator('button, a, [role="button"]');
  const count = await locator.count();
  const scored = [];

  for (let i = 0; i < count; i++) {
    const item = locator.nth(i);
    const info = await item
      .evaluate((el) => {
        // 排除顶部栏、侧边栏、导航、Tab 切换项，避免误点 "1 to renew" / "Renewals 1"
        if (el.closest('nav, header, aside, [role="tablist"], [role="tab"]')) return null;
        const href = (el.getAttribute('href') || '').toLowerCase();
        if (href && /\/renewals(?:[/?#]|$)/.test(href)) return null;

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const text = [
          el.innerText,
          el.textContent,
          el.getAttribute('aria-label'),
          el.getAttribute('title'),
          el.getAttribute('value'),
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        const card = el.closest(
          '[data-server], [data-server-id], article, li, tr, .card, .client-card, .server, .project'
        );
        const cardText = (card?.innerText || card?.textContent || '').replace(/\s+/g, ' ').trim();
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
        const busy = el.getAttribute('aria-busy') === 'true';
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          style.opacity !== '0';
        return { text, cardText, disabled, busy, visible, top: rect.top, left: rect.left };
      })
      .catch(() => null);

    if (!info || !looksLikeRenewAction(info.text) || info.disabled || info.busy || !info.visible) continue;

    const haystack = (info.cardText + ' ' + info.text).toLowerCase();
    let s = 100;
    if (server?.serverId && haystack.includes(String(server.serverId).toLowerCase())) s += 50;
    if (server?.id && haystack.includes(String(server.id).toLowerCase())) s += 50;
    if (server?.uuid && haystack.includes(String(server.uuid).toLowerCase())) s += 40;
    if (server?.name && haystack.includes(String(server.name).toLowerCase())) s += 30;
    if (/^\s*(?:free\s+)?(renew|renew now|renew free|renouveler|extend|续期|立即续期|延长)\s*$/i.test(info.text)) s += 25;
    s -= Math.max(0, info.top) / 1000;
    scored.push({ item, info, score: s });
  }

  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  log('选择可见续期按钮: ' + JSON.stringify(scored[0].info.text).slice(0, 120));
  return scored[0].item;
}

async function clickRenewUi(page, server) {
  const btn = await findVisibleRenewButton(page, server);
  if (!btn) {
    log('未找到可见可点击的 UI 续期按钮');
    return false;
  }
  await btn.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await btn.click({ timeout: 8000 });
  await page.waitForTimeout(2000);
  return true;
}

async function openRenewalsTabIfPresent(page) {
  const tab = page.locator('button:has-text("Renewals"), a:has-text("Renewals"), [role="tab"]:has-text("Renewals"), button:has-text("Renouvellements"), a:has-text("Renouvellements")').first();
  if (await tab.isVisible().catch(() => false)) {
    log('切换到 Renewals 标签页...');
    await tab.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1800);
  }
}

async function navigateToServerRenewPage(page, server) {
  const candidateUrls = [
    BASE + '/dashboard/services',
    ...(server.serverId ? [BASE + '/server/' + server.serverId] : []),
    ...(server.subscriptionId ? [BASE + '/dashboard/projects/' + server.subscriptionId] : []),
    BASE + '/dashboard/projects',
  ];

  for (const url of [...new Set(candidateUrls)]) {
    log('访问服务页面: ' + url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2200);
    await dismissCookieBanner(page);

    if (url.endsWith('/dashboard/services')) {
      await openRenewalsTabIfPresent(page);
    }

    // 顺便从页面补全真实 8 位 serverId
    if (!server.serverId) {
      const scraped = await scrapeShortServerIdsFromPage(page);
      if (scraped.length === 1) {
        server.serverId = scraped[0];
        log('从页面解析到真实 serverId: ' + server.serverId);
      }
    }

    if (await findVisibleRenewButton(page, server)) {
      return;
    }

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (
      detectNotYetAvailable(bodyText) ||
      /Time remaining|Expire dans|Server suspended/i.test(bodyText)
    ) {
      return;
    }

    const manageBtn = page.locator('a:has-text("Manage"), button:has-text("Manage"), a:has-text("Gérer"), button:has-text("Gérer")').first();
    if (await manageBtn.isVisible().catch(() => false)) {
      log('点击 Manage 按钮进入详情页...');
      await manageBtn.click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(2500);

      if (!server.serverId) {
        const scraped = await scrapeShortServerIdsFromPage(page);
        if (scraped.length >= 1) {
          server.serverId = scraped[0];
          log('从 Manage 详情页解析到真实 serverId: ' + server.serverId);
        }
      }

      if (await findVisibleRenewButton(page, server)) {
        return;
      }
      const detailText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (detectNotYetAvailable(detailText)) {
        return;
      }
    }
  }
}

async function tryRenew(page, server) {
  const id = server.serverId || server.id;
  const name = server.name || id;
  log('开始检查续期: ' + name + ' (' + id + ')');

  if (DRY_RUN) return { id, ok: true, skip: true, text: '[DRY_RUN] ' + name + ' (' + id + ') 跳过实际提交' };

  await navigateToServerRenewPage(page, server);
  await shot(page, '05-server-page-' + id + '.png');

  const initialBody = await page.evaluate(() => document.body.innerText).catch(() => '');
  const notYetNotice = detectNotYetAvailable(initialBody);
  const remStr = extractRemainingText(initialBody, server.expiresAt) || '充足';

  let uiRenewRes = null;
  const responseHandler = async (res) => {
    if (res.url().includes('/renew') && res.request().method() === 'POST') {
      try {
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        uiRenewRes = { status: res.status(), data };
      } catch {}
    }
  };
  page.on('response', responseHandler);

  try {
    const clicked = await clickRenewUi(page, server);
    if (clicked) {
      log('已点击可见 UI 续期按钮, 等待 Anti-bot 验证码弹窗...');
      await page.waitForTimeout(1500);

      const hasDialog = (await page.locator("[role='dialog']").count()) > 0 && (await page.locator("[role='dialog']").first().isVisible().catch(() => false));
      const scope = hasDialog ? "[role='dialog']" : '';

      log('开始处理续期人机验证 (scope: ' + (scope || 'page') + ')...');
      try {
        await solveCaptcha(page, scope, 'renewal_gate');
        log('验证码处理完毕，等待自动续期请求完成与页面刷新...');
        await page.waitForTimeout(5000);

        const confirmRoot = hasDialog ? page.locator("[role='dialog']") : page;
        const confirmBtn = confirmRoot
          .locator("button[type='submit'], button:has-text('Confirm'), button:has-text('Valider')")
          .first();
        if (await confirmBtn.isVisible().catch(() => false)) {
          await confirmBtn.click().catch(() => {});
          await page.waitForTimeout(3000);
        }
      } catch (e) {
        log('弹窗验证码处理异常: ' + e.message);
      }

      const startBtn = page.locator("button:has-text('Start'), button:has-text('Démarrer')").first();
      if (await startBtn.isVisible().catch(() => false)) {
        const isDisabled = await startBtn.isDisabled().catch(() => false);
        if (!isDisabled) {
          log('检测到服务器处于 Offline 状态，自动点击 Start 按钮启动服务...');
          await startBtn.click().catch(() => {});
          await page.waitForTimeout(2000);
        }
      }

      if (uiRenewRes) {
        const c = classifyRenew(uiRenewRes);
        if (c.ok) {
          log('UI 触发 API 响应成功: ' + c.text);
          return { id, ok: true, skip: c.skip, text: name + ' (' + id + '): ' + c.text };
        }
      }

      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
      const afterNotYet = detectNotYetAvailable(bodyText);
      if (!notYetNotice && afterNotYet) {
        const newRem = extractRemainingText(bodyText, server.expiresAt) || afterNotYet;
        log('UI 续期验证成功: ' + newRem);
        return { id, ok: true, skip: false, text: name + ' (' + id + '): 续期成功 (' + newRem + ')' };
      }
      log('UI 点击后未确认续期成功,继续尝试 API 续期接口');
    } else if (notYetNotice) {
      log('页面显示未到续期窗口 (' + notYetNotice + '), 剩余: ' + remStr);
      return {
        id,
        ok: true,
        skip: true,
        text: name + ' (' + id + '): 未到续期窗口（' + notYetNotice + '），剩余 ' + remStr,
      };
    }
  } catch (e) {
    log('UI 续期按钮点击失败,改走 API 续期: ' + e.message);
    await shot(page, 'ui-click-fallback-' + id + '.png').catch(() => {});
  } finally {
    page.off('response', responseHandler);
  }

  // 仅使用有效的 Pterodactyl serverId 调用升级续期 API，避免用 hosting-... 触发 404
  const apiServerId = server.serverId || (isHostingSubId(id) ? null : id);
  if (!apiServerId) {
    const fallbackMsg = '未找到可用续期按钮，且未能解析到 8 位服务器 ID (当前仅获取到订阅 ID: ' + id + '，可在 Secrets 中配置 ACL_SERVER_ID)';
    log(fallbackMsg);
    return { id, ok: false, skip: false, text: name + ' (' + id + '): ' + fallbackMsg };
  }

  log('尝试 API 续期接口 (serverId: ' + apiServerId + ')...');
  const renewPath = '/api/client/servers/' + apiServerId + '/upgrade/renew';
  let r = await api(page, renewPath, 'POST', {});
  let c = classifyRenew(r);

  if (c.captcha) {
    const reqContext = r.data?.context || r.data?.captcha_context || 'renewal_gate';
    log('检测到 captcha_required,获取 ' + reqContext + ' 验证码凭据...');
    try {
      let token;
      try {
        token = await solveCaptchaApi(page, reqContext);
      } catch (errGate) {
        log(reqContext + ' 获取失败(' + errGate.message + '),尝试 login 上下文...');
        token = await solveCaptchaApi(page, 'login');
      }
      r = await api(
        page,
        renewPath,
        'POST',
        { captcha_token: token, captcha: token, token, captchaToken: token },
        { 'X-Captcha-Token': token, 'X-Captcha': token }
      );
      c = classifyRenew(r);
    } catch (e) {
      c = { ok: false, skip: false, captcha: false, text: '验证码求解失败: ' + e.message };
    }
  }

  let resultText = name + ' (' + apiServerId + '): ' + c.text;
  const exactRemaining = formatRemaining(server.expiresAt);
  if (c.skip && exactRemaining) {
    resultText = name + ' (' + apiServerId + '): 未到续期窗口，剩余 ' + exactRemaining;
  }

  log('API 续期结果: ' + resultText);
  return { id: apiServerId, ok: c.ok, skip: c.skip, text: resultText };
}

function resolveExecutablePath() {
  const paths = [
    process.env.CHROME_PATH,
    'D:\\PlaywrightBrowsers\\chromium-1217\\chrome-win64\\chrome.exe',
  ].filter(Boolean);
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function main() {
  if (!USER || !PASS) throw new Error('缺少 ACL_USERNAME / ACL_PASSWORD 环境变量');
  const execPath = resolveExecutablePath();
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    ...(execPath ? { executablePath: execPath } : {}),
  };
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    storageState: fs.existsSync(AUTH) ? AUTH : undefined,
  });
  const page = await context.newPage();
  let summary = '';
  let failed = false;
  const results = [];

  try {
    await login(page);
    await shot(page, '03-dashboard.png');

    const servers = await discover(page);
    await shot(page, '04-projects.png');

    for (const server of servers) {
      const res = await tryRenew(page, server);
      results.push(res);
    }

    if (!results.length) {
      failed = true;
      summary = '未找到可续期服务 (请检查账号下是否有活跃服务或设置 ACL_SERVER_ID)';
    } else {
      summary = results.map((r) => r.text).join('\n');
      failed = results.some((r) => !r.ok);
    }

    const hasRenewed = results.some((r) => r.ok && !r.skip);
    if (hasRenewed) {
      await shot(page, '06-result.png');
    }
    if (failed) {
      await shot(page, '99-error.png');
    }
  } catch (e) {
    failed = true;
    summary = '执行失败: ' + e.message;
    log(summary);
    await shot(page, '99-error.png');
  } finally {
    await browser.close().catch(() => {});
  }
  log(summary);

  let photoToSend = null;
  if (failed) {
    const errPic = path.join(SHOT, '99-error.png');
    if (fs.existsSync(errPic)) photoToSend = errPic;
  } else if (results.some((r) => r.ok && !r.skip)) {
    const donePic = path.join(SHOT, '06-result.png');
    if (fs.existsSync(donePic)) photoToSend = donePic;
  }

  const tgMessage = formatTgMessage({
    failed,
    results,
    errorMsg: failed && !results.length ? summary : '',
  });

  await tg(tgMessage, { photo: photoToSend });
  if (failed) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch(async (e) => {
    log(e.stack || e.message);
    const failPic = path.join(SHOT, '99-error.png');
    const tgMessage = formatTgMessage({
      failed: true,
      results: [],
      errorMsg: e.message,
    });
    await tg(tgMessage, { photo: fs.existsSync(failPic) ? failPic : null });
    process.exit(1);
  });
}

export { score, ocrScore, classifyRenew, looksLikeRenewAction };
