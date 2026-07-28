/** 无效压缩后需再涨多少 token 才重试摘要，避免每轮重复调用摘要模型。 */
export const COMPACTION_RETRY_GROWTH_TOKENS = 4000;
