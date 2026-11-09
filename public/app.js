import { splitText, segmentSentences, validateAlignment, joinTranslations, sentenceSeparator, reconcileResults } from './sentence-alignment.mjs';
import { createSentenceHover } from './sentence-hover.mjs';

const $ = id => document.getElementById(id);
const STORE = 'paper-parallel-draft-v1';
const EXAMPLE = {
  source: 'Sampling-based motion planning is widely used in complex environments. However, unsuccessful extension attempts are often discarded, even though they may provide useful information about nearby obstacles.\n\nIn this illustrative example, we retain failure information to guide subsequent sampling. The resulting path must satisfy collision-avoidance constraints. Whether this strategy improves planning performance should be evaluated using controlled experiments.',
  translations: [
    '基于采样的运动规划广泛应用于复杂环境。然而，失败的扩展尝试往往被直接丢弃，尽管它们可能提供有关附近障碍物的有用信息。',
    '在这个说明性示例中，我们保留失败信息以引导后续采样。所生成的路径必须满足避碰约束。该策略是否能够改善规划性能，应通过受控实验进行评估。',
  ],
  alignedTranslations: [
    ['基于采样的运动规划广泛应用于复杂环境。', '然而，失败的扩展尝试往往被直接丢弃，尽管它们可能提供有关附近障碍物的有用信息。'],
    ['在这个说明性示例中，我们保留失败信息以引导后续采样。', '所生成的路径必须满足避碰约束。', '该策略是否能够改善规划性能，应通过受控实验进行评估。'],
  ],
};
let results = [];
let glossary = '';
let sample = false;
let config = { configured: false, model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'] };
let selectedProvider = 'deepseek';
let providerProfiles = { deepseek: config, openai: { name: 'OpenAI', configured: false, source: 'none', model: 'gpt-5.4-mini', models: ['gpt-5.4-mini', 'gpt-5.4'] } };
let chosenModels = {};
let controller;
let active = false;
let revision = 0;
let saveTimer;
let toastTimer;
let total = 0;
let settledStatus = '';
let previousSource = '';
const editHistory = new Map();
const sentenceHover = createSentenceHover($('source'), $('source-mirror'), $('target'));

function resultWithAlignment(source, data) {
  const alignment = validateAlignment(source, data.alignment, { allowPending: true });
  return alignment ? { source, translation: joinTranslations(source, alignment), alignment } : { source, translation: data.translation };
}
function exampleResults() {
  return splitText(EXAMPLE.source).map((source, index) => resultWithAlignment(source, {
    translation: EXAMPLE.translations[index],
    alignment: segmentSentences(source).map((sentence, i) => ({ ...sentence, translation: EXAMPLE.alignedTranslations[index][i] })),
  }));
}
function status(message, error = false) {
  $('progress-status').textContent = message;
  $('progress-status').classList.toggle('error', error);
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000);
}
function updateCounts() {
  const text = $('source').value;
  const words = text.match(/\b[A-Za-z0-9]+(?:['’−-][A-Za-z0-9]+)*\b/g)?.length || 0;
  $('word-count').textContent = `${words.toLocaleString()} words · ${text.length.toLocaleString()} 字符`;
  const available = results.some(item => item.translation.trim());
  $('copy-button').disabled = !available;
  $('download-button').disabled = !available;
  $('export-pdf-button').disabled = active || !$('source').value.trim();
  const sentences = results.flatMap(item => item.alignment || []);
  $('translation-count').textContent = sentences.length && !sample
    ? `已译 ${sentences.filter(item => !item.pending).length} / ${sentences.length} 句 · 点击可编辑`
    : results.length ? `${results.length} 段${sample ? '示例译文' : '译文 · 点击可编辑'}` : '等待翻译';
}
function saveDraft() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(STORE, JSON.stringify({ source: $('source').value, results, glossary, sample, provider: selectedProvider, chosenModels: { ...chosenModels, [selectedProvider]: $('model').value }, model: $('model').value, total, settledStatus }));
    $('save-status').textContent = '草稿已保存在此浏览器';
  } catch { $('save-status').textContent = '草稿未保存，请复制或导出'; }
}
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 350); }
function renderResults() {
  $('translations').replaceChildren();
  $('empty-state').hidden = results.length > 0;
  $('result-label').hidden = !sample;
  $('result-label').textContent = sample ? '示例译文 · 非实时翻译' : '';
  results.forEach((item, index) => {
    const block = document.createElement('section');
    block.className = 'translation-block';
    const number = document.createElement('span');
    number.className = 'paragraph-number';
    number.textContent = `${String(index + 1).padStart(2, '0')} / 中文`;
    const paragraph = document.createElement('div');
    paragraph.className = 'paragraph-body';
    function editor(value, sentenceIndex) {
      const aligned = sentenceIndex !== undefined;
      const text = document.createElement(aligned ? 'span' : 'div');
      text.className = aligned ? 'translation-text sentence-text' : 'translation-text';
      const pending = aligned && item.alignment[sentenceIndex].pending;
      text.contentEditable = active || pending ? 'false' : 'plaintext-only';
      text.role = 'textbox';
      text.setAttribute('aria-label', aligned ? `编辑第 ${index + 1} 段第 ${sentenceIndex + 1} 句译文` : `编辑第 ${index + 1} 段译文`);
      text.setAttribute('aria-multiline', 'true');
      text.textContent = pending ? '〔待翻译〕' : value;
      if (pending) { text.classList.add('pending-sentence'); text.dataset.pending = 'true'; }
      if (aligned) text.dataset.sentenceKey = `${index}:${item.alignment[sentenceIndex].id}`;
      text.addEventListener('input', () => {
        if (aligned) {
          item.alignment[sentenceIndex].translation = text.innerText;
          item.translation = joinTranslations(item.source, item.alignment);
        } else item.translation = text.innerText;
        scheduleSave();
      });
      return text;
    }
    if (item.alignment) {
      item.alignment.forEach((sentence, i) => {
        paragraph.append(editor(sentence.translation, i), document.createTextNode(sentenceSeparator(item.source, item.alignment, i)));
      });
    } else paragraph.append(editor(item.translation));
    block.append(number, paragraph);
    $('translations').append(block);
  });
  sentenceHover.refresh();
  updateCounts();
}
function setBusy(busy) {
  active = busy;
  $('translate-button').disabled = busy;
  $('translate-button').textContent = busy ? '正在翻译…' : '开始翻译 ↗';
  $('stop-button').hidden = !busy;
  $('source').readOnly = busy;
  for (const id of ['example-button', 'clear-button', 'provider', 'model', 'settings-button', 'glossary-button', 'export-pdf-button']) $(id).disabled = busy;
  if (!busy) updateCounts();
  document.querySelectorAll('.translation-text').forEach(el => { el.contentEditable = busy || el.dataset.pending ? 'false' : 'plaintext-only'; });
}
async function api(route, body, signal) {
  const response = await fetch(route, body === undefined ? { signal } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('网站服务返回异常，请刷新后重试。'); }
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。');
  return data;
}
function receiveConfiguration(data) {
  providerProfiles = data.providers || { ...providerProfiles, deepseek: data };
  config = providerProfiles[selectedProvider];
}
function renderToolbarModels(selectedModel) {
  const values = [...new Set([...config.models, selectedModel].filter(Boolean))];
  $('model').replaceChildren(...values.map(value => new Option(value === 'deepseek-flash' ? 'DeepSeek · Flash' : value === 'deepseek-v4-pro' ? 'DeepSeek · Pro' : value, value)));
  $('model').value = selectedModel;
}
function renderSettingsModels(selectedModel = $('model').value) {
  const group = document.createElement('optgroup');
  group.label = config.modelsSource === 'api' ? '接口返回的文本模型' : '常用预设（未验证账号权限）';
  group.append(...config.models.map(value => new Option(value, value)));
  $('api-model').replaceChildren(group);
  if (selectedModel && !config.models.includes(selectedModel)) {
    const current = document.createElement('optgroup'); current.label = '当前手动模型';
    current.append(new Option(selectedModel, selectedModel)); $('api-model').append(current);
  }
  $('api-model').add(new Option('手动填写其他模型…', '__custom__'));
  $('api-model').value = selectedModel || config.models[0];
  $('custom-model').hidden = true;
  $('models-status').textContent = config.modelsSource === 'api'
    ? `已载入接口返回的 ${config.models.length} 个文本模型。`
    : `当前显示 ${config.models.length} 个预设；填写密钥后可读取该账号的模型列表。`;
}
function settingsModel() { return $('api-model').value === '__custom__' ? $('custom-model').value.trim() : $('api-model').value; }
function selectProvider(provider, rememberCurrent = true) {
  if (!Object.hasOwn(providerProfiles, provider)) return;
  if (rememberCurrent) chosenModels[selectedProvider] = $('model').value;
  selectedProvider = provider;
  config = providerProfiles[provider];
  $('provider').value = $('settings-provider').value = provider;
  const selectedModel = chosenModels[provider] || config.model;
  renderToolbarModels(selectedModel);
  $('api-key').value = '';
  showConnection();
}
function showConnection() {
  $('connection-status').textContent = config.configured ? '已配置' : '未连接';
  $('connection-status').classList.toggle('connected', config.configured);
  $('key-help').textContent = config.source === 'server'
    ? '已使用本机服务中配置的密钥。可留空，或填写另一把临时密钥。'
    : config.source === 'session'
      ? '已配置临时密钥；将在 12 小时后或本机服务重启后失效。留空可保留。'
      : '密钥仅保存在本机服务的临时内存中，不写入浏览器草稿。';
  $('disconnect-button').hidden = config.source !== 'session';
  $('api-key-label').textContent = `${selectedProvider === 'openai' ? 'OpenAI' : 'DeepSeek'} API Key`;
  $('settings-provider').value = selectedProvider;
  renderSettingsModels();
  $('api-key-link').href = selectedProvider === 'openai' ? 'https://platform.openai.com/api-keys' : 'https://platform.deepseek.com/api_keys';
  $('provider-note').textContent = selectedProvider === 'openai'
    ? '使用 OpenAI 官方 API。会员赠送额度以你绑定的 API 组织实际余额为准；可填写该账户可用的模型名称。'
    : '使用 DeepSeek 官方 API，按该服务的账户余额计费。';
}
function openSettings() {
  $('glossary').value = glossary;
  $('api-key').value = '';
  $('settings-message').textContent = '';
  showConnection();
  $('settings-dialog').showModal();
}
function resetTranslation() {
  results = [];
  sample = false;
  total = 0;
  settledStatus = '';
  $('progress-bar').style.width = '0%';
  renderResults();
}
async function translate() {
  if (active) return;
  const paragraphs = splitText($('source').value);
  if (!paragraphs.length) { status('请先在左侧输入或粘贴英文。', true); $('source').focus(); return; }
  if (!config.configured) { openSettings(); $('settings-message').textContent = `连接 ${selectedProvider === 'openai' ? 'OpenAI' : 'DeepSeek'} 后即可翻译；也可以先点击「试试示例」查看版式。`; return; }
  revision += 1;
  const run = revision;
  const aborter = new AbortController();
  controller = aborter;
  resetTranslation();
  total = paragraphs.length;
  setBusy(true);
  try {
    for (let i = 0; i < paragraphs.length; i += 1) {
      status(`正在翻译第 ${i + 1} / ${paragraphs.length} 段…`);
      const data = await api('/api/translate', { text: paragraphs[i], glossary, provider: selectedProvider, model: $('model').value, alignSentences: true }, aborter.signal);
      if (run !== revision) return;
      results.push(resultWithAlignment(paragraphs[i], data));
      renderResults();
      $('progress-bar').style.width = `${results.length / total * 100}%`;
      settledStatus = `已完成 ${results.length} / ${total} 段。`;
      saveDraft();
    }
    settledStatus = results.every(item => item.alignment)
      ? `翻译完成，共 ${results.length} 段。悬停英文可高亮对应译句，点击译文可修改。`
      : `翻译完成，共 ${results.length} 段。当前译文没有逐句配对，请更新服务后重新翻译以启用联动。`;
    status(settledStatus);
  } catch (error) {
    if (run !== revision) return;
    settledStatus = aborter.signal.aborted ? `已停止，保留 ${results.length} / ${total} 段译文。` : `${error.message} 已完成 ${results.length} / ${total} 段。`;
    status(settledStatus, !aborter.signal.aborted);
  } finally {
    if (run === revision) { controller = undefined; setBusy(false); saveDraft(); }
  }
}

$('source').addEventListener('input', () => {
  const nextSource = $('source').value;
  editHistory.set(previousSource, { results: structuredClone(results), sample });
  if (editHistory.size > 20) editHistory.delete(editHistory.keys().next().value);
  const restored = editHistory.get(nextSource);
  results = restored ? structuredClone(restored.results) : reconcileResults(previousSource, nextSource, results);
  if (restored) sample = restored.sample;
  previousSource = nextSource;
  total = splitText(nextSource).length;
  settledStatus = results.length ? '已保留未改动句子的译文与高亮；新写或改写的句子待翻译。' : '原文已更新，准备好后点击「开始翻译」。';
  $('progress-bar').style.width = '0%';
  renderResults(); status(settledStatus); scheduleSave();
});
$('translate-button').addEventListener('click', translate);
$('stop-button').addEventListener('click', () => controller?.abort());
$('clear-button').addEventListener('click', () => {
  $('source').value = ''; previousSource = ''; editHistory.clear(); resetTranslation(); updateCounts(); saveDraft();
  status('已清空，粘贴一段新的英文开始。'); $('source').focus();
});
$('example-button').addEventListener('click', () => {
  $('source').value = EXAMPLE.source;
  previousSource = EXAMPLE.source;
  editHistory.clear();
  sample = true;
  results = exampleResults();
  total = results.length;
  settledStatus = '当前是预置的示例原文与译文，未调用翻译接口。';
  $('progress-bar').style.width = '0%';
  renderResults(); status(settledStatus); saveDraft();
});
$('copy-button').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(results.map(item => item.translation).join('\n\n')); toast('译文已复制'); }
  catch { toast('复制未成功，可以点击译文手动选择并复制。'); }
});
$('download-button').addEventListener('click', () => {
  const partial = results.length < total || results.some(item => item.alignment?.some(sentence => sentence.pending));
  const header = `译读 · 英中对照${sample ? '（预置示例）' : ''}${partial ? '（部分译文，缺失内容已标注）' : ''}\n\n`;
  const source = `【完整英文输入】\n${$('source').value}\n\n`;
  const content = header + source + splitText($('source').value).map((english, i) => {
    const item = results[i]?.source === english ? results[i] : undefined;
    const chinese = item?.alignment ? item.alignment.map(sentence => sentence.pending ? '〔未翻译〕' : sentence.translation).join('') : item?.translation || '〔未翻译〕';
    return `【第 ${i + 1} 段 / 英文】\n${english}\n\n【中文】\n${chinese}`;
  }).join('\n\n──────────\n\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = '译读_英中对照.txt'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出英中对照文本');
});
for (const id of ['settings-button', 'glossary-button']) $(id).addEventListener('click', openSettings);
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('click', event => { if (event.target === $('settings-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('save-settings').disabled = true;
  $('settings-message').textContent = '';
  try {
    const key = $('api-key').value.trim();
    const model = settingsModel();
    if (key || config.configured) {
      const data = await api('/api/session', { provider: selectedProvider, ...(key ? { key } : {}), model });
      receiveConfiguration(data);
      chosenModels[selectedProvider] = config.model;
      selectProvider(selectedProvider, false);
    } else if (model) {
      chosenModels[selectedProvider] = model;
      renderToolbarModels(model);
    }
    glossary = $('glossary').value.trim();
    $('api-key').value = '';
    saveDraft(); showConnection(); $('settings-dialog').close();
    toast(key ? '密钥已配置，首次翻译时验证可用性' : '术语表已保存');
  } catch (error) { $('settings-message').textContent = error.message; }
  finally { $('save-settings').disabled = false; }
});
$('api-model').addEventListener('change', () => {
  $('custom-model').hidden = $('api-model').value !== '__custom__';
  if (!$('custom-model').hidden) $('custom-model').focus();
});
$('load-models-button').addEventListener('click', async () => {
  const provider = selectedProvider;
  const key = $('api-key').value.trim();
  const selectedModel = settingsModel();
  const controls = ['load-models-button', 'settings-provider', 'api-key', 'api-model', 'save-settings', 'disconnect-button'];
  for (const id of controls) $(id).disabled = true;
  $('load-models-button').textContent = '正在读取…';
  $('models-status').textContent = '正在向当前服务读取模型列表，不会发送论文正文。';
  try {
    const data = await api('/api/models', { provider, ...(key ? { key } : {}) });
    providerProfiles[provider] = { ...providerProfiles[provider], models: data.models, modelsSource: 'api' };
    if (provider === selectedProvider) {
      config = providerProfiles[provider];
      renderToolbarModels($('model').value);
      renderSettingsModels(data.models.includes(selectedModel) ? selectedModel : data.models[0]);
      $('models-status').textContent = `读取到 ${data.models.length} 个文本模型（接口共返回 ${data.total} 个模型）。请选择后保存。`;
    }
  } catch (error) { if (provider === selectedProvider) $('models-status').textContent = error.message; }
  finally {
    for (const id of controls) $(id).disabled = false;
    $('load-models-button').textContent = '读取可用模型';
  }
});
$('disconnect-button').addEventListener('click', async () => {
  try { receiveConfiguration(await api('/api/session', { provider: selectedProvider, clear: true })); showConnection(); toast('当前服务的临时密钥已清除'); }
  catch (error) { $('settings-message').textContent = error.message; }
});
$('model').addEventListener('change', () => { chosenModels[selectedProvider] = $('model').value; if (results.length) status('模型已切换，当前译文保留；下次翻译使用所选模型。'); saveDraft(); });
for (const id of ['provider', 'settings-provider']) $(id).addEventListener('change', () => {
  selectProvider($(id).value);
  $('settings-message').textContent = '';
  if (results.length) status('服务已切换，当前译文保留；下次翻译使用所选服务。');
  saveDraft();
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !document.querySelector('dialog[open]')) { event.preventDefault(); translate(); }
});
window.addEventListener('pagehide', saveDraft);

async function init() {
  let savedModel;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (saved && typeof saved.source === 'string' && saved.source.length <= 60000) {
      $('source').value = saved.source;
      glossary = typeof saved.glossary === 'string' ? saved.glossary.slice(0, 2000) : '';
      results = Array.isArray(saved.results) ? saved.results
        .filter(item => typeof item?.source === 'string' && typeof item?.translation === 'string')
        .map(item => resultWithAlignment(item.source, item)) : [];
      sample = saved.sample === true;
      if (sample && saved.source === EXAMPLE.source && results.some(item => !item.alignment)
        && results.every((item, i) => item.translation === EXAMPLE.translations[i])) results = exampleResults();
      total = Number.isSafeInteger(saved.total) && saved.total >= results.length ? saved.total : results.length;
      savedModel = saved.model;
      if (saved.provider === 'openai' || saved.provider === 'deepseek') selectedProvider = saved.provider;
      if (saved.chosenModels && typeof saved.chosenModels === 'object') {
        chosenModels = Object.fromEntries(['deepseek', 'openai'].filter(id => typeof saved.chosenModels[id] === 'string' && saved.chosenModels[id].length <= 128).map(id => [id, saved.chosenModels[id]]));
      }
      settledStatus = typeof saved.settledStatus === 'string' ? saved.settledStatus : '';
      renderResults();
      if (results.length) status(sample ? '已恢复预置示例；悬停英文可查看对应译句。'
        : results.every(item => item.alignment) ? `已恢复草稿，包含 ${results.length} / ${total} 段译文。`
          : '已恢复旧译文；重新翻译后可启用逐句联动高亮。');
    }
  } catch { $('save-status').textContent = '无法读取草稿，请及时导出'; }
  updateCounts();
  previousSource = $('source').value;
  sentenceHover.refresh();
  try {
    receiveConfiguration(await api('/api/config'));
    if (!chosenModels[selectedProvider] && typeof savedModel === 'string' && config.models.includes(savedModel)) chosenModels[selectedProvider] = savedModel;
    // Set the initial toolbar before the normal switching path stores its current value.
    $('model').replaceChildren(...config.models.map(model => new Option(model, model)));
    $('model').value = chosenModels[selectedProvider] || config.model;
    selectProvider(selectedProvider, false);
  } catch { status('网站服务未连接，请先启动本机服务，再刷新页面。', true); }
}

function initializeResizing() {
  const workspace = document.querySelector('.workspace');
  const columns = document.querySelector('.columns');
  const divider = $('column-resizer');
  const sourceHandle = $('source-width-handle');
  const corner = $('workspace-resizer');
  const leftEdge = $('workspace-left-resizer');
  const rightEdge = $('workspace-right-resizer');
  const topEdge = $('workspace-top-resizer');
  const moveHandle = $('workspace-drag-handle');
  const layoutStore = 'paper-parallel-layout-v1';
  let fraction = 50;
  let leftInset = 0;
  let rightInset = 0;
  let topInset = 0;
  const main = document.querySelector('main');
  function availableWidth() {
    const css = getComputedStyle(main);
    return Math.max(1, main.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight));
  }
  function outerEdges(left, right, movingSide) {
    const available = availableWidth();
    const minimumWidth = Math.min(available, innerWidth <= 700 ? 280 : 720);
    const maximumInsets = Math.max(0, available - minimumWidth);
    left = Math.max(0, left); right = Math.max(0, right);
    if (movingSide === 'left') left = Math.min(left, Math.max(0, maximumInsets - right));
    else if (movingSide === 'right') right = Math.min(right, Math.max(0, maximumInsets - left));
    else if (left + right > maximumInsets) {
      const scale = maximumInsets / Math.max(1, left + right);
      left *= scale; right *= scale;
    }
    leftInset = left; rightInset = right;
    workspace.style.marginLeft = `${leftInset}px`;
    workspace.style.width = `calc(100% - ${leftInset + rightInset}px)`;
  }
  function resize(height) {
    workspace.style.height = `${Math.max(innerWidth <= 700 ? 520 : 320, Math.min(2200, height))}px`;
  }
  function setTop(value) {
    topInset = Math.max(0, Math.min(Math.max(0, main.clientHeight - 96), value));
    workspace.style.marginTop = `${topInset}px`;
    sentenceHover.invalidateGeometry();
  }
  function resizeTop(value, bottom) {
    const minimumHeight = innerWidth <= 700 ? 520 : 320;
    const minimumTop = Math.max(0, bottom - 2200);
    const maximumTop = Math.max(minimumTop, Math.min(bottom - minimumHeight, Math.max(0, main.clientHeight - 96)));
    const nextTop = Math.max(minimumTop, Math.min(maximumTop, value));
    resize(bottom - nextTop);
    setTop(nextTop);
  }
  function moveWorkspace(left, top) {
    const totalInset = leftInset + rightInset;
    const nextLeft = Math.min(totalInset, Math.max(0, left));
    outerEdges(nextLeft, totalInset - nextLeft);
    setTop(top);
  }
  function setFraction(value) {
    const minimum = Math.min(50, Math.max(20, 327 / Math.max(1, columns.clientWidth) * 100));
    fraction = Math.min(100 - minimum, Math.max(minimum, value));
    columns.style.setProperty('--source-width', `${fraction}%`);
    divider.setAttribute('aria-valuenow', String(Math.round(fraction)));
    divider.setAttribute('aria-valuemin', String(Math.ceil(minimum)));
    divider.setAttribute('aria-valuemax', String(Math.floor(100 - minimum)));
  }
  function remember() {
    try { localStorage.setItem(layoutStore, JSON.stringify({ version: 4, height: workspace.getBoundingClientRect().height, fraction, leftInset, rightInset, topInset })); } catch {}
  }
  function drag(element, change) {
    let start;
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      start = { x: event.clientX, y: event.clientY, height: workspace.getBoundingClientRect().height, leftInset, rightInset, topInset, scrollTop: main.scrollTop };
      element.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    element.addEventListener('pointermove', event => { if (start) { change(event, start); event.preventDefault(); } });
    element.addEventListener('pointerup', () => { if (start) { start = undefined; remember(); } });
    element.addEventListener('pointercancel', () => { start = undefined; });
  }
  drag(corner, (event, start) => resize(start.height + event.clientY - start.y));
  drag(topEdge, (event, start) => resizeTop(start.topInset + event.clientY - start.y + main.scrollTop - start.scrollTop, start.topInset + start.height));
  drag(leftEdge, (event, start) => outerEdges(start.leftInset + event.clientX - start.x, start.rightInset, 'left'));
  drag(rightEdge, (event, start) => outerEdges(start.leftInset, start.rightInset - (event.clientX - start.x), 'right'));
  let moveStart;
  moveHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button,select,input,a,[contenteditable]')) return;
    moveStart = { x: event.clientX, y: event.clientY, left: leftInset, top: topInset, scrollTop: main.scrollTop };
    moveHandle.setPointerCapture(event.pointerId);
    workspace.setAttribute('data-moving', '');
    event.preventDefault();
  });
  moveHandle.addEventListener('pointermove', event => {
    if (!moveStart) return;
    moveWorkspace(moveStart.left + event.clientX - moveStart.x, moveStart.top + event.clientY - moveStart.y + main.scrollTop - moveStart.scrollTop);
    event.preventDefault();
  });
  function finishMove() {
    if (!moveStart) return;
    moveStart = undefined;
    workspace.removeAttribute('data-moving');
    remember();
  }
  moveHandle.addEventListener('pointerup', finishMove);
  moveHandle.addEventListener('pointercancel', finishMove);
  moveHandle.addEventListener('lostpointercapture', finishMove);
  moveHandle.addEventListener('keydown', event => {
    if (event.target !== moveHandle || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    moveWorkspace(leftInset + (event.key === 'ArrowRight' ? 24 : event.key === 'ArrowLeft' ? -24 : 0), topInset + (event.key === 'ArrowDown' ? 24 : event.key === 'ArrowUp' ? -24 : 0));
    remember();
  });
  for (const [edge, side] of [[leftEdge, 'left'], [rightEdge, 'right']]) {
    edge.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? 24 : -24;
      if (side === 'left') outerEdges(event.key === 'Home' ? 0 : leftInset + delta, rightInset, side);
      else outerEdges(leftInset, event.key === 'Home' ? 0 : rightInset - delta, side);
      remember();
    });
  }
  function resizeColumns(event) {
    const bounds = columns.getBoundingClientRect();
    setFraction((event.clientX - bounds.left - 7) / Math.max(1, bounds.width - 14) * 100);
  }
  drag(divider, resizeColumns);
  drag(sourceHandle, resizeColumns);
  corner.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const rect = workspace.getBoundingClientRect();
    resize(rect.height + (event.key === 'ArrowDown' ? 24 : -24));
    remember();
  });
  topEdge.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    resizeTop(topInset + (event.key === 'ArrowDown' ? 24 : -24), topInset + workspace.getBoundingClientRect().height);
    remember();
  });
  function widthKeys(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); setFraction(event.key === 'Home' ? 50 : fraction + (event.key === 'ArrowRight' ? 2 : -2)); remember();
  }
  divider.addEventListener('keydown', widthKeys);
  sourceHandle.addEventListener('keydown', widthKeys);
  $('reset-size-button').addEventListener('click', () => {
    leftInset = rightInset = topInset = 0;
    workspace.style.marginLeft = workspace.style.marginTop = workspace.style.width = workspace.style.height = ''; setFraction(50);
    sentenceHover.invalidateGeometry();
    try { localStorage.removeItem(layoutStore); } catch {}
  });
  try {
    const saved = JSON.parse(localStorage.getItem(layoutStore) || 'null');
    if (saved && Number.isFinite(saved.height)) resize(saved.height);
    // Restore explicit outer-edge positions; old layouts have no side insets.
    if (saved?.version >= 3 && Number.isFinite(saved.leftInset) && Number.isFinite(saved.rightInset)) outerEdges(saved.leftInset, saved.rightInset);
    if (saved?.version >= 4 && Number.isFinite(saved.topInset)) setTop(saved.topInset);
    if (saved?.version >= 2 && Number.isFinite(saved.fraction)) setFraction(saved.fraction);
    else setFraction(50);
    if (saved && saved.version !== 4) remember();
  } catch {}
  new ResizeObserver(() => { if (innerWidth > 700) setFraction(fraction); }).observe(columns);
  new ResizeObserver(() => { outerEdges(leftInset, rightInset); setTop(topInset); }).observe(main);
}

function initializePdfExport() {
  const dialog = $('pdf-dialog');
  const root = $('pdf-document');
  const labels = { en: '英文原文', zh: '中文译文', both: '中英对照' };
  let previousTitle;
  function mode() { return document.querySelector('input[name="pdf-mode"]:checked')?.value || 'en'; }
  function pendingCount() {
    return results.length < splitText($('source').value).length || results.some(item => item.alignment?.some(sentence => sentence.pending));
  }
  function note() {
    $('pdf-note').textContent = mode() === 'en' ? '导出左侧完整英文。'
      : pendingCount() ? mode() === 'zh' ? '当前有未翻译的句子：仅导出已有中文。' : '当前有未翻译的句子：对照版会在对应位置标注“未翻译”。'
        : mode() === 'both' ? '左英文、右中文，保留句子配对。' : '导出当前中文，包含你手动修改的译文。';
  }
  $('export-pdf-button').addEventListener('click', () => {
    const hasTranslation = results.some(item => item.translation.trim());
    for (const input of document.querySelectorAll('input[name="pdf-mode"]')) input.disabled = input.value !== 'en' && !hasTranslation;
    if (!hasTranslation) document.querySelector('input[name="pdf-mode"][value="en"]').checked = true;
    note(); dialog.showModal();
  });
  $('close-pdf').addEventListener('click', () => dialog.close());
  for (const input of document.querySelectorAll('input[name="pdf-mode"]')) input.addEventListener('change', note);
  function add(tag, text, parent = root, className) {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className;
    parent.append(node); return node;
  }
  $('pdf-form').addEventListener('submit', event => {
    event.preventDefault();
    const selected = mode();
    if (selected !== 'en' && !results.some(item => item.translation.trim())) return;
    root.replaceChildren(); root.dataset.mode = selected;
    const title = $('pdf-name').value.trim();
    if (title) add('h1', title);
    if (sample) add('p', '预置示例文本与译文', root, 'pdf-notice');
    if (selected !== 'en' && pendingCount()) add('p', selected === 'zh' ? '部分译文：仅包含已翻译的内容。' : '部分译文：未翻译的句子已标注。', root, 'pdf-notice');
    if (selected === 'en') add('div', $('source').value, root, 'pdf-text');
    else if (selected === 'zh') {
      for (const item of results) if (item.translation.trim()) add('p', item.translation, root, 'pdf-paragraph');
    } else {
      const table = add('table', '');
      const head = add('thead', '', table);
      const heading = add('tr', '', head);
      add('th', '英文原文', heading); add('th', '中文译文', heading);
      const body = add('tbody', '', table);
      splitText($('source').value).forEach((source, index) => {
        const result = results[index]?.source === source ? results[index] : undefined;
        function row(english, chinese, first, pending = false) {
          const tr = add('tr', '', body, first ? 'paragraph-start' : undefined);
          add('td', english, tr); add('td', chinese, tr, pending ? 'pdf-pending' : undefined);
        }
        if (result?.alignment) result.alignment.forEach((sentence, i) => row(sentence.source, sentence.pending ? '〔未翻译〕' : sentence.translation, i === 0, sentence.pending));
        else row(source, result?.translation || '〔未翻译〕', true, !result?.translation);
      });
    }
    previousTitle = document.title;
    document.title = title || `译读_${labels[selected]}`;
    dialog.close();
    try { window.print(); } catch { toast('当前浏览器不支持打印，请使用 Chrome 或 Edge 打开网站导出。'); }
  });
  window.addEventListener('afterprint', () => {
    if (previousTitle !== undefined) { document.title = previousTitle; previousTitle = undefined; }
    root.replaceChildren();
  });
}

initializeResizing();
initializePdfExport();
init();
