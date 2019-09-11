# amqplib-delay

# Install

> npm i amqplib-delay -S

## usage

```ts
import { ConfirmChannel } from "amqplib";
import { MQ, defaultDelayTime } from "amqplib-delay";

export const mq = new MQ();
(async () => {
  await mq.connect("amqp://localhost");

  //创建重试延时队列
  await mq.ch.addSetup(async (ch: ConfirmChannel) => {
    return Promise.all([mq.createDelayQueue(ch)]);
  });

  let delayConfig = {
    ...MQ.createQueueKey("delay"),
    //第一次延时
    delay: 1,
    //重试延时
    retryExpire: [
      defaultDelayTime["15s"],
      defaultDelayTime["30s"],
      defaultDelayTime["1m"]
    ]
  };

  await mq.ch.addSetup(async (ch: ConfirmChannel) => {
    let payNotifyHandler = await MQ.delayTask(ch, delayConfig);
    let start = new Date();
    return Promise.all([
      ...payNotifyHandler,
      mq.consumeRetry(ch, delayConfig.deadLetterQueue, async content => {
        console.log(content);
        let now = new Date();
        throw new Error(
          `at [${now}], delay:[${(now.getTime() -
            new Date(content.startAt).getTime()) /
            1000}] test`
        );
      })
    ] as any);
  });

  mq.sendToQueueDelayByConfig(delayConfig, {
    startAt: new Date(),
    text: "dealy and retry"
  });
})();
```
