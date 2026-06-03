/**
 * llm.js — 大模型通用调用模块
 *
 * 所有厂家统一走 OpenAI 兼容的 /v1/chat/completions 接口。
 * 从 chrome.storage 动态读取配置，不硬编码任何 API Key。
 */

// ==================== 分类 Prompt ====================

const CLASSIFY_SYSTEM_PROMPT = `你是一个网页内容分类助手。根据用户提供的网页标题、URL 和正文摘要，判断该页面属于什么类型。

分类规则：
1. 优先从以下类别中选择一个最匹配的：科技、教育、生活、人工智能、大模型、财经、娱乐、工具、设计、游戏、医疗、法律、体育、旅游、美食、时尚、房产、汽车、编程、开源、创业、职场、心理学、哲学、历史、文学、艺术、音乐、电影、动漫、摄影、宠物、育儿、军事、时政、科学、环境、农业、物流、电商、安全、云计算、数据库、运维、测试、硬件、物联网、区块链、元宇宙。
2. 如果页面内容无法归入以上类别，可以自创一个简洁准确的类别名（不超过 6 个字）。
3. 如果页面内容很少或无法判断，返回"其他"。

请直接返回类别名称，不要加任何解释、标点或换行。`;

const SUMMARIZE_SYSTEM_PROMPT = `你是一个网页内容总结助手。请根据提供的网页标题和正文内容，用简洁的语言总结页面核心要点。

要求：
- 字数控制在 100 字以内
- 突出页面的核心主题和关键信息
- 使用中文输出
- 不要包含"本文"、"该页面"等冗余开头
- 如果内容很少或无法判断，返回"无法总结"`;

// ==================== API 调用 ====================

/**
 * 通用大模型调用
 * @param {object} opts
 * @param {string} opts.base_url - API 地址
 * @param {string} opts.api_key - API Key
 * @param {string} opts.model_name - 模型名称
 * @param {string} opts.system_prompt - 系统提示词
 * @param {string} opts.user_prompt - 用户提示词
 * @param {number} [opts.temperature=0.3] - 温度参数
 * @param {number} [opts.max_tokens=300] - 最大 token 数
 * @returns {Promise<string>} 模型返回的文本内容
 */
async function callLLM({
  base_url,
  api_key,
  model_name,
  system_prompt,
  user_prompt,
  temperature = 0.3,
  max_tokens = 300
}) {
  // 去除 base_url 末尾可能存在的斜杠
  const cleanBaseUrl = base_url.replace(/\/+$/, '');
  const url = `${cleanBaseUrl}/chat/completions`;

  const body = {
    model: model_name,
    messages: [
      { role: 'system', content: system_prompt },
      { role: 'user', content: user_prompt }
    ],
    temperature,
    max_tokens
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${api_key}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`大模型 API 调用失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  // 兼容不同的响应格式
  if (data.choices && data.choices.length > 0 && data.choices[0].message) {
    return data.choices[0].message.content.trim();
  }

  throw new Error(`大模型返回格式异常: ${JSON.stringify(data)}`);
}

/**
 * 调用大模型进行页面分类
 * @param {string} title - 页面标题
 * @param {string} url - 页面 URL
 * @param {string} content - 页面正文（截取前 3000 字）
 * @returns {Promise<string>} 页面类型
 */
async function classifyPage(title, url, content) {
  const config = await getConfig();

  // 截取内容，控制 token 消耗
  const truncatedContent = content.substring(0, 3000);
  const userPrompt = `页面标题：${title}\n页面URL：${url}\n页面正文（节选）：\n${truncatedContent}`;

  const result = await callLLM({
    base_url: config.llm_base_url,
    api_key: config.llm_api_key,
    model_name: config.llm_model_name,
    system_prompt: CLASSIFY_SYSTEM_PROMPT,
    user_prompt: userPrompt,
    temperature: 0.1,
    max_tokens: 50
  });

  return result;
}

/**
 * 调用大模型进行页面内容总结
 * @param {string} title - 页面标题
 * @param {string} content - 页面正文
 * @returns {Promise<string>} 页面总结（100 字以内）
 */
async function summarizePage(title, content) {
  const config = await getConfig();

  const truncatedContent = content.substring(0, 3000);
  const userPrompt = `页面标题：${title}\n页面正文（节选）：\n${truncatedContent}`;

  const result = await callLLM({
    base_url: config.llm_base_url,
    api_key: config.llm_api_key,
    model_name: config.llm_model_name,
    system_prompt: SUMMARIZE_SYSTEM_PROMPT,
    user_prompt: userPrompt,
    temperature: 0.3,
    max_tokens: 200
  });

  return result;
}
