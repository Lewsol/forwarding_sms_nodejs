import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class APIServer {
  constructor(config, modem, smsProcessor) {
    this.config = config;
    this.modem = modem;
    this.smsProcessor = smsProcessor;
    this.app = express();
    this.publicDir = path.join(__dirname, '../public');

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // JSON解析
    this.app.use(express.json());

    // Web Token认证，API保留Basic Auth兼容
    this.app.use((req, res, next) => {
      this.authenticateRequest(req, res, next);
    });

    // 请求日志
    this.app.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`);
      next();
    });

    this.app.use('/assets', express.static(path.join(this.publicDir, 'assets')));
  }

  authenticateRequest(req, res, next) {
    if (this.hasValidWebToken(req)) {
      this.persistWebToken(req, res);

      if (this.shouldCleanTokenFromUrl(req)) {
        return res.redirect(302, this.getCleanUrl(req));
      }

      return next();
    }

    if (this.isWebRoute(req) && this.getConfiguredWebToken()) {
      return this.sendTokenGate(res);
    }

    if (this.hasValidBasicAuth(req)) {
      return next();
    }

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({
        success: false,
        error: this.getConfiguredWebToken() ? '需要有效token或Basic Auth' : '需要Basic Auth'
      });
    }

    return this.sendBasicAuthChallenge(res);
  }

  getConfiguredWebToken() {
    return String(this.config.api.webToken || '').trim();
  }

  hasValidWebToken(req) {
    const expected = this.getConfiguredWebToken();
    if (!expected) {
      return false;
    }

    const token = this.getRequestToken(req);
    return this.safeEqual(token, expected);
  }

  getRequestToken(req) {
    const bearer = req.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    return req.query.token || req.get('x-web-token') || bearer || this.getCookie(req, 'sms_gateway_token') || '';
  }

  getCookie(req, name) {
    const cookieHeader = req.get('cookie') || '';
    const cookies = cookieHeader.split(';').map(item => item.trim());
    const prefix = `${name}=`;
    const cookie = cookies.find(item => item.startsWith(prefix));
    return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : '';
  }

  persistWebToken(req, res) {
    if (!req.query.token) {
      return;
    }

    res.cookie('sms_gateway_token', req.query.token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });
  }

  shouldCleanTokenFromUrl(req) {
    return this.isWebRoute(req) && Boolean(req.query.token);
  }

  getCleanUrl(req) {
    const url = new URL(req.originalUrl, 'http://localhost');
    url.searchParams.delete('token');
    return `${url.pathname}${url.search}`;
  }

  hasValidBasicAuth(req) {
    const auth = req.get('authorization') || '';
    if (!auth.startsWith('Basic ')) {
      return false;
    }

    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) {
      return false;
    }

    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    return this.safeEqual(username, this.config.api.auth.username) &&
      this.safeEqual(password, this.config.api.auth.password);
  }

  safeEqual(actual, expected) {
    const actualBuffer = Buffer.from(String(actual));
    const expectedBuffer = Buffer.from(String(expected));

    if (actualBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }

  isWebRoute(req) {
    return req.path === '/' || req.path === '/admin' || req.path.startsWith('/assets/');
  }

  sendBasicAuthChallenge(res) {
    res.set('WWW-Authenticate', 'Basic realm="SMS Gateway"');
    return res.status(401).send('Authentication required');
  }

  sendTokenGate(res) {
    res.set('Cache-Control', 'no-store');
    return res.status(401).type('html').send(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SMS Gateway Token</title>
  <style>
    :root { color-scheme: light; --canvas:#faf9f5; --ink:#141413; --body:#3d3d3a; --muted:#6c6a64; --card:#efe9de; --primary:#cc785c; --primary-active:#a9583e; --hairline:#e6dfd8; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--canvas); color: var(--body); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; }
    main { width: min(480px, calc(100% - 32px)); border-radius: 12px; background: var(--card); padding: 32px; }
    .mark { color: var(--ink); font-size: 20px; }
    h1 { margin: 18px 0 10px; color: var(--ink); font-family: "Cormorant Garamond", "EB Garamond", Georgia, serif; font-size: 40px; font-weight: 500; line-height: 1.1; letter-spacing: 0; }
    p { margin: 0 0 24px; color: var(--muted); }
    label { display: grid; gap: 8px; color: var(--ink); font-size: 14px; font-weight: 500; }
    input { width: 100%; min-height: 40px; border: 1px solid var(--hairline); border-radius: 8px; background: var(--canvas); color: var(--ink); padding: 10px 14px; font: inherit; }
    input:focus { border-color: var(--primary); outline: 3px solid rgba(204, 120, 92, .15); }
    button { margin-top: 18px; width: 100%; min-height: 40px; border: 0; border-radius: 8px; background: var(--primary); color: #fff; padding: 12px 20px; font: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
    button:active { background: var(--primary-active); }
  </style>
</head>
<body>
  <main>
    <span class="mark">✣</span>
    <h1>输入访问 token</h1>
    <p>管理台需要有效 token 才能继续访问。</p>
    <form method="get" action="/admin">
      <label>
        Token
        <input name="token" type="password" autocomplete="current-password" autofocus required>
      </label>
      <button type="submit">进入管理台</button>
    </form>
  </main>
</body>
</html>`);
  }

  setupRoutes() {
    this.app.get('/', (req, res) => {
      res.redirect('/admin');
    });

    this.app.get('/admin', (req, res) => {
      res.sendFile(path.join(this.publicDir, 'admin.html'));
    });

    // 状态查询
    this.app.get('/api/status', async (req, res) => {
      try {
        const signal = await this.modem.getSignalQuality();
        const operator = await this.modem.getOperator();

        res.json({
          success: true,
          data: {
            ready: this.modem.ready,
            model: this.modem.modelInfo,
            signal,
            operator,
            uptime: process.uptime()
          }
        });
      } catch (err) {
        logger.error('查询状态失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 发送短信
    this.app.post('/api/sms/send', async (req, res) => {
      try {
        const { phone, message } = req.body;

        if (!phone || !message) {
          return res.status(400).json({
            success: false,
            error: '缺少必要参数: phone, message'
          });
        }

        const success = await this.modem.sendSMS(phone, message);

        res.json({
          success,
          message: success ? '短信发送成功' : '短信发送失败'
        });
      } catch (err) {
        logger.error('发送短信失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 查询收到的短信
    this.app.get('/api/sms/received', (req, res) => {
      try {
        const messages = this.smsProcessor.getReceivedMessages(req.query.limit);
        res.json({
          success: true,
          data: messages
        });
      } catch (err) {
        logger.error('查询收到短信失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 查询信号强度
    this.app.get('/api/modem/signal', async (req, res) => {
      try {
        const signal = await this.modem.getSignalQuality();
        res.json({
          success: true,
          data: signal
        });
      } catch (err) {
        logger.error('查询信号失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 查询模组信息
    this.app.get('/api/modem/info', async (req, res) => {
      try {
        const iccid = await this.modem.getICCID();
        res.json({
          success: true,
          data: {
            model: this.modem.modelInfo,
            iccid,
            ready: this.modem.ready
          }
        });
      } catch (err) {
        logger.error('查询模组信息失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 发送AT命令
    this.app.post('/api/modem/at', async (req, res) => {
      try {
        const { command } = req.body;

        if (!command) {
          return res.status(400).json({
            success: false,
            error: '缺少必要参数: command'
          });
        }

        const response = await this.modem.sendATCommand(command, 5000);

        res.json({
          success: true,
          data: {
            command,
            response
          }
        });
      } catch (err) {
        logger.error('发送AT命令失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 获取日志
    this.app.get('/api/logs', (req, res) => {
      try {
        const logs = logger.getBuffer().getAll();
        res.json({
          success: true,
          data: logs
        });
      } catch (err) {
        logger.error('获取日志失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 健康检查
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        uptime: process.uptime()
      });
    });

    // 404处理
    this.app.use((req, res) => {
      res.status(404).json({
        success: false,
        error: 'Not Found'
      });
    });

    // 错误处理
    this.app.use((err, req, res, next) => {
      logger.error('API错误:', err);
      res.status(500).json({
        success: false,
        error: err.message
      });
    });
  }

  start() {
    const port = this.config.api.port;
    this.app.listen(port, () => {
      logger.info(`API服务器已启动，监听端口: ${port}`);
    });
  }
}

export default APIServer;
