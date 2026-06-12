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
let tokenPromise = null; // 防止并发刷新

/**
 * 获取飞书 tenant_access_token（带缓存 + 并发去重）
 * @returns {Promise<string>}
 */
async function getFeishuToken() {
  // 缓存未过期，直接返回
  if (cachedToken && Date.now() < tokenExpireAt - 60000) {
    return cachedToken;
  }

  // 已有进行中的刷新请求，复用同一个 Promise（去重）
  if (tokenPromise) {
    return tokenPromise;
  }

  tokenPromise = (async () => {
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
  })();

  try {
    return await tokenPromise;
  } finally {
    tokenPromise = null;
  }
}

// ==================== table_id 缓存 ====================

const tableIdCache = new Map(); // key: `${appToken}:${tableName}`, value: table_id

/**
 * 清空 table_id 缓存（表格结构变更后调用）
 */
function clearTableIdCache() {
  tableIdCache.clear();
}

// ==================== 多维表格操作 ====================

/**
 * 向飞书多维表格新增一条记录
 * @param {object} fields - 字段键值对，如 { page_url: "https://...", page_summary: "..." }
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
    // 根据飞书错误码给出中文提示
    let hint = '';
    if (data.code === 91403) {
      hint = '【权限不足】请检查：① 飞书开发者后台是否已添加 bitable:app 权限 ② 是否已发布新版本 ③ 点击配置页「🔧 修复表格权限」按钮修复';
    } else if (data.code === 91401) {
      hint = '【表格不存在】请检查多维表格 ID 和数据表名称是否正确';
    } else if (data.code === 91400) {
      hint = '【字段不存在】请确认表格中的列名与要求的完全一致（页面URL、页面内容总结）';
    }
    throw new Error(`飞书 API 错误 [${data.code}]: ${data.msg} ${hint}`);
  }

  return data;
}

/**
 * 查询「书签收藏」表中是否已存在相同 URL 的记录
 * @param {string} url - 要查询的页面 URL
 * @returns {Promise<{found: boolean, record_id?: string}>}
 */
async function findRecordByUrl(url) {
  const config = await getConfig();
  const token = await getFeishuToken();
  const appToken = config.feishu_table_app_token;
  const targetTable = config.feishu_table_name;

  if (!appToken || !targetTable) return { found: false };

  let tableId;
  try {
    tableId = await getTableId(token, appToken, targetTable);
  } catch (_) {
    return { found: false };
  }

  // 飞书 Bitable filter 语法：精确匹配 URL
  const filter = `CurrentValue.[页面URL]="${url}"`;
  const queryUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?filter=${encodeURIComponent(filter)}&page_size=1`;

  const response = await fetch(queryUrl, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!response.ok) return { found: false };

  const data = await response.json();
  if (data.code !== 0) return { found: false };

  const items = data.data?.items || [];
  if (items.length > 0) {
    return { found: true, record_id: items[0].record_id };
  }

  return { found: false };
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
    // addLog 在 Service Worker 中由 background.js 定义
    if (typeof addLog === 'function') {
      addLog('warn', `失败记录已保存到飞书: ${(bookmark.title || '').substring(0, 30)}`, reason);
    }
  } catch (error) {
    console.error('[智能收藏夹] 写入失败记录到飞书失败:', error.message);
    if (typeof addLog === 'function') {
      addLog('error', '写入失败记录表也失败了: ' + error.message);
    }
  }
}

/**
 * 根据数据表名称获取 table_id（带缓存）
 * @param {string} token - tenant_access_token
 * @param {string} appToken - 多维表格 ID
 * @param {string} tableName - 数据表名称
 * @returns {Promise<string>} table_id
 */
async function getTableId(token, appToken, tableName) {
  const cacheKey = `${appToken}:${tableName}`;
  const cached = tableIdCache.get(cacheKey);
  if (cached) return cached;

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

  tableIdCache.set(cacheKey, table.table_id);
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

// ==================== 失败记录管理 ====================

const FAILED_TABLE_NAME = '同步失败记录';

/**
 * 获取飞书「同步失败记录」表中的全部记录
 * @returns {Promise<Array<{record_id: string, title: string, url: string, reason: string, time: string}>>}
 */
async function getFailedRecords() {
  const config = await getConfig();
  const token = await getFeishuToken();
  const appToken = config.feishu_table_app_token;

  if (!appToken) {
    throw new Error('飞书表格配置不完整：缺少多维表格 ID');
  }

  // 先检查表是否存在
  let tableId;
  try {
    tableId = await getTableId(token, appToken, FAILED_TABLE_NAME);
  } catch (e) {
    // 表不存在，返回空列表
    return [];
  }

  // 分页读取全部记录
  const allRecords = [];
  let pageToken = undefined;

  do {
    let url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=500`;
    if (pageToken) url += `&page_token=${pageToken}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      throw new Error(`读取失败记录列表失败 (${response.status})`);
    }

    const data = await response.json();
    if (data.code !== 0) {
      throw new Error(`读取失败记录列表错误 (code=${data.code}): ${data.msg}`);
    }

    const items = data.data?.items || [];
    for (const item of items) {
      const fields = item.fields || {};
      allRecords.push({
        record_id: item.record_id,
        title: fields['书签标题'] || '',
        url: fields['页面URL'] || '',
        reason: fields['失败原因'] || '',
        time: fields['失败时间'] || ''
      });
    }

    pageToken = data.data?.has_more ? data.data?.page_token : undefined;
  } while (pageToken);

  return allRecords;
}

/**
 * 获取失败记录数量
 * @returns {Promise<number>}
 */
async function getFailedRecordCount() {
  try {
    const records = await getFailedRecords();
    return records.length;
  } catch (e) {
    return 0;
  }
}

/**
 * 从飞书「同步失败记录」表中删除一条记录
 * @param {string} recordId - 飞书记录 ID
 * @returns {Promise<void>}
 */
async function deleteFailedRecord(recordId) {
  const config = await getConfig();
  const token = await getFeishuToken();
  const appToken = config.feishu_table_app_token;

  const tableId = await getTableId(token, appToken, FAILED_TABLE_NAME);

  const response = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
    {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    }
  );

  if (!response.ok) {
    throw new Error(`删除失败记录失败 (${response.status})`);
  }

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`删除失败记录错误 (code=${data.code}): ${data.msg}`);
  }
}

// ==================== 一键创建多维表格 ====================

/**
 * 通过 API 一键创建多维表格，包含两个数据表和全部列字段
 *
 * 应用作为创建者自动拥有完整读写权限，无需通过分享面板手动授权。
 * 这是解决「手动创建表格 → 91403 Forbidden」问题的最可靠方式。
 *
 * @returns {Promise<{success: boolean, message: string, app_token?: string}>}
 */
async function createBitableAndTables() {
  const config = await getConfig();
  const token = await getFeishuToken();

  // --- 1. 创建多维表格应用 ---
  const appResp = await fetch(
    'https://open.feishu.cn/open-apis/bitable/v1/apps',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name: '我的收藏夹' })
    }
  );

  if (!appResp.ok) {
    const text = await appResp.text();
    throw new Error(`创建多维表格失败 (${appResp.status}): ${text}`);
  }

  const appData = await appResp.json();
  if (appData.code !== 0) {
    throw new Error(`创建多维表格 API 错误 [${appData.code}]: ${appData.msg}`);
  }

  const appToken = appData.data.app.app_token;

  // --- 2. 创建「书签收藏」数据表（3 列） ---
  const table1Resp = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        table: {
          name: '书签收藏',
          fields: [
            { field_name: '页面URL', type: 1 },
            { field_name: '页面内容总结', type: 1 }
          ]
        }
      })
    }
  );

  const table1Data = await table1Resp.json();
  if (table1Data.code !== 0) {
    throw new Error(`创建「书签收藏」表失败 [${table1Data.code}]: ${table1Data.msg}`);
  }

  // --- 3. 创建「同步失败记录」数据表（4 列） ---
  const table2Resp = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        table: {
          name: '同步失败记录',
          fields: [
            { field_name: '书签标题', type: 1 },
            { field_name: '页面URL', type: 1 },
            { field_name: '失败原因', type: 1 },
            { field_name: '失败时间', type: 1 }
          ]
        }
      })
    }
  );

  const table2Data = await table2Resp.json();
  if (table2Data.code !== 0) {
    throw new Error(`创建「同步失败记录」表失败 [${table2Data.code}]: ${table2Data.msg}`);
  }

  // --- 4. 设置权限（企业内成员可编辑） ---
  // tenant_editable：企业内任何人打开链接即可编辑，解决「表格属应用所有、用户无法编辑」的问题
  try {
    await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/permissions/${appToken}/public?type=bitable`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          link_share_entity: 'tenant_editable',
          external_access_entity: 'open'
        })
      }
    );
  } catch (_) {
    // 非关键步骤，忽略失败
  }

  // --- 5. 获取多维表格的网页访问地址 ---
  let appUrl = '';
  try {
    const infoResp = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}`,
      {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${token}` }
      }
    );
    const infoData = await infoResp.json();
    if (infoData.code === 0 && infoData.data?.app?.url) {
      appUrl = infoData.data.app.url;
    }
  } catch (_) {
    // 获取 URL 失败不影响主流程
  }

  return {
    success: true,
    app_token: appToken,
    app_url: appUrl,
    message: '多维表格创建成功！已创建「书签收藏」和「同步失败记录」两个数据表，可直接使用。'
  };
}

/**
 * 修复已有表格的权限：设置为企业内成员可编辑
 *
 * 适用场景：之前用旧版插件创建的表格（tenant_readable），用户无法在飞书 UI 中编辑。
 * 修复后企业内任何人打开链接即可编辑，无需手动分享授权。
 *
 * @param {string} [appToken] - 可选，不传则使用当前配置中的多维表格 ID
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function fixTablePermissions(appToken) {
  try {
    const config = await getConfig();
    const token = await getFeishuToken();
    const targetToken = appToken || config.feishu_table_app_token;

    if (!targetToken) {
      return { success: false, message: '请先填写多维表格 ID' };
    }

    const response = await fetch(
      `https://open.feishu.cn/open-apis/drive/v1/permissions/${targetToken}/public?type=bitable`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          link_share_entity: 'tenant_editable',
          external_access_entity: 'open'
        })
      }
    );

    const data = await response.json();
    if (data.code !== 0) {
      return { success: false, message: `权限修复失败 [${data.code}]: ${data.msg}` };
    }

    return { success: true, message: '权限已修复！现在企业内成员都可以编辑该表格。请刷新飞书页面查看。' };
  } catch (error) {
    return { success: false, message: `权限修复失败：${error.message}` };
  }
}

/**
 * 清空「同步失败记录」表中的全部记录
 * @returns {Promise<number>} 删除的记录数
 */
async function clearAllFailedRecords() {
  const records = await getFailedRecords();
  let deleted = 0;
  for (const record of records) {
    try {
      await deleteFailedRecord(record.record_id);
      deleted++;
    } catch (e) {
      console.error('[智能收藏夹] 删除失败记录出错:', record.record_id, e.message);
    }
  }
  return deleted;
}
