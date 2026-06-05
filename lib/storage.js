/**
 * storage.js — chrome.storage 读写封装
 *
 * 安全策略：
 * - 非敏感配置（app_id、表名、用量等）→ chrome.storage.sync 跨设备同步
 * - 敏感凭据（App Secret、API Key）→ chrome.storage.local 仅本机存储，不通过 Google 同步服务传输
 * - 运行时状态（每日用量）→ chrome.storage.local
 */

// ==================== 敏感字段定义 ====================

/**
 * 应存储在 chrome.storage.local 中的字段（明文凭据，仅本机存储）
 * llm_api_keys 单独处理：{ [provider_key]: api_key_string }
 */
const LOCAL_ONLY_KEYS = ['feishu_app_secret'];

// ==================== 默认配置 ====================

const DEFAULT_CONFIG = {
  // 云文档配置（飞书）
  feishu_app_id: '',
  feishu_app_secret: '',         // 实际储存在 chrome.storage.local
  feishu_table_app_token: '',    // 多维表格 ID（飞书称为 app_token）
  feishu_table_name: '',         // 数据表名称

  // 大模型配置
  llm_provider: 'deepseek',      // 当前选中的模型厂家 key
  llm_configs: {},               // 各厂家的非敏感配置：{ [provider_key]: { model_name, base_url } }
                                 // api_key 单独储存在 chrome.storage.local 的 llm_api_keys 中
  custom_providers: [],          // 自定义模型列表：[{ key: 'custom_1', name: '我的模型' }]

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
];

// ==================== 存储 API ====================

/**
 * 获取全部配置（合并默认值 + 合并本地敏感字段）
 *
 * 读取策略：
 * 1. 从 chrome.storage.sync 读取非敏感配置
 * 2. 从 chrome.storage.local 读取敏感字段（feishu_app_secret、llm_api_keys）
 * 3. 将 api_key 回填到 llm_configs 中，恢复完整配置对象
 *
 * @returns {Promise<object>}
 */
async function getConfig() {
  const syncData = await chrome.storage.sync.get(DEFAULT_CONFIG);
  const localData = await chrome.storage.local.get(['feishu_app_secret', 'llm_api_keys']);

  // 合并非敏感配置
  const config = { ...DEFAULT_CONFIG, ...syncData };

  // 从 local 恢复 App Secret（local 优先；若 local 无值则保留 sync 旧数据以兼容迁移）
  if (localData.feishu_app_secret !== undefined) {
    config.feishu_app_secret = localData.feishu_app_secret;
  }

  // 从 local 恢复各厂家的 api_key，回填到 llm_configs
  const apiKeys = localData.llm_api_keys || {};
  const llmConfigs = { ...config.llm_configs };
  for (const [key, apiKey] of Object.entries(apiKeys)) {
    llmConfigs[key] = { ...llmConfigs[key], api_key: apiKey };
  }
  // 如果 sync 中仍有旧数据包含 api_key（迁移前），而 local 中没有，保留它
  for (const [key, cfg] of Object.entries(llmConfigs)) {
    if (cfg.api_key && !apiKeys[key]) {
      // 旧数据，保留不动（下次保存时会自动迁移到 local）
    }
  }
  config.llm_configs = llmConfigs;

  return config;
}

/**
 * 保存配置（部分更新），自动将敏感字段拆分到 chrome.storage.local
 *
 * @param {object} partial - 要更新的配置字段
 */
async function saveConfig(partial) {
  const syncPartial = {};
  const localPartial = {};

  for (const [key, value] of Object.entries(partial)) {
    if (key === 'llm_configs') {
      // 拆分：api_key → local.llm_api_keys，其余 → sync.llm_configs
      const syncConfigs = {};
      const localApiKeys = {};

      // 先合并已有数据（本次只更新传入的 provider，不覆盖未传入的）
      const existingSync = (await chrome.storage.sync.get('llm_configs')).llm_configs || {};
      const existingLocal = (await chrome.storage.local.get('llm_api_keys')).llm_api_keys || {};

      for (const [providerKey, providerConfig] of Object.entries(value)) {
        const { api_key, ...rest } = providerConfig;
        if (Object.keys(rest).length > 0) {
          syncConfigs[providerKey] = rest;
        }
        if (api_key !== undefined && api_key !== '') {
          localApiKeys[providerKey] = api_key;
        }
      }

      syncPartial.llm_configs = { ...existingSync, ...syncConfigs };

      if (Object.keys(localApiKeys).length > 0) {
        localPartial.llm_api_keys = { ...existingLocal, ...localApiKeys };
      }
    } else if (LOCAL_ONLY_KEYS.includes(key)) {
      localPartial[key] = value;
    } else {
      syncPartial[key] = value;
    }
  }

  const promises = [];
  if (Object.keys(syncPartial).length > 0) {
    promises.push(chrome.storage.sync.set(syncPartial));
  }
  if (Object.keys(localPartial).length > 0) {
    promises.push(chrome.storage.local.set(localPartial));
  }
  await Promise.all(promises);
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
 * 根据 key 获取厂家预设（含自定义）
 * @param {string} key
 * @returns {object|undefined}
 */
function getProviderByKey(key) {
  const preset = LLM_PROVIDERS.find(p => p.key === key);
  if (preset) return preset;
  // 可能是自定义厂家，从 custom_providers 或 llm_configs 查找
  return null;
}

/**
 * 获取全部厂家列表（预设 + 已保存的自定义厂家）
 * @param {Array} [customProviders] - 自定义厂家列表
 * @returns {Array}
 */
function getAllProviders(customProviders) {
  const custom = (customProviders || []).map(cp => ({
    key: cp.key,
    name: cp.name,
    base_url: '',
    default_model: '',
    region: 'custom'
  }));
  return [...LLM_PROVIDERS, ...custom];
}

// ==================== 各厂家独立配置 ====================

/**
 * 获取当前选中厂家的 LLM 配置（api_key、model_name、base_url）
 * 优先从 llm_configs 取，没有则用厂家预设默认值
 * @returns {Promise<{api_key: string, model_name: string, base_url: string}>}
 */
async function getCurrentLlmConfig() {
  const config = await getConfig();
  const provider = getProviderByKey(config.llm_provider) || {};
  const saved = config.llm_configs[config.llm_provider] || {};

  return {
    api_key: saved.api_key || '',
    model_name: saved.model_name || provider.default_model || '',
    base_url: saved.base_url || provider.base_url || ''
  };
}

/**
 * 保存当前选中厂家的 LLM 配置
 * @param {{api_key?: string, model_name?: string, base_url?: string}} partial
 */
async function saveCurrentLlmConfig(partial) {
  const config = await getConfig();
  const provider = config.llm_provider;
  const current = config.llm_configs[provider] || {};
  const llm_configs = {
    ...config.llm_configs,
    [provider]: { ...current, ...partial }
  };
  await saveConfig({ llm_configs });
}
