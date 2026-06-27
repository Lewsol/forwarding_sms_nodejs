import EventEmitter from 'events';
import logger from './logger.js';

class ConcatManager extends EventEmitter {
  constructor() {
    super();
    this.buffer = [];
    this.maxSlots = 5;
    this.maxParts = 10;
    this.timeoutMs = 30000; // 30秒超时
  }

  /**
   * 查找或创建长短信槽位
   */
  findOrCreateSlot(refNumber, sender, totalParts, simIdentity = null) {
    const simId = simIdentity?.simId || '';

    // 先查找是否已存在
    let slot = this.buffer.find(s =>
      s.inUse && s.refNumber === refNumber && s.sender === sender && s.simId === simId
    );

    if (slot) {
      return slot;
    }

    // 查找空闲槽位
    slot = this.buffer.find(s => !s.inUse);
    if (slot) {
      this.initSlot(slot, refNumber, sender, totalParts, simIdentity);
      return slot;
    }

    // 没有空闲槽位，查找最老的槽位覆盖
    if (this.buffer.length < this.maxSlots) {
      slot = {
        inUse: false,
        parts: []
      };
      this.buffer.push(slot);
    } else {
      slot = this.buffer.reduce((oldest, current) =>
        current.firstPartTime < oldest.firstPartTime ? current : oldest
      );
      logger.warn('长短信缓存已满，覆盖最老的槽位');
    }

    this.initSlot(slot, refNumber, sender, totalParts, simIdentity);
    return slot;
  }

  /**
   * 初始化槽位
   */
  initSlot(slot, refNumber, sender, totalParts, simIdentity = null) {
    slot.inUse = true;
    slot.refNumber = refNumber;
    slot.sender = sender;
    slot.simId = simIdentity?.simId || '';
    slot.simIdentity = simIdentity;
    slot.totalParts = totalParts;
    slot.receivedParts = 0;
    slot.firstPartTime = Date.now();
    slot.timestamp = null;
    slot.parts = new Array(totalParts).fill(null);
  }

  /**
   * 添加短信分段
   */
  addPart(refNumber, sender, partNumber, totalParts, text, timestamp, options = {}) {
    logger.info(`收到长短信分段 ${partNumber}/${totalParts}, 参考号: ${refNumber}`);

    const slot = this.findOrCreateSlot(refNumber, sender, totalParts, options.simIdentity);
    const partIndex = partNumber - 1; // partNumber从1开始，数组从0开始

    if (partIndex >= 0 && partIndex < this.maxParts) {
      if (!slot.parts[partIndex]) {
        slot.parts[partIndex] = text;
        slot.receivedParts++;

        // 保存第一个收到的分段的时间戳
        if (slot.receivedParts === 1) {
          slot.timestamp = timestamp;
        }

        logger.info(`已缓存分段 ${partNumber}，当前已收到 ${slot.receivedParts}/${totalParts}`);

        // 检查是否已收齐
        if (slot.receivedParts >= totalParts) {
          logger.info('✅ 长短信已收齐，开始合并转发');
          this.assembleAndEmit(slot);
        }
      } else {
        logger.warn(`⚠️ 分段 ${partNumber} 已存在，跳过`);
      }
    }
  }

  /**
   * 合并并发射完整短信
   */
  assembleAndEmit(slot) {
    let fullText = '';
    for (let i = 0; i < slot.totalParts; i++) {
      if (slot.parts[i]) {
        fullText += slot.parts[i];
      } else {
        fullText += `[缺失分段${i + 1}]`;
      }
    }

    this.emit('complete', {
      sender: slot.sender,
      text: fullText,
      timestamp: slot.timestamp,
      simIdentity: slot.simIdentity
    });

    // 清空槽位
    this.clearSlot(slot);
  }

  /**
   * 清空槽位
   */
  clearSlot(slot) {
    slot.inUse = false;
    slot.parts = [];
    slot.receivedParts = 0;
    slot.simId = '';
    slot.simIdentity = null;
  }

  /**
   * 检查超时
   */
  checkTimeout() {
    const now = Date.now();
    this.buffer.forEach(slot => {
      if (slot.inUse && (now - slot.firstPartTime) >= this.timeoutMs) {
        logger.warn(`⏰ 长短信超时，强制转发不完整消息`);
        logger.warn(`  参考号: ${slot.refNumber}, 已收到: ${slot.receivedParts}/${slot.totalParts}`);
        this.assembleAndEmit(slot);
      }
    });
  }

  /**
   * 启动超时检查定时器
   */
  startTimeoutChecker() {
    this.timeoutChecker = setInterval(() => {
      this.checkTimeout();
    }, 5000); // 每5秒检查一次
    logger.info('长短信超时检查器已启动');
  }

  /**
   * 停止超时检查定时器
   */
  stopTimeoutChecker() {
    if (this.timeoutChecker) {
      clearInterval(this.timeoutChecker);
      this.timeoutChecker = null;
      logger.info('长短信超时检查器已停止');
    }
  }
}

export default ConcatManager;
