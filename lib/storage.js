/**
 * storage.js — chrome.storage 读写封装
 * 配置项通过 chrome.storage.sync 跨设备同步
 * 运行时状态（如每日用量）通过 chrome.storage.local 存储
 */

// ==================== 默认配置 ====================

const DEFAULT_CONFIG = {
  // 云文档配置（飞书）
  feishu_app_id: '',
  feishu_app_secret: '',
  feishu_table_app_token: '',    // 多维表格 ID（飞书称为 app_token）
  feishu_table_name: '',         // 数据表名称

  // 大模型配置
  llm_provider: 'deepseek',      // 当前选中的模型厂家 key
  llm_api_key: '',
  llm_model_name: 'deepseek-chat',
  llm_base_url: 'https://api.deepseek.com/v1',

  // 用量设置
  daily_limit: 50                // 每日 API 调用上限
};

// ==================== 模型厂家预设 ====================

const LLM_PROVIDERS = [
  // --- 国内厂家 ---
  {
    key: 'deepseek',
    name: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    default_model: 'deepseek-chat',
    region: 'cn'
  },
  {
    key: 'zhipu',
    name: '智谱AI (GLM)',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    default_model: 'glm-4-flash',
    region: 'cn'
  },
  {
    key: 'qwen',
    name: '通义千问 (阿里)',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    default_model: 'qwen-plus',
    region: 'cn'
  },
  {
    key: 'moonshot',
    name: 'Moonshot (Kimi)',
    base_url: 'https://api.moonshot.cn/v1',
    default_model: 'moonshot-v1-8k',
    region: 'cn'
  },
  {
    key: 'baichuan',
    name: '百川 (Baichuan)',
    base_url: 'https://api.baichuan-ai.com/v1',
    default_model: 'Baichuan4',
    region: 'cn'
  },
  {
    key: 'yi',
    name: '零一万物 (Yi)',
    base_url: 'https://api.lingyiwanwu.com/v1',
    default_model: 'yi-large',
    region: 'cn'
  },
  {
    key: 'minimax',
    name: 'MiniMax',
    base_url: 'https://api.minimax.chat/v1',
    default_model: 'abab6.5s-chat',
    region: 'cn'
  },
  {
    key: 'stepfun',
    name: '阶跃星辰 (StepFun)',
    base_url: 'https://api.stepfun.com/v1',
    default_model: 'step-1-8k',
    region: 'cn'
  },
  {
    key: 'doubao',
    name: '字节豆包 (Doubao)',
    base_url: 'https://ark.cn-beijing.volces.com/api/v3',
    default_model: 'doubao-pro-32k',
    region: 'cn'
  },
  {
    key: 'hunyuan',
    name: '腾讯混元 (Hunyuan)',
    base_url: 'https://api.hunyuan.cloud.tencent.com/v1',
    default_model: 'hunyuan-lite',
    region: 'cn'
  },
  {
    key: 'baidu',
    name: '百度千帆 (ERNIE)',
    base_url: 'https://qianfan.baidubce.com/v2',
    default_model: 'ernie-4.0-turbo-8k',
    region: 'cn'
  },
  {
    key: 'xfyun',
    name: '讯飞星火 (Spark)',
    base_url: 'https://spark-api-open.xf-yun.com/v1',
    default_model: 'spark4.0-ultra',
    region: 'cn'
  },
  {
    key: 'siliconflow',
    name: '硅基流动 (SiliconFlow)',
    base_url: 'https://api.siliconflow.cn/v1',
    default_model: 'Qwen/Qwen2.5-7B-Instruct',
    region: 'cn'
  },
  // --- 国际厂家 ---
  {
    key: 'openai',
    name: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-4o',
    region: 'intl'
  },
  {
    key: 'anthropic',
    name: 'Anthropic (Claude)',
    base_url: 'https://api.anthropic.com/v1',
    default_model: 'claude-sonnet-4-6',
    region: 'intl'
  },
  {
    key: 'google',
    name: 'Google Gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    default_model: 'gemini-2.5-flash',
    region: 'intl'
  },
  {
    key: 'groq',
    name: 'Groq',
    base_url: 'https://api.groq.com/openai/v1',
    default_model: 'llama-3.1-8b-instant',
    region: 'intl'
  },
  {
    key: 'mistral',
    name: 'Mistral AI',
    base_url: 'https://api.mistral.ai/v1',
    default_model: 'mistral-small-latest',
    region: 'intl'
  },
  {
    key: 'together',
    name: 'Together AI',
    base_url: 'https://api.together.xyz/v1',
    default_model: 'meta-llama/Llama-3.1-8B-Instruct',
    region: 'intl'
  },
  {
    key: 'xai',
    name: 'xAI (Grok)',
    base_url: 'https://api.x.ai/v1',
    default_model: 'grok-2',
    region: 'intl'
  },
  {
    key: 'perplexity',
    name: 'Perplexity',
    base_url: 'https://api.perplexity.ai',
    default_model: 'sonar',
    region: 'intl'
  },
  // --- 自定义 ---
  {
    key: 'custom',
    name: '自定义 (Custom)',
    base_url: '',
    default_model: '',
    region: 'custom'
  }
];

// ==================== 存储 API ====================

/**
 * 获取全部配置（合并默认值）
 * @returns {Promise<object>}
 */
async function getConfig() {
  const result = await chrome.storage.sync.get(DEFAULT_CONFIG);
  // 合并默认值，防止新增字段缺失
  return { ...DEFAULT_CONFIG, ...result };
}

/**
 * 保存配置（部分更新）
 * @param {object} partial - 要更新的配置字段
 */
async function saveConfig(partial) {
  await chrome.storage.sync.set(partial);
}

/**
 * 获取全部配置的同步版本（用于 options 页面初始化）
 * @returns {Promise<object>}
 */
async function getFullConfig() {
  return getConfig();
}

// ==================== 每日用量管理 ====================

/**
 * 获取今日已用 API 次数 + 是否达到上限
 * @returns {Promise<{today: number, limit: number, blocked: boolean}>}
 */
async function getDailyUsage() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const config = await getConfig();
  const result = await chrome.storage.local.get(['usage_date', 'usage_count']);
  const limit = config.daily_limit || 50;

  if (result.usage_date !== today) {
    // 新的一天，重置计数
    await chrome.storage.local.set({ usage_date: today, usage_count: 0 });
    return { today: 0, limit, blocked: false };
  }

  const count = result.usage_count || 0;
  return { today: count, limit, blocked: count >= limit };
}

/**
 * 增加一次 API 调用计数（每次成功调用大模型后 +1）
 */
async function incrementDailyUsage() {
  const today = new Date().toISOString().split('T')[0];
  const result = await chrome.storage.local.get(['usage_date', 'usage_count']);

  if (result.usage_date !== today) {
    await chrome.storage.local.set({ usage_date: today, usage_count: 1 });
  } else {
    await chrome.storage.local.set({ usage_date: today, usage_count: (result.usage_count || 0) + 1 });
  }
}

/**
 * 重置今日用量（用户手动触发）
 */
async function resetDailyUsage() {
  await chrome.storage.local.set({ usage_date: '', usage_count: 0 });
}

// ==================== 模型厂家查询 ====================

/**
 * 根据 key 获取厂家预设
 * @param {string} key
 * @returns {object|undefined}
 */
function getProviderByKey(key) {
  return LLM_PROVIDERS.find(p => p.key === key);
}

/**
 * 获取全部厂家列表
 * @returns {Array}
 */
function getAllProviders() {
  return LLM_PROVIDERS;
}
