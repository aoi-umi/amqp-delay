import * as amqp from 'amqp-connection-manager';
import { Options, ConfirmChannel, ConsumeMessage } from 'amqplib';

const logger = console;
type DelayKey = {
    queue: string;
    exchange: string;
    deadLetterExchange: string;
    deadLetterQueue: string;
    deadLetterRoutingKey: string;
};
type RetryContent<T = any> = {
    retryExpire: string[];
    data: T,
    sendAt?: Date,
};
type DelayContent = {
    delay: string;
    data: DelayContentData;
};
type DelayContentData = {
    queue: string,
    data: RetryContent
};
type QueueConfigType = DelayKey & {
    delay: number;
    retryExpire?: string[];
};

export type DelayConfig<T = { [key: string]: string }> = {
    expireTime: T,
    queuePrefix: string;
};

export const defaultDelayTime = {
    '15s': '15s',
    '30s': '30s',
    '1m': '1m',
};

//固定延时
const delayConfig: DelayConfig<typeof defaultDelayTime> = {
    expireTime: defaultDelayTime,
    queuePrefix: 'retry_queue'
};

export class MQ<T = typeof defaultDelayTime> {
    delayConfig: DelayConfig<T> = delayConfig as any;
    constructor(opt?: {
        delayConfig?: Partial<DelayConfig<T>>,
    }) {
        opt = {
            ...opt
        };
        if (opt.delayConfig) {
            this.delayConfig = {
                ...this.delayConfig,
                ...opt.delayConfig,
            };
        }
    }
    conn: amqp.AmqpConnectionManager;
    ch: amqp.ChannelWrapper;

    async connect(uri: string) {
        if (this.conn)
            return this.conn;
        let conn = amqp.connect([uri]);
        this.conn = conn;
        this.ch = conn.createChannel({
            // json: true
        });
        return this.conn;
    }

    async sendToQueue(queue: string, content: any, options?: Options.Publish) {
        let msg = JSON.stringify(content);
        let msgBuffer = Buffer.from(msg);
        logger.info(`${new Date()} send queue [${queue}]`);
        return this.ch.sendToQueue(queue, msgBuffer, options).catch(e => {
            logger.error(`send queue [${queue}] fail:`);
            logger.error(msg);
            throw e;
        });
    }

    async consume(ch: ConfirmChannel, queue: string, onMessage: (msg: ConsumeMessage | null, content: any) => any, options?: Options.Consume) {
        return ch.consume(queue, (msg) => {
            let msgStr = msg.content.toString();
            logger.info(`handle queue [${queue}] ${msgStr}`);
            let obj = JSON.parse(msg.content.toString());
            return onMessage(msg, obj);
        }, options);
    }

    private async sendToQueueDelay(content: DelayContent) {
        let rs = MQ.getDelayQueue(this.delayConfig.queuePrefix, content.delay);
        return this.sendToQueue(rs.queue, content.data, {
            expiration: rs.expire,
        });
    }

    /**
     * 队列是按顺序处理的，每个queue的延迟时间必须固定
     */
    async sendToQueueDelayByConfig(cfg: QueueConfigType, data: any) {
        let content: RetryContent = {
            data,
            retryExpire: cfg.retryExpire
        };
        let options: Options.Publish = {};
        if (!cfg.delay)
            throw new Error('delay is required');
        options.expiration = cfg.delay;
        return this.sendToQueueRetry(cfg.queue, content, options);
    }

    private async sendToQueueRetry(queue: string, content: RetryContent, options?: Options.Publish) {
        if (!content.sendAt)
            content.sendAt = new Date();
        return this.sendToQueue(queue, content, options);
    }

    async consumeRetry(ch: ConfirmChannel, queue: string, onMessage: (content: any, msg: ConsumeMessage | null) => any) {
        return this.consume(ch, queue, async (msg, obj: RetryContent) => {
            if (!obj.retryExpire)
                obj.retryExpire = [];
            let retryCount = obj.retryExpire.length;
            let delay = obj.retryExpire.shift();
            try {
                await onMessage(obj.data, msg);
            } catch (e) {
                if (retryCount > 0) {
                    if (delay) {
                        this.sendToQueueDelay({
                            delay,
                            data: {
                                queue,
                                data: obj
                            }
                        });
                    } else {
                        this.sendToQueueRetry(queue, obj);
                    }
                }
                logger.error(`handle queue [${queue}] fail: ${e.message}`);
                logger.error(JSON.stringify(obj));
            }
        }, { noAck: true });
    }

    static getDelayQueue(queue, time) {
        return {
            queue: queue + '_' + time,
            expire: MQ.parseTime(time)
        };
    }

    static parseTime(time: string) {
        let timeUnit = {
            s: 1000,
            m: 1000 * 60,
            h: 1000 * 60 * 60,
            d: 1000 * 60 * 60 * 24,
        };
        let unit = time.substr(time.length - 1);
        let num = time.substr(0, time.length - 1);
        let matchTime = timeUnit[unit];
        let timeNum = parseInt(num);
        if (!matchTime || isNaN(timeNum)) {
            throw new Error(`invalid time [${time}]`);
        }
        return timeNum * matchTime;
    }

    static createQueueKey(queue: string): DelayKey {
        return {
            queue,
            exchange: queue + '_exchange',
            deadLetterExchange: queue + '_dle',
            deadLetterQueue: queue + '_dlq',
            deadLetterRoutingKey: queue + '_dlrk',
        };
    }

    static async delayTask(ch: ConfirmChannel, queue: DelayKey) {
        let producer = await ch.assertQueue(queue.queue, {
            exclusive: false,
            deadLetterExchange: queue.deadLetterExchange,
            deadLetterRoutingKey: queue.deadLetterRoutingKey,
        });

        ch.assertExchange(queue.deadLetterExchange, 'direct', { durable: false });
        let consumer = await ch.assertQueue(queue.deadLetterQueue, { exclusive: false });
        ch.bindQueue(consumer.queue, queue.deadLetterExchange, queue.deadLetterRoutingKey);
        return [producer, consumer];
    }

    /**
     * 创建延时队列
     */
    async createDelayQueue(ch: ConfirmChannel) {
        let mq = this;
        let delayCfg = this.delayConfig;
        let list = [];
        let consumeQueue = '';
        for (let key in delayCfg.expireTime) {
            let time = delayCfg.expireTime[key];
            let q = MQ.createQueueKey(delayCfg.queuePrefix);
            consumeQueue = q.deadLetterQueue;
            let rs = MQ.getDelayQueue(q.queue, time);
            q.queue = rs.queue;
            let delayTask = await MQ.delayTask(ch, q);
            list = [...list, ...delayTask];
        }
        if (consumeQueue) {
            let consume = mq.consume(ch, consumeQueue, (msg, content: DelayContentData) => {
                mq.sendToQueueRetry(content.queue, content.data);
            }, { noAck: true });
            list.push(consume);
        }
        return list;
    }
}