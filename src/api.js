import fs from 'fs';
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUSH_CHANNEL_TYPES = new Set([
  'post_json',
  'bark',
  'get',
  'dingtalk',
  'pushplus',
  'serverchan',
  'custom',
  'feishu',
  'telegram'
]);

const PUSH_CHANNEL_TYPE_LABELS = {
  post_json: 'POST JSON',
  bark: 'Bark',
  get: 'GET',
  dingtalk: '钉钉',
  pushplus: 'PushPlus',
  serverchan: 'Server酱',
  custom: '自定义',
  feishu: '飞书',
  telegram: 'Telegram'
};

class APIServer {
  constructor(config, modem, smsProcessor, pushManager) {
    this.config = config;
    this.modem = modem;
    this.smsProcessor = smsProcessor;
    this.pushManager = pushManager;
    this.app = express();
    this.publicDir = path.join(__dirname, '../public');
    this.configPath = path.join(__dirname, '../config.json');

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

  async readConfigFile() {
    const configContent = await fs.promises.readFile(this.configPath, 'utf8');
    return JSON.parse(configContent);
  }

  async savePushChannels(channels) {
    const diskConfig = await this.readConfigFile();
    diskConfig.pushChannels = channels;

    await fs.promises.writeFile(
      this.configPath,
      `${JSON.stringify(diskConfig, null, 2)}\n`,
      'utf8'
    );

    this.config.pushChannels = channels;
    if (this.pushManager?.config) {
      this.pushManager.config.pushChannels = channels;
    }
  }

  getPushChannelsFromConfig(config = this.config) {
    return Array.isArray(config.pushChannels) ? config.pushChannels : [];
  }

  normalizePushChannels(channels) {
    if (!Array.isArray(channels)) {
      throw new Error('pushChannels 必须是数组');
    }

    if (channels.length > 30) {
      throw new Error('推送通道数量不能超过 30 个');
    }

    return channels.map((channel, index) => this.normalizePushChannel(channel, index));
  }

  normalizePushChannel(channel, index = 0) {
    if (!channel || typeof channel !== 'object' || Array.isArray(channel)) {
      throw new Error(`第 ${index + 1} 个推送通道格式不正确`);
    }

    const type = this.normalizeString(channel.type, '推送类型', 32);
    if (!PUSH_CHANNEL_TYPES.has(type)) {
      throw new Error(`第 ${index + 1} 个推送通道类型不支持`);
    }

    const typeLabel = PUSH_CHANNEL_TYPE_LABELS[type] || type;
    const fallbackName = `${typeLabel}通知`;
    const name = this.normalizeString(channel.name || fallbackName, '通道名称', 80);

    return {
      enabled: Boolean(channel.enabled),
      type,
      name: name || fallbackName,
      url: this.normalizeString(channel.url, 'URL', 2048),
      secret: this.normalizeString(channel.secret, '密钥', 2048),
      key1: this.normalizeString(channel.key1, 'Key1', 2048),
      key2: this.normalizeString(channel.key2, 'Key2', 2048),
      customBody: this.normalizeString(channel.customBody, '自定义请求体', 10000)
    };
  }

  normalizeString(value, fieldName, maxLength) {
    const text = String(value ?? '').trim();
    if (text.length > maxLength) {
      throw new Error(`${fieldName}长度不能超过 ${maxLength} 个字符`);
    }
    return text;
  }

  validatePushChannels(channels) {
    channels.forEach((channel, index) => {
      this.validatePushChannel(channel, { index });
    });
  }

  validatePushChannel(channel, options = {}) {
    const index = options.index ?? 0;
    const requireDestination = Boolean(options.requireDestination || channel.enabled);
    const prefix = `第 ${index + 1} 个推送通道`;
    const urlTypes = new Set(['post_json', 'bark', 'get', 'dingtalk', 'custom', 'feishu']);

    if (urlTypes.has(channel.type)) {
      if (requireDestination && !channel.url) {
        throw new Error(`${prefix}缺少 URL`);
      }

      if (channel.url && !this.isHttpUrl(channel.url)) {
        throw new Error(`${prefix}的 URL 格式不正确`);
      }
    }

    if (channel.type === 'telegram') {
      if (requireDestination && !channel.url) {
        throw new Error(`${prefix}缺少 Bot Token`);
      }

      if (requireDestination && !channel.key1) {
        throw new Error(`${prefix}缺少 Chat ID`);
      }
    }

    if (channel.type === 'pushplus' && requireDestination && !channel.key1) {
      throw new Error(`${prefix}缺少 PushPlus Token`);
    }

    if (channel.type === 'serverchan' && requireDestination && !channel.key1) {
      throw new Error(`${prefix}缺少 Server酱 SendKey`);
    }

    if (channel.type === 'custom' && channel.customBody) {
      try {
        JSON.parse(channel.customBody);
      } catch (err) {
        throw new Error(`${prefix}的自定义请求体不是有效 JSON`);
      }
    }
  }

  isHttpUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch (err) {
      return false;
    }
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
        const mobileData = await this.modem.getMobileDataStatus();

        res.json({
          success: true,
          data: {
            ready: this.modem.ready,
            model: this.modem.modelInfo,
            signal,
            operator,
            mobileData,
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

    // 查询移动数据连接状态
    this.app.get('/api/modem/mobile-data', async (req, res) => {
      try {
        const mobileData = await this.modem.getMobileDataStatus();
        res.json({
          success: true,
          data: mobileData
        });
      } catch (err) {
        logger.error('查询移动数据状态失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 开启或关闭移动数据连接
    this.app.post('/api/modem/mobile-data', async (req, res) => {
      try {
        if (typeof req.body?.enabled !== 'boolean') {
          return res.status(400).json({
            success: false,
            error: '缺少必要参数: enabled'
          });
        }

        const mobileData = await this.modem.setMobileDataEnabled(req.body.enabled);
        const message = mobileData.mode === 'mipcall'
          ? (req.body.enabled ? '应用层拨号已开启' : '应用层拨号已断开')
          : (req.body.enabled ? '移动数据已开启' : '移动数据已关闭');

        res.json({
          success: true,
          message,
          data: mobileData
        });
      } catch (err) {
        logger.error('设置移动数据状态失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 通过模组执行一次MPING，消耗少量流量验证连通性
    this.app.post('/api/modem/mobile-data/consume', async (req, res) => {
      try {
        const ping = await this.modem.consumeMobileDataTraffic({
          target: req.body?.target || '8.8.8.8'
        });
        const mobileData = await this.modem.getMobileDataStatus();

        res.json({
          success: true,
          message: '已消耗少量流量完成连通性测试',
          data: {
            ping,
            mobileData
          }
        });
      } catch (err) {
        logger.error('流量消耗测试失败:', err);
        res.status(err.statusCode || 500).json({
          success: false,
          error: err.message,
          data: err.data || null
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

    // 查询推送通道配置
    this.app.get('/api/push/channels', async (req, res) => {
      try {
        const diskConfig = await this.readConfigFile();
        const channels = this.normalizePushChannels(this.getPushChannelsFromConfig(diskConfig));

        res.json({
          success: true,
          data: channels
        });
      } catch (err) {
        logger.error('读取推送通道配置失败:', err);
        res.status(500).json({
          success: false,
          error: err.message
        });
      }
    });

    // 保存推送通道配置
    this.app.put('/api/push/channels', async (req, res) => {
      try {
        const rawChannels = Array.isArray(req.body) ? req.body : req.body?.channels;
        const channels = this.normalizePushChannels(rawChannels);
        this.validatePushChannels(channels);
        await this.savePushChannels(channels);

        res.json({
          success: true,
          message: '推送通道配置已保存',
          data: channels
        });
      } catch (err) {
        logger.error('保存推送通道配置失败:', err);
        res.status(400).json({
          success: false,
          error: err.message
        });
      }
    });

    // 测试推送通道
    this.app.post('/api/push/test', async (req, res) => {
      try {
        if (!this.pushManager) {
          return res.status(500).json({
            success: false,
            error: '推送管理器未初始化'
          });
        }

        const channel = this.normalizePushChannel(req.body?.channel || req.body);
        this.validatePushChannel(channel, { requireDestination: true });

        const success = await this.pushManager.pushToChannel(
          { ...channel, enabled: true },
          '测试号码',
          '这是一条短信网关推送测试消息',
          new Date().toISOString()
        );

        if (!success) {
          return res.status(502).json({
            success: false,
            error: '测试推送发送失败，请查看运行日志'
          });
        }

        res.json({
          success: true,
          message: '测试推送已发送'
        });
      } catch (err) {
        logger.error('测试推送失败:', err);
        res.status(400).json({
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
