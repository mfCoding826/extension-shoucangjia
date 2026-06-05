/**
 * options.js — 配置页面交互逻辑
 *
 * 管理四个配置区域：
 * 1. 云文档配置（飞书）
 * 2. 大模型配置（多厂家选择）
 * 3. 用量设置
 * 4. 批量导入书签
 */

// ==================== 页面加载 ====================

document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadUsage();
  await loadFailedCount();
  bindEvents();
  bindImportEvents();
  bindProgressListener();
  bindLogPanel();
});

// ==================== 加载配置 ====================

async function loadConfig() {
  const config = await getFullConfig();

  // 云文档配置
  setValue('feishu_app_id', config.feishu_app_id);
  setValue('feishu_app_secret', config.feishu_app_secret);
  setValue('feishu_table_app_token', config.feishu_table_app_token);
  setValue('feishu_table_name', config.feishu_table_name);

  // 显示已有的多维表格链接
  if (config.feishu_table_app_token) {
    updateTableUrlDisplay(config.feishu_table_app_token,
      `https://feishu.cn/base/${config.feishu_table_app_token}`);
  }

  // 大模型配置
  currentProviderKey = config.llm_provider;
  populateProviderSelect(config.llm_provider, config.custom_providers);
  await loadProviderConfig(config.llm_provider, config);
  toggleCustomFields();

  // 用量设置
  setValue('daily_limit', config.daily_limit);
}

async function loadUsage() {
  const usage = await getDailyUsage();
  document.getElementById('usage_today').textContent = usage.today;
  document.getElementById('usage_limit_display').textContent = usage.limit;
}

function updateTableUrlDisplay(appToken, url) {
  const display = document.getElementById('table_url_display');
  if (!display) return;
  // 只允许 http/https 协议的 URL
  if (!/^https?:\/\//i.test(url)) return;
  const safeUrl = url.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  display.style.display = '';
  display.innerHTML = `🔗 多维表格地址：<a href="${safeUrl}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`;
}

// ==================== 厂家下拉框 ====================

function populateProviderSelect(currentKey, customProviders) {
  const select = document.getElementById('llm_provider');
  const providers = getAllProviders(customProviders || []);

  select.innerHTML = '';

  // 分组：国内 / 国际
  const groups = {
    cn: { label: '🌏 国内厂家', items: [] },
    intl: { label: '🌍 国际厂家', items: [] },
    custom: { label: '🔧 已添加的自定义模型', items: [] }
  };

  providers.forEach(p => {
    if (groups[p.region]) {
      groups[p.region].items.push(p);
    }
  });

  Object.values(groups).forEach(group => {
    if (group.items.length === 0) return;
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    group.items.forEach(p => {
      const option = document.createElement('option');
      option.value = p.key;
      option.textContent = p.name;
      if (p.key === currentKey) option.selected = true;
      optgroup.appendChild(option);
    });
    select.appendChild(optgroup);
  });

  // 底部：新增自定义模型
  const newOpt = document.createElement('option');
  newOpt.value = '__new_custom__';
  newOpt.textContent = '➕ 新增自定义模型';
  if (currentKey === '__new_custom__') newOpt.selected = true;
  select.appendChild(newOpt);
}

// ==================== 事件绑定 ====================

function bindEvents() {
  // 厂家切换时自动填充模型和地址
  document.getElementById('llm_provider').addEventListener('change', onProviderChange);

  // 保存按钮
  document.getElementById('btn_save').addEventListener('click', onSave);

  // 验证飞书配置
  document.getElementById('btn_verify_feishu').addEventListener('click', onVerifyFeishu);

  // 一键创建多维表格
  document.getElementById('btn_create_feishu_table').addEventListener('click', onCreateFeishuTable);

  // 验证大模型配置
  document.getElementById('btn_verify_llm').addEventListener('click', onVerifyLlm);

  // 重置用量
  document.getElementById('btn_reset_usage').addEventListener('click', onResetUsage);

  // 密码可见性切换
  document.querySelectorAll('.toggle-password').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const input = e.target.closest('.input-group').querySelector('input');
      if (input.type === 'password') {
        input.type = 'text';
        e.target.textContent = '🙈';
      } else {
        input.type = 'password';
        e.target.textContent = '👁️';
      }
    });
  });
}

async function onProviderChange(e) {
  if (rebuildingDropdown) return;

  const key = e.target.value;

  // 先保存当前厂家的配置
  if (currentProviderKey && currentProviderKey !== '__new_custom__') {
    await saveConfigForProvider(currentProviderKey);
  }
  currentProviderKey = key;

  if (key === '__new_custom__') {
    // 新增自定义模型：显示名称输入框，清空表单
    document.getElementById('custom_name_group').style.display = 'flex';
    setValue('custom_provider_name', '');
    setValue('llm_api_key', '');
    setValue('llm_model_name', '');
    setValue('llm_base_url', '');
    return;
  }

  // 判断是否为自定义厂家
  const fullConfig = await getFullConfig();
  const customProv = (fullConfig.custom_providers || []).find(cp => cp.key === key);
  if (customProv) {
    document.getElementById('custom_name_group').style.display = 'flex';
    setValue('custom_provider_name', customProv.name);
  } else {
    document.getElementById('custom_name_group').style.display = 'none';
  }

  // 加载新厂家的配置
  await loadProviderConfig(key, fullConfig);
}

let currentProviderKey = null;
let rebuildingDropdown = false;

async function saveConfigForProvider(key) {
  if (!key || key === '__new_custom__') return;

  const name = getValue('custom_provider_name');
  const fullConfig = await getFullConfig();

  const llm_configs = {
    ...fullConfig.llm_configs,
    [key]: {
      api_key: getValue('llm_api_key'),
      model_name: getValue('llm_model_name'),
      base_url: getValue('llm_base_url')
    }
  };

  // 如果是自定义厂家，更新名称
  let customProviders = fullConfig.custom_providers || [];
  if (name) {
    const idx = customProviders.findIndex(cp => cp.key === key);
    if (idx >= 0) {
      customProviders = [...customProviders];
      customProviders[idx] = { ...customProviders[idx], name };
    }
  }

  await saveConfig({ llm_configs, custom_providers: customProviders });
}

async function loadProviderConfig(providerKey, cachedConfig) {
  const config = cachedConfig || await getFullConfig();
  const provider = getProviderByKey(providerKey) || {};
  const saved = (config.llm_configs && config.llm_configs[providerKey]) || {};

  toggleCustomFields();

  // 自定义厂家：显示名称输入框
  const customProv = (config.custom_providers || []).find(cp => cp.key === providerKey);
  if (customProv) {
    document.getElementById('custom_name_group').style.display = 'flex';
    setValue('custom_provider_name', customProv.name);
  } else if (providerKey !== '__new_custom__') {
    document.getElementById('custom_name_group').style.display = 'none';
  }

  setValue('llm_api_key', saved.api_key || '');
  setValue('llm_model_name', saved.model_name || provider.default_model || '');
  setValue('llm_base_url', saved.base_url || provider.base_url || '');
}

function toggleCustomFields() {
  const modelInput = document.getElementById('llm_model_name');
  const urlInput = document.getElementById('llm_base_url');
  if (modelInput) modelInput.removeAttribute('readonly');
  if (urlInput) urlInput.removeAttribute('readonly');
}

// ==================== 保存 ====================

async function onSave() {
  const btn = document.getElementById('btn_save');
  setButtonLoading(btn, true);

  try {
    const dailyLimit = parseInt(getValue('daily_limit')) || 50;
    if (dailyLimit < 1 || dailyLimit > 9999) {
      showToast('每日限额必须在 1~9999 之间', 'error');
      setButtonLoading(btn, false);
      return;
    }

    const currentProvider = getValue('llm_provider');
    const customName = getValue('custom_provider_name').trim();

    // 处理新增自定义模型
    if (currentProvider === '__new_custom__') {
      if (!customName) {
        showToast('请输入自定义模型名称', 'error');
        setButtonLoading(btn, false);
        return;
      }
      // 生成唯一 key 并添加到自定义列表
      const newKey = 'custom_' + Date.now();
      const fullConfig = await getFullConfig();
      const customProviders = [...(fullConfig.custom_providers || []), { key: newKey, name: customName }];

      // 保存自定义厂家配置 + 列表
      const llm_configs = {
        ...fullConfig.llm_configs,
        [newKey]: {
          api_key: getValue('llm_api_key'),
          model_name: getValue('llm_model_name'),
          base_url: getValue('llm_base_url')
        }
      };

      await saveConfig({
        feishu_app_id: getValue('feishu_app_id'),
        feishu_app_secret: getValue('feishu_app_secret'),
        feishu_table_app_token: getValue('feishu_table_app_token'),
        feishu_table_name: getValue('feishu_table_name'),
        llm_provider: newKey,
        llm_configs,
        custom_providers: customProviders,
        daily_limit: dailyLimit
      });

      currentProviderKey = newKey;
      // 重建下拉框（阻止 change 事件引发重复保存）
      rebuildingDropdown = true;
      populateProviderSelect(newKey, customProviders);
      rebuildingDropdown = false;
      document.getElementById('custom_name_group').style.display = 'flex';
      setValue('custom_provider_name', customName);
    } else {
      // 一次 saveConfig 写入全部字段（云文档 + LLM + 用量），避免两次写入不原子
      const fullConfig = await getFullConfig();
      const name = getValue('custom_provider_name').trim();
      const llm_configs = {
        ...fullConfig.llm_configs,
        [currentProvider]: {
          api_key: getValue('llm_api_key'),
          model_name: getValue('llm_model_name'),
          base_url: getValue('llm_base_url')
        }
      };

      // 自定义厂家名称变更
      let customProviders = fullConfig.custom_providers || [];
      if (name) {
        const idx = customProviders.findIndex(cp => cp.key === currentProvider);
        if (idx >= 0) {
          customProviders = [...customProviders];
          customProviders[idx] = { ...customProviders[idx], name };
        }
      }

      await saveConfig({
        feishu_app_id: getValue('feishu_app_id'),
        feishu_app_secret: getValue('feishu_app_secret'),
        feishu_table_app_token: getValue('feishu_table_app_token'),
        feishu_table_name: getValue('feishu_table_name'),
        llm_provider: currentProvider,
        llm_configs,
        custom_providers: customProviders,
        daily_limit: dailyLimit
      });
    }

    showToast('配置保存成功 ✅', 'success');
    await loadUsage();
  } catch (error) {
    showToast('保存失败：' + error.message, 'error');
  } finally {
    setButtonLoading(btn, false);
  }
}

// ==================== 验证飞书 ====================

async function onVerifyFeishu() {
  const btn = document.getElementById('btn_verify_feishu');
  setButtonLoading(btn, true, '验证中...');

  try {
    // 先保存当前配置（验证需要用到）
    await saveConfig({
      feishu_app_id: getValue('feishu_app_id'),
      feishu_app_secret: getValue('feishu_app_secret'),
      feishu_table_app_token: getValue('feishu_table_app_token')
    });

    const result = await chrome.runtime.sendMessage({ type: 'validate_feishu' });
    if (result.success) {
      showToast(result.message, 'success');
    } else {
      showToast(result.message, 'error');
    }
  } catch (error) {
    showToast('验证请求失败：' + error.message, 'error');
  } finally {
    setButtonLoading(btn, false, '验证连接');
  }
}

async function onCreateFeishuTable() {
  const btn = document.getElementById('btn_create_feishu_table');
  const appId = getValue('feishu_app_id');
  const appSecret = getValue('feishu_app_secret');

  if (!appId || !appSecret) {
    showToast('请先填写飞书 App ID 和 App Secret', 'error');
    return;
  }

  if (!confirm('将使用飞书 API 自动创建多维表格（含「书签收藏」和「同步失败记录」两个数据表）。\n\n如果之前已配置过多维表格 ID，将被替换为新建的表格。\n\n确定继续吗？')) {
    return;
  }

  setButtonLoading(btn, true, '创建中...');

  try {
    // 先保存 App ID 和 Secret（创建 API 需要）
    await saveConfig({
      feishu_app_id: appId,
      feishu_app_secret: appSecret
    });

    const result = await chrome.runtime.sendMessage({ type: 'create_feishu_table' });
    if (result.success) {
      // 自动填入 app_token 和表名
      setValue('feishu_table_app_token', result.app_token);
      setValue('feishu_table_name', '书签收藏');

      // 直接保存完整配置（不调用 onSave，避免重复 toast 和 UI 副作用）
      const currentProvider = getValue('llm_provider');
      const fullConfig = await getFullConfig();
      const savePayload = {
        feishu_app_id: appId,
        feishu_app_secret: appSecret,
        feishu_table_app_token: result.app_token,
        feishu_table_name: '书签收藏',
        llm_provider: currentProvider
      };
      // 同时保存当前 LLM 配置
      if (currentProvider && currentProvider !== '__new_custom__') {
        savePayload.llm_configs = {
          ...fullConfig.llm_configs,
          [currentProvider]: {
            api_key: getValue('llm_api_key'),
            model_name: getValue('llm_model_name'),
            base_url: getValue('llm_base_url')
          }
        };
      }
      await saveConfig(savePayload);

      // 显示多维表格 URL 并自动打开
      const tableUrl = result.app_url || `https://feishu.cn/base/${result.app_token}`;
      updateTableUrlDisplay(result.app_token, tableUrl);
      chrome.tabs.create({ url: tableUrl, active: true });

      showToast('多维表格创建成功！🎉 已在浏览器中打开，可直接使用。', 'success');
    } else {
      showToast('创建失败：' + result.message, 'error');
    }
  } catch (error) {
    showToast('创建请求失败：' + error.message, 'error');
  } finally {
    setButtonLoading(btn, false, '一键创建多维表格');
  }
}

async function onVerifyLlm() {
  const btn = document.getElementById('btn_verify_llm');
  setButtonLoading(btn, true, '测试中...');

  try {
    const provider = getValue('llm_provider');
    // 测试前先保存当前表单内容
    if (provider === '__new_custom__') {
      // 还没保存过，先临时保存以便测试
      const tempKey = 'custom_temp_' + Date.now();
      const llm_configs = (await getFullConfig()).llm_configs || {};
      llm_configs[tempKey] = {
        api_key: getValue('llm_api_key'),
        model_name: getValue('llm_model_name'),
        base_url: getValue('llm_base_url')
      };
      await saveConfig({ llm_provider: tempKey, llm_configs });
    } else {
      await saveCurrentLlmConfig({
        api_key: getValue('llm_api_key'),
        model_name: getValue('llm_model_name'),
        base_url: getValue('llm_base_url')
      });
      await saveConfig({ llm_provider: provider });
    }

    const result = await chrome.runtime.sendMessage({ type: 'validate_llm' });
    if (result.success) {
      showToast(result.message, 'success');
    } else {
      showToast(result.message, 'error');
    }
  } catch (error) {
    showToast('测试请求失败：' + error.message, 'error');
  } finally {
    setButtonLoading(btn, false, '测试连接');
  }
}

// ==================== 重置用量 ====================

async function onResetUsage() {
  if (confirm('确定要重置今日用量计数吗？')) {
    await chrome.storage.local.set({ usage_date: '', usage_count: 0 });
    await loadUsage();
    showToast('用量已重置 ✅', 'success');
  }
}

// ==================== 工具函数 ====================

function getValue(id) {
  return document.getElementById(id)?.value || '';
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function setButtonLoading(btn, loading, text) {
  btn.disabled = loading;
  if (loading) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = text || '保存中...';
    btn.classList.add('loading');
  } else {
    btn.textContent = btn.dataset.originalText || text || '保存配置';
    btn.classList.remove('loading');
  }
}

function showToast(message, type) {
  // 移除已有 toast
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // 动画进入
  requestAnimationFrame(() => toast.classList.add('show'));

  // 3 秒后移除
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ==================== 批量导入书签 ====================

let parsedBookmarks = [];    // 解析后的书签列表
let importInProgress = false;

function bindImportEvents() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file_input');
  const btnSelect = document.getElementById('btn_select_file');
  const btnClear = document.getElementById('btn_clear_file');
  const btnStart = document.getElementById('btn_start_import');
  const btnCancel = document.getElementById('btn_cancel_import');
  const btnRetry = document.getElementById('btn_retry_failed');

  // 点击选择文件
  btnSelect.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('click', (e) => {
    if (e.target !== btnSelect) fileInput.click();
  });

  // 文件选择
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleFile(fileInput.files[0]);
  });

  // 拖拽
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
  });

  // 清除文件 + 开始导入 + 取消 + 重试
  btnClear.addEventListener('click', clearFile);
  btnStart.addEventListener('click', startImport);
  btnCancel.addEventListener('click', cancelImport);
  btnRetry.addEventListener('click', retryFailed);
}

async function loadFailedCount() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'get_failed_count' });
    updateRetryButton(result?.count || 0);
  } catch {
    updateRetryButton(0);
  }
}

function updateRetryButton(count) {
  const btn = document.getElementById('btn_retry_failed');
  const text = document.getElementById('retry_count');
  text.textContent = count;
  if (count > 0) {
    btn.disabled = false;
    text.style.color = 'var(--color-error)';
  } else {
    btn.disabled = true;
    text.textContent = '0';
    text.style.color = 'var(--color-text-tertiary)';
  }
}

async function retryFailed() {
  importInProgress = true;

  // 隐藏文件选择区域和重试栏，显示进度
  document.getElementById('import_ready').style.display = 'none';
  document.getElementById('retry_bar').style.display = 'none';
  document.getElementById('import_progress').style.display = 'flex';
  document.getElementById('import_result').style.display = 'none';

  // 重置进度
  document.getElementById('progress_fill').style.width = '0%';
  document.getElementById('progress_counter').textContent = '0 / 0';
  document.getElementById('stat_success').textContent = '0';
  document.getElementById('stat_fail').textContent = '0';
  document.getElementById('stat_skip').textContent = '0';
  document.getElementById('progress_current').textContent = '';
  document.getElementById('progress_title').textContent = '正在读取飞书失败记录...';
  resetStage();

  chrome.runtime.sendMessage({ type: 'retry_failed' }).catch(() => {});
}

async function handleFile(file) {
  if (!file.name.endsWith('.html') && !file.name.endsWith('.htm')) {
    showToast('请选择 .html 格式的书签文件', 'error');
    return;
  }

  try {
    const html = await file.text();
    const result = await chrome.runtime.sendMessage({ type: 'parse_bookmark_file', html });
    if (!result.success) {
      showToast('解析失败：' + result.message, 'error');
      return;
    }
    parsedBookmarks = result.bookmarks;
    if (parsedBookmarks.length === 0) {
      showToast('未在文件中找到有效书签', 'error');
      return;
    }

    // 显示文件信息
    document.getElementById('dropzone').style.display = 'none';
    document.getElementById('file_info').style.display = 'flex';
    document.getElementById('file_name').textContent = file.name;
    document.getElementById('file_count').textContent = `${parsedBookmarks.length} 条书签`;
    document.getElementById('import_result').style.display = 'none';

    showToast(`解析成功，共 ${parsedBookmarks.length} 条书签`, 'success');
  } catch (error) {
    showToast('读取文件失败：' + error.message, 'error');
  }
}

function clearFile() {
  parsedBookmarks = [];
  document.getElementById('file_input').value = '';
  document.getElementById('dropzone').style.display = '';
  document.getElementById('file_info').style.display = 'none';
  document.getElementById('import_progress').style.display = 'none';
  document.getElementById('import_result').style.display = 'none';
  document.getElementById('retry_bar').style.display = '';
  importInProgress = false;
}

async function startImport() {
  if (parsedBookmarks.length === 0) {
    showToast('请先选择书签文件', 'error');
    return;
  }

  importInProgress = true;

  // 切换到进度视图，隐藏其他区域
  document.getElementById('file_info').style.display = 'none';
  document.getElementById('retry_bar').style.display = 'none';
  document.getElementById('import_progress').style.display = 'flex';
  document.getElementById('import_result').style.display = 'none';

  // 重置进度
  document.getElementById('progress_fill').style.width = '0%';
  document.getElementById('progress_counter').textContent = `0 / ${parsedBookmarks.length}`;
  document.getElementById('stat_success').textContent = '0';
  document.getElementById('stat_fail').textContent = '0';
  document.getElementById('stat_skip').textContent = '0';
  document.getElementById('progress_current').textContent = '';
  document.getElementById('progress_title').textContent = '准备中...';
  resetStage();

  // 发送到后台处理
  chrome.runtime.sendMessage({ type: 'start_import', bookmarks: parsedBookmarks })
    .catch(() => {
      // 后台可能未响应，但进度会通过 import_progress 消息回报
    });
}

function cancelImport() {
  chrome.runtime.sendMessage({ type: 'cancel_import' });
  document.getElementById('progress_title').textContent = '正在取消...';
}

// ==================== 监听后台进度消息 ====================

function bindProgressListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== 'import_progress' && message.type !== 'import_complete') return;

    if (message.type === 'import_progress') {
      updateProgress(message);
    }

    if (message.type === 'import_complete') {
      showResult(message);
      importInProgress = false;
    }
  });
}

function updateProgress(data) {
  // 自动刷新日志（仅在日志面板展开时）
  if (logsExpanded && data.phase === 'processing') {
    fetchLogs();
  }

  const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;

  document.getElementById('progress_counter').textContent = `${data.current || 0} / ${data.total}`;
  document.getElementById('progress_fill').style.width = `${pct}%`;
  document.getElementById('stat_success').textContent = data.successCount || 0;
  document.getElementById('stat_fail').textContent = data.failCount || 0;
  document.getElementById('stat_skip').textContent = data.skippedCount || 0;

  if (data.phase === 'start') {
    document.getElementById('progress_title').textContent = '准备中...';
    updateStage('📌', '准备中...');
  } else if (data.phase === 'processing') {
    document.getElementById('progress_title').textContent = '正在处理...';
    document.getElementById('progress_current').textContent = data.currentTitle || '';
    if (data.currentStage) {
      const stageMap = {
        'checking':     { icon: '🔍', label: '检查重复 / 校验 URL' },
        'fetching':     { icon: '📄', label: '抓取页面内容' },
        'summarizing':  { icon: '🤖', label: '大模型生成摘要' },
        'writing':      { icon: '☁️', label: '写入飞书多维表格' }
      };
      const s = stageMap[data.currentStage] || { icon: '📌', label: data.currentStage };
      updateStage(s.icon, s.label);
    }
  } else if (data.phase === 'blocked') {
    document.getElementById('progress_title').textContent = '用量已达上限';
    document.getElementById('progress_current').textContent = data.message || '';
    updateStage('⏸️', '已暂停（用量上限）');
    showToast(data.message, 'error');
  } else if (data.phase === 'cancelled') {
    document.getElementById('progress_title').textContent = '已取消';
    updateStage('🚫', '已取消');
  } else if (data.phase === 'complete') {
    document.getElementById('progress_title').textContent = '处理完成';
    document.getElementById('progress_current').textContent = '';
    updateStage('✅', '处理完成');
  }
}

function updateStage(icon, label) {
  const stageIcon = document.getElementById('stage_icon');
  const stageLabel = document.getElementById('stage_label');
  if (stageIcon) stageIcon.textContent = icon;
  if (stageLabel) stageLabel.textContent = label;
}

function resetStage() {
  updateStage('📌', '准备中...');
}

function showResult(data) {
  const resultDiv = document.getElementById('import_result');
  const card = document.getElementById('result_card');

  resultDiv.style.display = 'block';
  document.getElementById('import_progress').style.display = 'none';

  // 恢复文件选择区域和重试栏
  document.getElementById('import_ready').style.display = '';
  document.getElementById('retry_bar').style.display = '';

  const failCount = data.failCount || 0;
  const successCount = data.successCount || 0;
  const skippedCount = data.skippedCount || 0;
  const cancelled = data.cancelled;

  let icon, title, cardClass;
  if (cancelled) {
    icon = '⚠️'; title = '已取消'; cardClass = 'result-cancelled';
  } else if (failCount === 0 && successCount > 0) {
    icon = '🎉'; title = '全部导入成功'; cardClass = 'result-success';
  } else if (successCount > 0 || failCount > 0) {
    icon = '📋'; title = '处理完成（含失败项）'; cardClass = 'result-partial';
  } else {
    icon = '📋'; title = '无记录被处理'; cardClass = 'result-cancelled';
  }

  card.className = `result-card ${cardClass}`;
  card.innerHTML = `
    <div class="result-title">${escapeHtml(icon + ' ' + title)}</div>
    <div class="result-detail">
      总数：<strong>${Number(data.total) || 0}</strong><br>
      成功：<strong style="color:var(--color-success)">${Number(successCount)}</strong> 条<br>
      失败：<strong style="color:var(--color-error)">${Number(failCount)}</strong> 条<br>
      跳过：<strong style="color:var(--color-text-tertiary)">${Number(skippedCount)}</strong> 条
      ${failCount > 0 ? `<br><br>💡 <em>失败的书签已自动记录到飞书「同步失败记录」表中，可点击上方按钮重试。</em>` : ''}
    </div>
    <div class="result-actions">
      <button type="button" class="btn btn-secondary" onclick="document.getElementById('btn_clear_file').click()">
        📂 选择其他文件
      </button>
      ${failCount > 0 ? `<button type="button" class="btn btn-primary" id="btn_retry_again">🔄 重试失败项</button>` : ''}
    </div>
  `;

  // 绑定结果卡片中的重试按钮
  const btnRetryAgain = document.getElementById('btn_retry_again');
  if (btnRetryAgain) {
    btnRetryAgain.addEventListener('click', () => {
      resultDiv.style.display = 'none';
      retryFailed();
    });
  }

  // 更新用量显示 + 刷新失败计数
  loadUsage();
  loadFailedCount();
}

// ==================== 运行日志面板 ====================

let logsExpanded = false;

function bindLogPanel() {
  // 点击标题栏切换展开/折叠
  document.getElementById('log_header_click').addEventListener('click', (e) => {
    // 不拦截按钮点击
    if (e.target.closest('button')) return;
    toggleLogPanel();
  });

  document.getElementById('btn_toggle_logs').addEventListener('click', toggleLogPanel);
  document.getElementById('btn_refresh_logs').addEventListener('click', fetchLogs);
  document.getElementById('btn_clear_logs').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clear_logs' });
    fetchLogs();
  });
}

function toggleLogPanel() {
  logsExpanded = !logsExpanded;
  const body = document.getElementById('log_body');
  const btn = document.getElementById('btn_toggle_logs');
  if (logsExpanded) {
    body.style.display = '';
    btn.textContent = '▲ 收起';
    fetchLogs();
  } else {
    body.style.display = 'none';
    btn.textContent = '▼ 展开';
  }
}

async function fetchLogs() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'get_logs' });
    renderLogs(result?.logs || []);
  } catch {
    renderLogs([]);
  }
}

function renderLogs(logs) {
  const container = document.getElementById('log_container');
  const empty = document.getElementById('log_empty');
  const badge = document.getElementById('log_badge');

  // 更新计数徽标
  if (logs.length > 0) {
    badge.style.display = '';
    badge.textContent = logs.length;
  } else {
    badge.style.display = 'none';
  }

  if (logs.length === 0) {
    empty.style.display = '';
    // 清空已有日志条目
    container.querySelectorAll('.log-entry').forEach(el => el.remove());
    return;
  }

  empty.style.display = 'none';

  // 构建日志 HTML
  const html = logs.map(entry => {
    const levelLabel = { info: '信息', success: '成功', warn: '警告', error: '错误' }[entry.level] || entry.level;
    const detailHtml = entry.detail
      ? `<span class="log-detail">${escapeHtml(entry.detail)}</span>`
      : '';
    return `<div class="log-entry">
      <span class="log-time">${escapeHtml(entry.time)}</span>
      <span class="log-level log-level-${entry.level}">${levelLabel}</span>
      <span class="log-message">${escapeHtml(entry.message)}${detailHtml}</span>
    </div>`;
  }).join('');

  // 检查是否在底部（自动滚动）
  const wasAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;

  container.innerHTML = html + '<div class="log-empty" id="log_empty" style="display:none">暂无日志</div>';

  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
