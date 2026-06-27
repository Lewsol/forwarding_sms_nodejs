import { parse } from 'node-pdu';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class SMSProcessor {
  constructor(config, modem, concatManager, pushManager) {
    this.config = config;
    this.modem = modem;
    this.concatManager = concatManager;
    this.pushManager = pushManager;
    this.receivedMessages = [];
    this.receivedMessageSeq = 0;
    this.maxReceivedMessages = this.resolveMaxReceivedMessages();
    this.receivedMessagesFile = this.resolveReceivedMessagesFile();
    this.partitionMessagesBySim = this.resolvePartitionMessagesBySim();
    this.allowAllSimMessages = this.resolveAllowAllSimMessages();
    this.currentSimIdentity = null;
    this.currentSimCheckedAt = 0;
    this.currentSimLookup = null;
    this.simIdentityTtlMs = 5 * 1000;
    this.loadReceivedMessages();
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
      const simIdentity = await this.getCurrentSimIdentity();

      logger.info('✓ PDU解析成功');
      logger.info(`发送者: ${sender}`);
      logger.info(`时间戳: ${timestamp}`);
      logger.info(`收件SIM: ${simIdentity?.simLabel || '未知SIM'}`);
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
          timestamp,
          { simIdentity }
        );
      } else {
        // 普通短信，直接处理
        await this.processSmsContent(sender, text, timestamp, { simIdentity });
      }
    } catch (err) {
      logger.error('处理PDU失败:', err);
    }
  }

  /**
   * 处理短信内容并转发
   */
  async processSmsContent(sender, text, timestamp, options = {}) {
    const simIdentity = options.simIdentity !== undefined
      ? this.normalizeSimIdentity(options.simIdentity)
      : await this.getCurrentSimIdentity();

    logger.info('=== 处理短信内容 ===');
    logger.info(`发送者: ${sender}`);
    logger.info(`时间戳: ${timestamp}`);
    logger.info(`收件SIM: ${simIdentity?.simLabel || '未知SIM'}`);
    logger.info(`内容: ${text}`);
    logger.info('====================');

    const messageRecord = this.addReceivedMessage(sender, text, timestamp, simIdentity);

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
  addReceivedMessage(sender, text, timestamp, simIdentity = null) {
    const normalizedSimIdentity = this.normalizeSimIdentity(simIdentity);
    const message = {
      id: `${Date.now()}-${++this.receivedMessageSeq}`,
      sender,
      text,
      timestamp,
      receivedAt: new Date().toISOString(),
      simId: normalizedSimIdentity?.simId || '',
      simLabel: normalizedSimIdentity?.simLabel || '未知SIM',
      status: 'received',
      statusText: '已接收'
    };

    this.receivedMessages.unshift(message);
    if (this.receivedMessages.length > this.maxReceivedMessages) {
      this.receivedMessages.length = this.maxReceivedMessages;
    }

    this.persistReceivedMessages();
    logger.info(`短信已进入Web收件箱: ${sender} (${message.simLabel})`);
    return message;
  }

  /**
   * 更新收件箱短信状态。
   */
  updateReceivedMessage(id, patch) {
    const message = this.receivedMessages.find(item => item.id === id);
    if (message) {
      Object.assign(message, patch);
      this.persistReceivedMessages();
    }
  }

  /**
   * 获取最近收到的短信。
   */
  getReceivedMessages(limit = 50) {
    return this.receivedMessages.slice(0, this.resolveReceivedMessagesLimit(limit));
  }

  /**
   * 获取按SIM作用域过滤后的短信。
   */
  listReceivedMessages(limit = 50, options = {}) {
    const safeLimit = this.resolveReceivedMessagesLimit(limit);
    const requestedScope = String(options.scope || 'current').trim().toLowerCase();
    const currentSim = this.normalizeSimIdentity(options.currentSimIdentity);
    const includeAllSims = requestedScope === 'all' && this.allowAllSimMessages;

    let effectiveScope = includeAllSims ? 'all' : 'current';
    let messages = this.receivedMessages;

    if (this.partitionMessagesBySim && !includeAllSims) {
      if (currentSim?.simId) {
        messages = this.receivedMessages.filter(message => message.simId === currentSim.simId);
      } else {
        messages = [];
        effectiveScope = 'unavailable';
      }
    } else if (!this.partitionMessagesBySim) {
      effectiveScope = 'all';
    }

    return {
      messages: messages.slice(0, safeLimit),
      meta: {
        limit: safeLimit,
        total: messages.length,
        scope: effectiveScope,
        requestedScope,
        partitionBySim: this.partitionMessagesBySim,
        allSimMessagesAllowed: this.allowAllSimMessages,
        allSimMessagesDenied: this.partitionMessagesBySim && requestedScope === 'all' && !this.allowAllSimMessages,
        currentSim,
        currentSimKnown: Boolean(currentSim?.simId)
      }
    };
  }

  /**
   * 限制收件箱查询条数。
   */
  resolveReceivedMessagesLimit(limit = 50) {
    return Math.min(Math.max(Number(limit) || 50, 1), this.maxReceivedMessages);
  }

  /**
   * 解析收件箱保留条数。
   */
  resolveMaxReceivedMessages() {
    const configured = Number(this.config.inbox?.maxReceivedMessages);
    if (!Number.isFinite(configured) || configured <= 0) {
      return 200;
    }

    return Math.min(Math.floor(configured), 5000);
  }

  /**
   * 是否按当前SIM隔离Web收件箱。默认开启，避免换卡后读取其他SIM历史。
   */
  resolvePartitionMessagesBySim() {
    return this.config.inbox?.partitionBySim !== false;
  }

  /**
   * 是否允许显式查询全部SIM历史。默认关闭。
   */
  resolveAllowAllSimMessages() {
    return this.config.inbox?.allowAllSimMessages === true;
  }

  /**
   * 解析收件箱持久化文件路径。
   */
  resolveReceivedMessagesFile() {
    const configuredPath = this.config.inbox?.receivedMessagesFile || 'data/received-messages.json';
    if (path.isAbsolute(configuredPath)) {
      return configuredPath;
    }

    return path.join(__dirname, '..', configuredPath);
  }

  /**
   * 启动时加载持久化收件箱。
   */
  loadReceivedMessages() {
    try {
      fs.mkdirSync(path.dirname(this.receivedMessagesFile), { recursive: true });

      if (!fs.existsSync(this.receivedMessagesFile)) {
        logger.info(`短信收件箱持久化文件不存在，将在收到短信后创建: ${this.receivedMessagesFile}`);
        return;
      }

      const content = fs.readFileSync(this.receivedMessagesFile, 'utf8').trim();
      if (!content) {
        return;
      }

      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed)) {
        logger.warn('短信收件箱持久化文件格式不是数组，已忽略');
        return;
      }

      this.receivedMessages = parsed
        .map(item => this.normalizeStoredMessage(item))
        .filter(Boolean)
        .slice(0, this.maxReceivedMessages);

      logger.info(`已加载持久化短信收件箱: ${this.receivedMessages.length} 条`);
    } catch (err) {
      logger.error('加载短信收件箱持久化文件失败:', err);
      this.receivedMessages = [];
    }
  }

  /**
   * 保存当前收件箱到磁盘。
   */
  persistReceivedMessages() {
    try {
      fs.mkdirSync(path.dirname(this.receivedMessagesFile), { recursive: true });
      const tmpFile = `${this.receivedMessagesFile}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmpFile,
        `${JSON.stringify(this.receivedMessages, null, 2)}\n`,
        'utf8'
      );
      fs.renameSync(tmpFile, this.receivedMessagesFile);
    } catch (err) {
      logger.error('保存短信收件箱持久化文件失败:', err);
    }
  }

  /**
   * 规范化历史短信记录，避免坏数据影响Web展示。
   */
  normalizeStoredMessage(item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return null;
    }

    const id = String(item.id || '').trim();
    if (!id) {
      return null;
    }

    const simIdentity = this.normalizeStoredSimIdentity(item);

    return {
      id,
      sender: String(item.sender || '未知号码'),
      text: String(item.text || ''),
      timestamp: String(item.timestamp || item.receivedAt || new Date().toISOString()),
      receivedAt: String(item.receivedAt || new Date().toISOString()),
      simId: simIdentity?.simId || '',
      simLabel: simIdentity?.simLabel || '未知SIM',
      status: String(item.status || 'received'),
      statusText: String(item.statusText || '已接收')
    };
  }

  /**
   * 从历史记录中恢复SIM身份。旧记录没有SIM字段，会归到未知SIM。
   */
  normalizeStoredSimIdentity(item) {
    if (item.simId || item.simLabel) {
      return this.normalizeSimIdentity({
        simId: item.simId,
        simLabel: item.simLabel
      });
    }

    if (item.sim && typeof item.sim === 'object') {
      return this.normalizeSimIdentity(item.sim);
    }

    if (item.simIccid || item.iccid) {
      return this.createSimIdentityFromICCID(item.simIccid || item.iccid);
    }

    return null;
  }

  /**
   * 获取当前SIM身份，用于收到短信时打标和Web收件箱过滤。
   */
  async getCurrentSimIdentity(options = {}) {
    const refresh = options.refresh === true;
    const now = Date.now();

    if (!refresh && this.currentSimCheckedAt && now - this.currentSimCheckedAt < this.simIdentityTtlMs) {
      return this.currentSimIdentity;
    }

    if (this.currentSimLookup) {
      return this.currentSimLookup;
    }

    if (!this.modem?.getICCID) {
      this.currentSimIdentity = null;
      this.currentSimCheckedAt = now;
      return null;
    }

    this.currentSimLookup = (async () => {
      try {
        const iccid = await this.modem.getICCID({ refresh: true });
        return this.setCurrentSimFromICCID(iccid);
      } catch (err) {
        logger.warn(`查询当前SIM标识失败: ${err.message}`);
        this.currentSimIdentity = null;
        this.currentSimCheckedAt = Date.now();
        return null;
      } finally {
        this.currentSimLookup = null;
      }
    })();

    return this.currentSimLookup;
  }

  /**
   * 使用ICCID更新当前SIM身份缓存。
   */
  setCurrentSimFromICCID(iccid) {
    return this.setCurrentSimIdentity(this.createSimIdentityFromICCID(iccid));
  }

  /**
   * 更新当前SIM身份缓存。
   */
  setCurrentSimIdentity(identity) {
    this.currentSimIdentity = this.normalizeSimIdentity(identity);
    this.currentSimCheckedAt = Date.now();
    return this.currentSimIdentity;
  }

  /**
   * 根据ICCID生成稳定但不暴露完整卡号的SIM标识。
   */
  createSimIdentityFromICCID(iccid) {
    const normalized = this.normalizeICCID(iccid);
    if (!normalized) {
      return null;
    }

    return {
      simId: crypto.createHash('sha256').update(`iccid:${normalized}`).digest('hex').slice(0, 24),
      simLabel: this.formatSimLabel(normalized)
    };
  }

  normalizeICCID(iccid) {
    return String(iccid || '').replace(/\D/g, '');
  }

  formatSimLabel(iccid) {
    const value = String(iccid || '');
    if (!value) {
      return '未知SIM';
    }

    return `ICCID ...${value.slice(-6)}`;
  }

  normalizeSimIdentity(identity) {
    if (!identity) {
      return null;
    }

    if (typeof identity === 'string') {
      return this.createSimIdentityFromICCID(identity);
    }

    if (typeof identity !== 'object' || Array.isArray(identity)) {
      return null;
    }

    if (identity.iccid || identity.simIccid) {
      return this.createSimIdentityFromICCID(identity.iccid || identity.simIccid);
    }

    const simId = String(identity.simId || identity.id || '').trim();
    if (!simId) {
      return null;
    }

    return {
      simId,
      simLabel: String(identity.simLabel || identity.label || '未知SIM')
    };
  }

}

export default SMSProcessor;
