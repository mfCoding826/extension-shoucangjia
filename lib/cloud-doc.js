/**
 * cloud-doc.js — 飞书多维表格 API 封装
 *
 * 飞书开放平台文档：https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview
 *
 * 流程：
 * 1. 使用 app_id + app_secret 获取 tenant_access_token
 * 2. 使用 token 调用多维表格 API 写入数据
 */

// ==================== Token 管理 ====================

let cachedToken = null;
let tokenExpireAt = 0; // 过期时间戳（毫秒）

/**
 * 获取飞书 tenant_access_token（带缓存）
 * @returns {Promise<string>}
 */
async function getFeishuToken() {
  // 缓存未过期，直接返回
  if (cachedToken && Date.now() < tokenExpireAt - 60000) {
    return cachedToken;
  }

  const config = await getConfig();

  if (!config.feishu_app_id || !config.feishu_app_secret) {
    throw new Error('飞书应用配置不完整：缺少 App ID 或 App Secret');
  }

  const response = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.feishu_app_id,
        app_secret: config.feishu_app_secret
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`获取飞书 Token 失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`飞书 Token 接口返回错误 (code=${data.code}): ${data.msg}`);
  }

  cachedToken = data.tenant_access_token;
  // token 有效期 2 小时，提前 5 分钟刷新
  tokenExpireAt = Date.now() + (data.expire || 7200) * 1000;

  return cachedToken;
}

// ==================== 多维表格操作 ====================

/**
 * 向飞书多维表格新增一条记录
 * @param {object} fields - 字段键值对，如 { page_type: "科技", page_url: "https://...", page_summary: "..." }
 * @param {string} [tableName] - 可选，指定数据表名称；不传则使用配置中的默认表
 * @param {object} [fieldMapping] - 可选，自定义字段映射 { 飞书列名: fields中的key }
 * @returns {Promise<object>} API 响应
 */
async function addRecord(fields, tableName, fieldMapping) {
  const config = await getConfig();
  const token = await getFeishuToken();

  const appToken = config.feishu_table_app_token;
  const targetTable = tableName || config.feishu_table_name;

  if (!appToken || !targetTable) {
    throw new Error('飞书表格配置不完整：缺少多维表格 ID 或数据表名称');
  }

  // 首先需要获取 table_id（通过 table_name 查找）
  const tableId = await getTableId(token, appToken, targetTable);

  // 构建请求体，支持自定义字段映射
  const bodyFields = {};
  if (fieldMapping) {
    // 自定义映射：{ 飞书列名: fields中的key }
    for (const [colName, fieldKey] of Object.entries(fieldMapping)) {
      bodyFields[colName] = (fields[fieldKey] !== undefined ? fields[fieldKey] : '') + '';
    }
  } else {
    // 默认映射：书签同步表
    bodyFields['页面类型'] = fields.page_type || '';
    bodyFields['页面URL'] = fields.page_url || '';
    bodyFields['页面内容总结'] = fields.page_summary || '';
  }

  const response = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ fields: bodyFields })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`飞书写入记录失败 (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`飞书写入记录返回错误 (code=${data.code}): ${data.msg}`);
  }

  return data;
}

/**
 * 写入一条失败记录到「同步失败记录」表
 * @param {object} bookmark - { title, url }
 * @param {string} reason - 失败原因
 * @returns {Promise<void>}
 */
async function addFailedRecord(bookmark, reason) {
  try {
    await addRecord(
      {
        title: bookmark.title || '',
        url: bookmark.url || '',
        reason: reason || '未知错误',
        time: new Date().toLocaleString('zh-CN')
      },
      '同步失败记录',
      {
        '书签标题': 'title',
        '页面URL': 'url',
        '失败原因': 'reason',
        '失败时间': 'time'
      }
    );
  } catch (error) {
    // 写入失败记录本身失败时，静默处理（避免无限递归）
    console.error('[智能收藏夹] 写入失败记录到飞书失败:', error.message);
  }
}

/**
 * 根据数据表名称获取 table_id
 * @param {string} token - tenant_access_token
 * @param {string} appToken - 多维表格 ID
 * @param {string} tableName - 数据表名称
 * @returns {Promise<string>} table_id
 */
async function getTableId(token, appToken, tableName) {
  const response = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    throw new Error(`获取飞书表格列表失败 (${response.status})`);
  }

  const data = await response.json();

  if (data.code !== 0) {
    throw new Error(`获取飞书表格列表返回错误 (code=${data.code}): ${data.msg}`);
  }

  // 查找匹配的数据表
  const items = data.data?.items || [];
  const table = items.find(t => t.name === tableName);

  if (!table) {
    throw new Error(
      `未找到名为「${tableName}」的数据表，请先在飞书多维表格中创建该表。` +
      `当前表格列表：${items.map(t => t.name).join('、') || '（空）'}`
    );
  }

  return table.table_id;
}

/**
 * 验证飞书配置是否有效：尝试获取 token 并列出表格
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function validateFeishuConfig() {
  try {
    const config = await getConfig();

    if (!config.feishu_app_id || !config.feishu_app_secret) {
      return { success: false, message: '请先填写飞书 App ID 和 App Secret' };
    }
    if (!config.feishu_table_app_token) {
      return { success: false, message: '请先填写多维表格 ID' };
    }

    const token = await getFeishuToken();

    // 尝试列出表格，验证 app_token 是否有效
    const response = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.feishu_table_app_token}/tables`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );

    const data = await response.json();

    if (data.code === 0) {
      const tables = data.data?.items || [];
      const tableNames = tables.map(t => t.name).join('、');
      return {
        success: true,
        message: `连接成功！找到 ${tables.length} 个数据表：${tableNames || '（空）'}`
      };
    }

    return { success: false, message: `多维表格访问失败：${data.msg}（code=${data.code}）` };
  } catch (error) {
    return { success: false, message: `验证失败：${error.message}` };
  }
}
