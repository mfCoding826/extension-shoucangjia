/**
 * background.js — Service Worker 入口
 *
 * 职责：
 * 1. 监听 chrome.bookmarks.onCreated 事件
 * 2. 抓取页面内容
 * 3. 调用大模型 API 进行分类和摘要
 * 4. 将结果写入飞书多维表格
 * 5. 管理每日用量限制
 */

// ==================== 依赖注入：通过 importScripts 加载模块 ====================

importScripts('lib/storage.js', 'lib/llm.js', 'lib/cloud-doc.js', 'lib/bookmark-parser.js');

// ==================== 批量导入状态 ====================

let batchRunning = false;   // 是否有批量任务进行中
let batchCancelled = false; // 是否已取消

// ==================== 日志系统 ====================

const MAX_LOG_ENTRIES = 200;
const logBuffer = [];

/**
 * 记录一条日志（同时输出到 console）
 * @param {'info'|'success'|'error'|'warn'} level
 * @param {string} message
 * @param {string} [detail]
 */
function addLog(level, message, detail) {
  const now = new Date();
  const time = now.toLocaleTimeString('zh-CN', { hour12: false });
  const entry = { time, level, message, detail: detail || '' };
  logBuffer.push(entry);

  // 同时输出到 console
  const prefix = '[智能收藏夹]';
  switch (level) {
    case 'error': console.error(prefix, message, detail || ''); break;
    case 'warn':  console.warn(prefix, message, detail || ''); break;
    default:      console.log(prefix, message, detail || ''); break;
  }

  // 超出上限时移除旧日志
  while (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.shift();
  }
}

function getLogs() {
  return logBuffer.slice();
}

function clearLogs() {
  logBuffer.length = 0;
}

// ==================== 书签创建事件监听 ====================

chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  addLog('info', `书签创建: ${bookmark.title || '(无标题)'}`);

  try {
    await handleBookmarkCreated(bookmark);
  } catch (error) {
    addLog('error', '处理书签失败: ' + error.message);
    showNotification('同步失败', error.message);
  }
});

// ==================== 核心处理逻辑 ====================

/**
 * 处理新创建的书签
 */
async function handleBookmarkCreated(bookmark) {
  // --- 1. 过滤空收藏（没有 URL 的书签） ---
  if (!bookmark.url) {
    addLog('warn', '跳过空收藏（无URL）');
    return;
  }

  // 过滤非 http/https 协议的 URL
  if (!bookmark.url.startsWith('http://') && !bookmark.url.startsWith('https://')) {
    addLog('warn', `跳过非HTTP协议: ${bookmark.url}`);
    return;
  }

  // --- 2. 检查每日用量限制 ---
  const usage = await getDailyUsage();
  if (usage.blocked) {
    addLog('warn', `每日用量已达上限: ${usage.today}/${usage.limit}`);
    showNotification('达到每日上限', `今日已使用 ${usage.today}/${usage.limit} 次，请在设置中调整上限`);
    return;
  }

  // --- 3. 获取配置 ---
  const config = await getConfig();
  const llmConfig = await getCurrentLlmConfig();

  if (!llmConfig.api_key) {
    addLog('warn', '未配置大模型 API Key');
    showNotification('配置不完整', '请先设置大模型 API Key');
    return;
  }
  if (!config.feishu_app_id || !config.feishu_app_secret) {
    addLog('warn', '未配置飞书应用信息');
    showNotification('配置不完整', '请先设置飞书应用配置');
    return;
  }

  // --- 4. 抓取页面内容 ---
  let pageData = null;
  try {
    pageData = await fetchPageContent(bookmark.url);
    addLog('info', `页面内容抓取成功: ${pageData.title.substring(0, 30)}`);
  } catch (fetchError) {
    addLog('warn', `页面内容抓取失败，使用标题代替: ${fetchError.message}`);
    pageData = {
      title: bookmark.title || '',
      url: bookmark.url,
      content: bookmark.title || ''
    };
  }

  // --- 5. 检查重复（提前到 LLM 调用前，避免浪费 API 额度） ---
  const dupCheck = await findRecordByUrl(pageData.url);
  if (dupCheck.found) {
    addLog('warn', `URL 已存在，跳过: ${pageData.url}`);
    showNotification('已存在，跳过', `「${pageData.title.substring(0, 30)}」已在云文档中`);
    return;
  }

  // --- 6. 调用大模型生成摘要 ---
  showNotification('正在分析...', `正在分析「${pageData.title.substring(0, 30)}」`);

  let pageSummary;

  try {
    pageSummary = await summarizePage(pageData.title, pageData.content);
    await incrementDailyUsage();
    addLog('success', `大模型分析完成: 摘要="${pageSummary.substring(0, 30)}..."`);
  } catch (llmError) {
    addLog('error', `大模型调用失败: ${llmError.message}`, JSON.stringify({ url: pageData.url }));
    showNotification('分析失败', `大模型调用失败：${llmError.message}`);
    return;
  }

  // --- 7. 写入飞书多维表格 ---
  try {
    await addRecord({
      page_url: pageData.url,
      page_summary: pageSummary
    });
    addLog('success', `飞书写入成功: ${pageData.title.substring(0, 30)}`);
  } catch (feishuError) {
    addLog('error', `飞书写入失败: ${feishuError.message}`, JSON.stringify({ url: pageData.url }));
    showNotification('同步失败', `飞书写入失败：${feishuError.message}`);
    return;
  }

  // --- 8. 成功通知 ---
  const newUsage = await getDailyUsage();
  addLog('success', `同步完成 ✅ 用量=${newUsage.today}/${newUsage.limit}`);
  showNotification(
    '收藏同步成功 ✅',
    `摘要：${pageSummary.substring(0, 30)}... | 今日已用 ${newUsage.today}/${newUsage.limit} 次`
  );
}

// ==================== 批量导入书签 ====================

/**
 * 批量处理书签列表（逐条串行执行）
 * @param {Array<{title: string, url: string, folder?: string}>} bookmarks
 */
async function processBatchImport(bookmarks) {
  if (batchRunning) {
    return { success: false, message: '已有批量任务在执行中' };
  }

  batchRunning = true;
  batchCancelled = false;

  const config = await getConfig();
  const llmConfig = await getCurrentLlmConfig();

  // 预检查配置
  if (!llmConfig.api_key) {
    batchRunning = false;
    return { success: false, message: '请先配置大模型 API Key' };
  }
  if (!config.feishu_app_id || !config.feishu_app_secret) {
    batchRunning = false;
    return { success: false, message: '请先配置飞书应用信息' };
  }

  let total = bookmarks.length;
  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;
  const processedUrls = new Set(); // 同批次去重

  addLog('info', `开始批量导入: ${total} 条书签`);
  sendProgress({ phase: 'start', total, message: `开始处理 ${total} 条书签...` });

  for (let i = 0; i < bookmarks.length; i++) {
    // 检查是否取消
    if (batchCancelled) {
      addLog('warn', `批量导入已取消 (已处理 ${i}/${total})`);
      sendProgress({ phase: 'cancelled', current: i, total, successCount, failCount, skippedCount });
      batchRunning = false;
      batchCancelled = false;
      return { success: false, cancelled: true, total, successCount, failCount, skippedCount };
    }

    const bm = bookmarks[i];

    // 检查每日用量
    const usage = await getDailyUsage();
    if (usage.blocked) {
      addLog('warn', `批量导入达到每日上限: ${usage.today}/${usage.limit}`);
      sendProgress({
        phase: 'blocked',
        current: i,
        total,
        successCount,
        failCount,
        skippedCount,
        message: `每日 API 用量已达上限 (${usage.today}/${usage.limit})，剩余 ${total - i} 条跳过`
      });
      skippedCount += (total - i);
      break;
    }

    sendProgress({
      phase: 'processing',
      current: i + 1,
      total,
      successCount,
      failCount,
      skippedCount,
      currentTitle: bm.title
    });

    // 校验 URL
    if (!bm.url || (!bm.url.startsWith('http://') && !bm.url.startsWith('https://'))) {
      skippedCount++;
      await addFailedRecord(bm, '无效 URL：' + (bm.url || '（空）'));
      continue;
    }

    // 检查重复（云端 + 同批次内）
    if (processedUrls.has(bm.url)) {
      skippedCount++;
      continue;
    }
    const dupCheck = await findRecordByUrl(bm.url);
    if (dupCheck.found) {
      processedUrls.add(bm.url);
      skippedCount++;
      continue;
    }
    processedUrls.add(bm.url);

    // 使用书签标题作为内容（批量模式下不打开页面）
    const content = bm.title || '';
    const title = bm.title || '';

    try {
      // 生成摘要
      const pageSummary = await summarizePage(title, content);
      await incrementDailyUsage();

      // 写入飞书
      await addRecord({
        page_url: bm.url,
        page_summary: pageSummary
      });

      successCount++;
      // --- 批量导入成功日志 ---
    } catch (error) {
      failCount++;
      addLog('error', `[${i + 1}/${total}] 导入失败: ${title}`, error.message);
      await addFailedRecord(bm, error.message);
    }
  }

  addLog('info', `批量导入完成: 成功${successCount} 失败${failCount} 跳过${skippedCount}`);

  sendProgress({
    phase: 'complete',
    current: total,
    total,
    successCount,
    failCount,
    skippedCount,
    message: `处理完成：成功 ${successCount}，失败 ${failCount}，跳过 ${skippedCount}`
  });

  batchRunning = false;
  batchCancelled = false;

  return { success: true, total, successCount, failCount, skippedCount };
}

/**
 * 重试飞书「同步失败记录」表中的所有失败书签
 * 成功 → 从失败表删除 + 写入书签收藏表
 * 失败 → 更新失败表中的原因
 */
async function processRetryFailed() {
  if (batchRunning) {
    return { success: false, message: '已有任务在执行中' };
  }

  batchRunning = true;
  batchCancelled = false;

  // 从飞书读取失败记录
  let failedRecords;
  try {
    failedRecords = await getFailedRecords();
  } catch (error) {
    batchRunning = false;
    return { success: false, message: '读取飞书失败记录失败：' + error.message };
  }

  if (failedRecords.length === 0) {
    batchRunning = false;
    sendProgress({ phase: 'complete', total: 0, successCount: 0, failCount: 0, skippedCount: 0, message: '飞书中没有失败记录' });
    return { success: true, total: 0, successCount: 0, failCount: 0, skippedCount: 0 };
  }

  const total = failedRecords.length;
  let successCount = 0;
  let failCount = 0;

  sendProgress({ phase: 'start', total, message: `开始重试 ${total} 条失败书签...` });

  for (let i = 0; i < failedRecords.length; i++) {
    if (batchCancelled) {
      sendProgress({ phase: 'cancelled', current: i, total, successCount, failCount, skippedCount: 0 });
      batchRunning = false;
      batchCancelled = false;
      return { success: false, cancelled: true, total, successCount, failCount, skippedCount: 0 };
    }

    // 检查每日用量
    const usage = await getDailyUsage();
    if (usage.blocked) {
      sendProgress({
        phase: 'blocked', current: i, total, successCount, failCount, skippedCount: 0,
        message: `每日 API 用量已达上限 (${usage.today}/${usage.limit})，剩余 ${total - i} 条跳过`
      });
      break;
    }

    const record = failedRecords[i];
    sendProgress({
      phase: 'processing', current: i + 1, total, successCount, failCount, skippedCount: 0,
      currentTitle: record.title
    });

    if (!record.url || (!record.url.startsWith('http://') && !record.url.startsWith('https://'))) {
      failCount++;
      continue;
    }

    // 检查重复
    const dupCheck = await findRecordByUrl(record.url);
    if (dupCheck.found) {
      // URL 已存在，直接从失败表删除该记录
      try { await deleteFailedRecord(record.record_id); } catch (_) { /* 忽略 */ }
      successCount++;
      continue;
    }

    try {
      const pageSummary = await summarizePage(record.title, record.title);
      await incrementDailyUsage();

      // 写入书签收藏表
      await addRecord({ page_url: record.url, page_summary: pageSummary });

      // 从失败表删除
      await deleteFailedRecord(record.record_id);

      successCount++;
      // --- 重试成功 ---
    } catch (error) {
      failCount++;
      addLog('error', `[${i + 1}/${total}] 重试失败: ${record.title}`, error.message);
      try {
        await deleteFailedRecord(record.record_id);
      } catch (_) { /* 忽略 */ }
      await addFailedRecord({ title: record.title, url: record.url }, '(重试) ' + error.message);
    }
  }

  addLog('info', `重试失败书签完成: 成功${successCount} 失败${failCount}`);
  sendProgress({
    phase: 'complete', current: total, total, successCount, failCount, skippedCount: 0,
    message: `重试完成：成功 ${successCount}，失败 ${failCount}`
  });

  batchRunning = false;
  batchCancelled = false;

  return { success: true, total, successCount, failCount, skippedCount: 0 };
}

/**
 * 向 options 页面发送进度消息
 */
function sendProgress(data) {
  chrome.runtime.sendMessage({ type: 'import_progress', ...data }).catch(() => {
    // options 页面可能未打开，忽略发送失败
  });
}

// ==================== 页面内容抓取 ====================

/**
 * 通过 executeScript 注入 content script 抓取页面内容
 * 策略：优先查找已打开的标签页，如果没有则创建新标签页抓取
 * @param {string} url - 目标页面 URL
 * @returns {Promise<{title: string, url: string, content: string}>}
 */
async function fetchPageContent(url) {
  // 规范化 URL（去除 fragment，统一尾部斜杠）用于匹配
  const normalizedUrl = url.split('#')[0].replace(/\/+$/, '');

  // 精确匹配
  let tabs = await chrome.tabs.query({ url: url });
  if (tabs.length === 0) {
    // 未精确匹配，尝试在所有标签页中按规范化 URL 搜索
    const allTabs = await chrome.tabs.query({});
    tabs = allTabs.filter(t => {
      if (!t.url) return false;
      return t.url.split('#')[0].replace(/\/+$/, '') === normalizedUrl;
    });
  }

  if (tabs.length > 0) {
    // 在已有标签页中注入脚本
    const tab = tabs[0];
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractPageContent
      });
      return results[0]?.result || { title: tab.title, url, content: '' };
    } catch (e) {
      // 如果注入失败（如特权页面），回退到标签页标题
      return { title: tab.title || '', url, content: tab.title || '' };
    }
  }

  // 没有已打开的标签页，创建新标签页抓取（静默抓取后关闭）
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, async (tab) => {
      try {
        // 等待页面加载完成
        await waitForTabLoad(tab.id);

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractPageContent,
          world: 'MAIN'
        });

        const data = results[0]?.result || { title: tab.title, url, content: '' };

        // 关闭临时标签页
        chrome.tabs.remove(tab.id);
        resolve(data);
      } catch (error) {
        // 出错时也要关闭标签页
        try { chrome.tabs.remove(tab.id); } catch (_) { /* 忽略 */ }
        reject(error);
      }
    });
  });
}

/**
 * 等待标签页加载完成
 */
function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('页面加载超时（15 秒）'));
      }
    }, 15000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * 在页面上下文中执行的提取函数（作为函数体传给 executeScript）
 * 注意：此函数在目标页面的 JS 环境中运行，不能访问扩展 API
 */
function extractPageContent() {
  function getText() {
    const articles = document.querySelectorAll('article');
    if (articles.length > 0) {
      return Array.from(articles).map(a => a.textContent).join('\n');
    }
    const main = document.querySelector('main');
    if (main) return main.textContent;

    const clone = document.body.cloneNode(true);
    ['script', 'style', 'noscript', 'nav', 'header', 'footer',
     'aside', 'iframe', 'svg', 'img', 'video', 'audio', 'canvas'
    ].forEach(sel => {
      clone.querySelectorAll(sel).forEach(el => el.remove());
    });
    return clone.textContent || '';
  }

  return {
    title: document.title || '',
    url: window.location.href,
    content: getText().replace(/\s+/g, ' ').trim()
  };
}

// ==================== 通知 ====================

/**
 * 显示 Chrome 通知
 */
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: title,
    message: message,
    priority: 1
  });
}

// ==================== 消息监听（供 options 页面调用） ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'validate_feishu') {
    validateFeishuConfig().then(sendResponse).catch(err => sendResponse({ success: false, message: err.message }));
    return true;
  }

  if (message.type === 'create_feishu_table') {
    createBitableAndTables().then(sendResponse).catch(err => sendResponse({ success: false, message: err.message }));
    return true;
  }

  if (message.type === 'validate_llm') {
    validateLlmConfig().then(sendResponse).catch(err => sendResponse({ success: false, message: err.message }));
    return true;
  }

  if (message.type === 'parse_bookmark_file') {
    // 在 Service Worker 中解析书签文件（避免大文件在页面线程阻塞）
    try {
      const bookmarks = parseBookmarkFile(message.html);
      // 在 Service Worker 中 htmlDecode 可能没有 DOM
      sendResponse({ success: true, bookmarks });
    } catch (err) {
      sendResponse({ success: false, message: err.message });
    }
    return false; // 同步响应
  }

  if (message.type === 'start_import') {
    // 启动批量导入（异步，进度通过 sendMessage 回报）
    processBatchImport(message.bookmarks).then(summary => {
      chrome.runtime.sendMessage({ type: 'import_complete', ...summary }).catch(() => {});
    });
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'cancel_import') {
    batchCancelled = true;
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'get_failed_count') {
    getFailedRecordCount().then(count => sendResponse({ count })).catch(() => sendResponse({ count: 0 }));
    return true;
  }

  if (message.type === 'retry_failed') {
    processRetryFailed().then(summary => {
      chrome.runtime.sendMessage({ type: 'import_complete', ...summary }).catch(() => {});
    });
    sendResponse({ success: true });
    return false;
  }

  if (message.type === 'get_logs') {
    sendResponse({ logs: getLogs() });
    return false;
  }

  if (message.type === 'clear_logs') {
    clearLogs();
    sendResponse({ success: true });
    return false;
  }
});

// ==================== 每日用量定时重置 ====================

/**
 * 设置午夜重置闹钟
 */
function setupDailyResetAlarm() {
  chrome.alarms.create('daily-reset', {
    // 每天凌晨 0:01 触发
    when: getNextMidnight(),
    periodInMinutes: 24 * 60
  });
}

function getNextMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 1, 0, 0); // 次日 0:01
  return midnight.getTime();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'daily-reset') {
    console.log('[智能收藏夹] 每日用量自动重置');
    await chrome.storage.local.set({ usage_date: '', usage_count: 0 });
  }
});

// ==================== 启动时初始化 ====================

setupDailyResetAlarm();

// 点击扩展图标时打开配置页面
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

console.log('[智能收藏夹] Service Worker 启动完成');
