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

importScripts('lib/storage.js', 'lib/llm.js', 'lib/cloud-doc.js');

// ==================== 书签创建事件监听 ====================

chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  console.log('[智能收藏夹] 书签创建事件触发:', bookmark.title);

  try {
    await handleBookmarkCreated(bookmark);
  } catch (error) {
    console.error('[智能收藏夹] 处理书签失败:', error);
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
    console.log('[智能收藏夹] 跳过无 URL 的书签（可能是空文件夹）');
    return;
  }

  // 过滤非 http/https 协议的 URL（如 chrome://、edge://、about: 等）
  if (!bookmark.url.startsWith('http://') && !bookmark.url.startsWith('https://')) {
    console.log('[智能收藏夹] 跳过非 HTTP 协议的 URL:', bookmark.url);
    return;
  }

  // --- 2. 检查每日用量限制 ---
  const usage = await getDailyUsage();
  if (usage.blocked) {
    console.log('[智能收藏夹] 今日 API 调用次数已达上限:', usage.limit);
    showNotification('达到每日上限', `今日已使用 ${usage.today}/${usage.limit} 次，请在设置中调整上限`);
    return;
  }

  // --- 3. 获取配置 ---
  const config = await getConfig();

  // 检查必要配置是否存在
  if (!config.llm_api_key) {
    console.log('[智能收藏夹] 未配置大模型 API Key，跳过处理');
    showNotification('配置不完整', '请先设置大模型 API Key');
    return;
  }
  if (!config.feishu_app_id || !config.feishu_app_secret) {
    console.log('[智能收藏夹] 未配置飞书信息，跳过处理');
    showNotification('配置不完整', '请先设置飞书应用配置');
    return;
  }

  // --- 4. 抓取页面内容 ---
  // 查找包含该书签 URL 的标签页
  let pageData = null;
  try {
    pageData = await fetchPageContent(bookmark.url);
  } catch (fetchError) {
    console.warn('[智能收藏夹] 页面内容抓取失败，使用书签标题:', fetchError.message);
    // 如果抓取失败，使用书签标题作为退路
    pageData = {
      title: bookmark.title || '',
      url: bookmark.url,
      content: bookmark.title || ''
    };
  }

  // --- 5. 调用大模型 API ---
  showNotification('正在分析...', `正在分析「${pageData.title.substring(0, 30)}」`);

  let pageType, pageSummary;

  try {
    // 分类和摘要可以并行调用
    [pageType, pageSummary] = await Promise.all([
      classifyPage(pageData.title, pageData.url, pageData.content),
      summarizePage(pageData.title, pageData.content)
    ]);

    // 每次成功的 LLM 调用计数 +2（分类 + 摘要）
    await incrementDailyUsage();
    await incrementDailyUsage();
  } catch (llmError) {
    console.error('[智能收藏夹] 大模型调用失败:', llmError);
    showNotification('分析失败', `大模型调用失败：${llmError.message}`);
    return;
  }

  console.log('[智能收藏夹] 分析结果:', { pageType, pageSummary });

  // --- 6. 写入飞书多维表格 ---
  try {
    await addRecord({
      page_type: pageType,
      page_url: pageData.url,
      page_summary: pageSummary
    });
  } catch (feishuError) {
    console.error('[智能收藏夹] 飞书写入失败:', feishuError);
    showNotification('同步失败', `飞书写入失败：${feishuError.message}`);
    return;
  }

  // --- 7. 成功通知 ---
  const newUsage = await getDailyUsage();
  showNotification(
    '收藏同步成功 ✅',
    `类型：${pageType} | 今日已用 ${newUsage.today}/${newUsage.limit} 次`
  );
}

// ==================== 页面内容抓取 ====================

/**
 * 通过 executeScript 注入 content script 抓取页面内容
 * 策略：优先查找已打开的标签页，如果没有则创建新标签页抓取
 * @param {string} url - 目标页面 URL
 * @returns {Promise<{title: string, url: string, content: string}>}
 */
async function fetchPageContent(url) {
  // 查找是否已有该 URL 的标签页
  const tabs = await chrome.tabs.query({ url: url });

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
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('页面加载超时（15 秒）'));
    }, 15000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
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
    // 异步验证飞书配置
    validateFeishuConfig().then(result => {
      sendResponse(result);
    }).catch(error => {
      sendResponse({ success: false, message: error.message });
    });
    return true; // 保持消息通道开启，等待异步响应
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
