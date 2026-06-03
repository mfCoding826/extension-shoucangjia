/**
 * options.js — 配置页面交互逻辑
 *
 * 管理三个配置区域：
 * 1. 云文档配置（飞书）
 * 2. 大模型配置（多厂家选择）
 * 3. 用量设置
 */

// ==================== 页面加载 ====================

document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await loadUsage();
  bindEvents();
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
