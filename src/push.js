import nodemailer from 'nodemailer';
import axios from 'axios';
import crypto from 'crypto';
import logger from './logger.js';

class PushManager {
  constructor(config) {
    this.config = config;
    this.smtpTransporter = null;

    // 初始化SMTP
    if (config.smtp && config.smtp.server) {
      this.smtpTransporter = nodemailer.createTransport({
        host: config.smtp.server,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: {
          user: config.smtp.user,
          pass: config.smtp.pass
        }
      });
    }
  }

  /**
   * 发送邮件通知
   */
  async sendEmail(subject, body) {
    if (!this.smtpTransporter) {
      logger.warn('邮件配置不完整，跳过发送');
      return false;
    }

    try {
      await this.smtpTransporter.sendMail({
        from: `"SMS Notify" <${this.config.smtp.user}>`,
        to: this.config.smtp.sendTo,
        subject: subject,
        text: body
      });
      logger.info('✓ 邮件发送成功');
      return true;
    } catch (err) {
      logger.error('邮件发送失败:', err);
      return false;
    }
  }

  /**
   * 发送到所有启用的推送通道
   */
  async pushToAll(sender, message, timestamp) {
    const channels = this.config.pushChannels || [];
    const promises = [];

    for (const channel of channels) {
      if (channel.enabled) {
        promises.push(this.pushToChannel(channel, sender, message, timestamp));
      }
    }

    await Promise.allSettled(promises);
  }

  /**
   * 发送到单个推送通道
   */
  async pushToChannel(channel, sender, message, timestamp) {
    logger.info(`推送到通道: ${channel.name} (${channel.type})`);

    try {
      switch (channel.type) {
        case 'post_json':
          return await this.pushPostJSON(channel, sender, message, timestamp);
        case 'bark':
          return await this.pushBark(channel, sender, message);
        case 'get':
          return await this.pushGET(channel, sender, message, timestamp);
        case 'dingtalk':
          return await this.pushDingTalk(channel, sender, message);
        case 'pushplus':
          return await this.pushPushPlus(channel, sender, message);
        case 'serverchan':
          return await this.pushServerChan(channel, sender, message);
        case 'custom':
          return await this.pushCustom(channel, sender, message, timestamp);
        case 'feishu':
          return await this.pushFeishu(channel, sender, message);
        case 'telegram':
          return await this.pushTelegram(channel, sender, message);
        default:
          logger.warn(`未知的推送类型: ${channel.type}`);
          return false;
      }
    } catch (err) {
      logger.error(`推送到 ${channel.name} 失败:`, err);
      return false;
    }
  }

  /**
   * POST JSON 推送
   */
  async pushPostJSON(channel, sender, message, timestamp) {
    const response = await axios.post(channel.url, {
      sender,
      message,
      timestamp
    }, {
      timeout: 10000
    });
    logger.info(`✓ POST JSON推送成功: ${response.status}`);
    return true;
  }

  /**
   * Bark 推送
   */
  async pushBark(channel, sender, message) {
    const response = await axios.post(channel.url, {
      title: sender,
      body: message
    }, {
      timeout: 10000
    });
    logger.info(`✓ Bark推送成功: ${response.status}`);
    return true;
  }

  /**
   * GET 推送
   */
  async pushGET(channel, sender, message, timestamp) {
    const url = new URL(channel.url);
    url.searchParams.set('sender', sender);
    url.searchParams.set('message', message);
    url.searchParams.set('timestamp', timestamp);

    const response = await axios.get(url.toString(), {
      timeout: 10000
    });
    logger.info(`✓ GET推送成功: ${response.status}`);
    return true;
  }

  /**
   * 钉钉机器人推送
   */
  async pushDingTalk(channel, sender, message) {
    let url = channel.url;

    // 如果配置了secret，进行签名
    if (channel.secret) {
      const timestamp = Date.now();
      const sign = this.dingtalkSign(channel.secret, timestamp);
      url += `&timestamp=${timestamp}&sign=${sign}`;
    }

    const response = await axios.post(url, {
      msgtype: 'text',
      text: {
        content: `来自: ${sender}\n\n${message}`
      }
    }, {
      timeout: 10000
    });
    logger.info(`✓ 钉钉推送成功: ${response.status}`);
    return true;
  }

  /**
   * 钉钉签名
   */
  dingtalkSign(secret, timestamp) {
    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(stringToSign);
    const sign = hmac.digest('base64');
    return encodeURIComponent(sign);
  }

  /**
   * PushPlus 推送
   */
  async pushPushPlus(channel, sender, message) {
    const response = await axios.post('http://www.pushplus.plus/send', {
      token: channel.key1,
      title: `来自 ${sender}`,
      content: message,
      template: 'html'
    }, {
      timeout: 10000
    });
    logger.info(`✓ PushPlus推送成功: ${response.status}`);
    return true;
  }

  /**
   * Server酱 推送
   */
  async pushServerChan(channel, sender, message) {
    const url = `https://sctapi.ftqq.com/${channel.key1}.send`;
    const response = await axios.post(url, {
      title: `来自 ${sender}`,
      desp: message
    }, {
      timeout: 10000
    });
    logger.info(`✓ Server酱推送成功: ${response.status}`);
    return true;
  }

  /**
   * 自定义模板推送
   */
  async pushCustom(channel, sender, message, timestamp) {
    let body = channel.customBody || '{}';
    body = body.replace('{sender}', sender);
    body = body.replace('{message}', message);
    body = body.replace('{timestamp}', timestamp);

    const response = await axios.post(channel.url, JSON.parse(body), {
      timeout: 10000
    });
    logger.info(`✓ 自定义推送成功: ${response.status}`);
    return true;
  }

  /**
   * 飞书机器人推送
   */
  async pushFeishu(channel, sender, message) {
    let url = channel.url;

    // 如果配置了secret，进行签名
    if (channel.secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const sign = this.feishuSign(channel.secret, timestamp);
      url += `&timestamp=${timestamp}&sign=${sign}`;
    }

    const response = await axios.post(url, {
      msg_type: 'text',
      content: {
        text: `来自: ${sender}\n\n${message}`
      }
    }, {
      timeout: 10000
    });
    logger.info(`✓ 飞书推送成功: ${response.status}`);
    return true;
  }

  /**
   * 飞书签名
   */
  feishuSign(secret, timestamp) {
    const stringToSign = `${timestamp}\n${secret}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(stringToSign);
    return hmac.digest('base64');
  }

  /**
   * Telegram Bot 推送
   */
  async pushTelegram(channel, sender, message) {
    const botToken = channel.url; // url字段存储bot token
    const chatId = channel.key1;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

    const response = await axios.post(url, {
      chat_id: chatId,
      text: `来自: ${sender}\n\n${message}`
    }, {
      timeout: 10000
    });
    logger.info(`✓ Telegram推送成功: ${response.status}`);
    return true;
  }
}

export default PushManager;
