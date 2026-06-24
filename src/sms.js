import { parse } from 'node-pdu';
import logger from './logger.js';

class SMSProcessor {
  constructor(config, modem, concatManager, pushManager) {
    this.config = config;
    this.modem = modem;
    this.concatManager = concatManager;
    this.pushManager = pushManager;
    this.receivedMessages = [];
    this.receivedMessageSeq = 0;
    this.maxReceivedMessages = 200;
  }

  /**
   * 处理接收到的PDU短信
   */
  async processPDU(pduHex) {
    try {
      logger.info('开始解析PDU数据...');

      // 解析PDU
      const parsed = parse(pduHex);

      if (!parsed) {
        logger.error('PDU解析失败');
        return;
      }

      const sender = parsed.address?.phone || '未知号码';
      const timestamp = parsed.serviceCenterTimeStamp?.getIsoString?.() || new Date().toISOString();
      const text = parsed.data?.getText?.() || '';
      const part = parsed.data?.parts?.[0];
      const header = part?.header;

      logger.info('✓ PDU解析成功');
      logger.info(`发送者: ${sender}`);
      logger.info(`时间戳: ${timestamp}`);
      logger.info(`内容: ${text}`);

      // 检查是否为长短信
      if (header && header.getType() !== undefined) {
        // 长短信头部
        const refNumber = header.getPointer();
        const totalParts = header.getSegments();
        const partNumber = header.getCurrent();

        logger.info(`长短信信息: 参考号=${refNumber}, 当前=${partNumber}, 总计=${totalParts}`);

        // 添加到长短信缓存
        this.concatManager.addPart(
          refNumber,
          sender,
          partNumber,
          totalParts,
          text,
          timestamp
        );
      } else {
        // 普通短信，直接处理
        await this.processSmsContent(sender, text, timestamp);
      }
    } catch (err) {
      logger.error('处理PDU失败:', err);
    }
  }

  /**
   * 处理短信内容并转发
   */
  async processSmsContent(sender, text, timestamp) {
    logger.info('=== 处理短信内容 ===');
    logger.info(`发送者: ${sender}`);
    logger.info(`时间戳: ${timestamp}`);
    logger.info(`内容: ${text}`);
    logger.info('====================');

    const messageRecord = this.addReceivedMessage(sender, text, timestamp);

    // 推送到所有通道
    await this.pushManager.pushToAll(sender, text, timestamp);

    // 发送邮件通知
    const subject = `短信${sender},${text.substring(0, 20)}`;
    const body = `来自：${sender}，时间：${timestamp}，内容：${text}`;
    await this.pushManager.sendEmail(subject, body);

    this.updateReceivedMessage(messageRecord.id, {
      status: 'forwarded',
      statusText: '已转发'
    });
  }

  /**
   * 记录收到的短信，供Web管理端展示。
   */
  addReceivedMessage(sender, text, timestamp) {
    const message = {
      id: `${Date.now()}-${++this.receivedMessageSeq}`,
      sender,
      text,
      timestamp,
      receivedAt: new Date().toISOString(),
      status: 'received',
      statusText: '已接收'
    };

    this.receivedMessages.unshift(message);
    if (this.receivedMessages.length > this.maxReceivedMessages) {
      this.receivedMessages.length = this.maxReceivedMessages;
    }

    logger.info(`短信已进入Web收件箱: ${sender}`);
    return message;
  }

  /**
   * 更新收件箱短信状态。
   */
  updateReceivedMessage(id, patch) {
    const message = this.receivedMessages.find(item => item.id === id);
    if (message) {
      Object.assign(message, patch);
    }
  }

  /**
   * 获取最近收到的短信。
   */
  getReceivedMessages(limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), this.maxReceivedMessages);
    return this.receivedMessages.slice(0, safeLimit);
  }

}

export default SMSProcessor;
