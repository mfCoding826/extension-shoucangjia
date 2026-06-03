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
});

// ==================== 加载配置 ====================

async function loadConfig() {
  const config = await getFullConfig();

  // 云文档配置
  setValue('feishu_app_id', config.feishu_app_id);
  setValue('feishu_app_secret', config.feishu_app_secret);
  setValue('feishu_table_app_token', config.feishu_table_app_token);
  setValue('feishu_table_name', config.feishu_table_name);

  // 大模型配置
  populateProviderSelect(config.llm_provider);
  setValue('llm_api_key', config.llm_api_key);
  setValue('llm_model_name', config.llm_model_name);
  setValue('llm_base_url', config.llm_base_url);

  // 用量设置
  setValue('daily_limit', config.daily_limit);

  // 显示/隐藏自定义字段
  toggleCustomFields(config.llm_provider);
}

async function loadUsage() {
  const usage = await getDailyUsage();
  document.getElementById('usage_today').textContent = usage.today;
  document.getElementById('usage_limit_display').textContent = usage.limit;
}

// ==================== 厂家下拉框 ====================

function populateProviderSelect(currentKey) {
  const select = document.getElementById('llm_provider');
  const providers = getAllProviders();

  select.innerHTML = '';

  // 分组：国内 / 国际 / 自定义
  const groups = {
    cn: { label: '🌏 国内厂家', items: [] },
    intl: { label: '🌍 国际厂家', items: [] },
    custom: { label: '✨ 自定义', items: [] }
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
}

// ==================== 事件绑定 ====================

function bindEvents() {
  // 厂家切换时自动填充模型和地址
  document.getElementById('llm_provider').addEventListener('change', onProviderChange);

  // 保存按钮
  document.getElementById('btn_save').addEventListener('click', onSave);

  // 验证飞书配置
  document.getElementById('btn_verify_feishu').addEventListener('click', onVerifyFeishu);

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

function onProviderChange(e) {
  const key = e.target.value;
  const provider = getProviderByKey(key);
  if (!provider) return;

  // 自定义选项不自动填充
  if (key === 'custom') {
    toggleCustomFields(true);
    return;
  }

  toggleCustomFields(false);

  // 自动填充 base_url 和 model_name
  setValue('llm_base_url', provider.base_url);
  setValue('llm_model_name', provider.default_model);
}

function toggleCustomFields(isCustom) {
  // 自定义模式下允许编辑 base_url 和 model_name
  const modelInput = document.getElementById('llm_model_name');
  const urlInput = document.getElementById('llm_base_url');

  if (isCustom) {
    modelInput.removeAttribute('readonly');
    urlInput.removeAttribute('readonly');
    modelInput.placeholder = '请输入模型名称';
    urlInput.placeholder = '请输入完整的 Base URL';
    modelInput.style.opacity = '1';
    urlInput.style.opacity = '1';
  } else {
    modelInput.setAttribute('readonly', true);
    urlInput.setAttribute('readonly', true);
    modelInput.style.opacity = '0.7';
    urlInput.style.opacity = '0.7';
  }
}

// ==================== 保存 ====================

async function onSave() {
  const btn = document.getElementById('btn_save');
  setButtonLoading(btn, true);

  try {
    const config = {
      feishu_app_id: getValue('feishu_app_id'),
      feishu_app_secret: getValue('feishu_app_secret'),
      feishu_table_app_token: getValue('feishu_table_app_token'),
      feishu_table_name: getValue('feishu_table_name'),
      llm_provider: getValue('llm_provider'),
      llm_api_key: getValue('llm_api_key'),
      llm_model_name: getValue('llm_model_name'),
      llm_base_url: getValue('llm_base_url'),
      daily_limit: parseInt(getValue('daily_limit')) || 50
    };

    // 基本校验
    if (config.daily_limit < 1 || config.daily_limit > 9999) {
      showToast('每日限额必须在 1~9999 之间', 'error');
      setButtonLoading(btn, false);
      return;
    }

    await saveConfig(config);
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
  const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;

  document.getElementById('progress_counter').textContent = `${data.current || 0} / ${data.total}`;
  document.getElementById('progress_fill').style.width = `${pct}%`;
  document.getElementById('stat_success').textContent = data.successCount || 0;
  document.getElementById('stat_fail').textContent = data.failCount || 0;
  document.getElementById('stat_skip').textContent = data.skippedCount || 0;

  if (data.phase === 'start') {
    document.getElementById('progress_title').textContent = '准备中...';
  } else if (data.phase === 'processing') {
    document.getElementById('progress_title').textContent = '正在处理...';
    document.getElementById('progress_current').textContent = data.currentTitle || '';
  } else if (data.phase === 'blocked') {
    document.getElementById('progress_title').textContent = '用量已达上限';
    document.getElementById('progress_current').textContent = data.message || '';
    showToast(data.message, 'error');
  } else if (data.phase === 'cancelled') {
    document.getElementById('progress_title').textContent = '已取消';
  } else if (data.phase === 'complete') {
    document.getElementById('progress_title').textContent = '处理完成';
    document.getElementById('progress_current').textContent = '';
  }
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
    <div class="result-title">${icon} ${title}</div>
    <div class="result-detail">
      总数：<strong>${data.total}</strong><br>
      成功：<strong style="color:var(--color-success)">${successCount}</strong> 条<br>
      失败：<strong style="color:var(--color-error)">${failCount}</strong> 条<br>
      跳过：<strong style="color:var(--color-text-tertiary)">${skippedCount}</strong> 条
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
