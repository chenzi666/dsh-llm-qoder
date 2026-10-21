// 用假 ctx 跑一遍 apply + stream，验证适配器逻辑（不依赖 Harness 运行时）
const pluginPath = 'file:///C:/Users/WeiCheng/.dsh/profiles/desktop/node_modules/dsh-llm-qoder/lib/index.js';

const m = await import(pluginPath);
let captured = null;
const ctx = {
  llm: {
    registerAdapter: (providers, adapter) => {
      captured = { providers, adapter };
      return () => {};
    },
  },
  logger: { info: (...a) => console.log('[ctx.info]', ...a), warn: (...a) => console.log('[ctx.warn]', ...a) },
};

m.apply(ctx, m.Config({}));
if (!captured) {
  console.error('apply() 没有注册适配器');
  process.exit(1);
}
console.log('registered providers:', JSON.stringify(captured.providers));

const adapter = captured.adapter;
console.log('providerInfo:', JSON.stringify(adapter.providerInfo('qoder-cn')));

// 复刻 LlmRuntime.listModels 的校验，避免又栽在 "invalid or duplicate model metadata"
const models = await adapter.listModels('qoder-cn');
const seen = new Set();
for (const m of models) {
  if (
    typeof m.provider !== 'string' ||
    m.provider !== 'qoder-cn' ||
    typeof m.id !== 'string' ||
    m.id.length === 0 ||
    typeof m.name !== 'string' ||
    m.name.length === 0 ||
    (m.description !== undefined && typeof m.description !== 'string') ||
    seen.has(m.id)
  ) {
    console.error('CATALOG REJECT:', JSON.stringify(m));
    process.exit(1);
  }
  seen.add(m.id);
}
console.log('catalog OK:', models.length, '->', models.slice(0, 3).map((x) => x.id).join(', '));

const resolved = await adapter.resolveModel('qoder-cn', 'DeepSeek-Flash');
if (resolved.provider !== 'qoder-cn' || !resolved.id || !resolved.name) {
  console.error('RESOLVE REJECT:', JSON.stringify(resolved));
  process.exit(1);
}
console.log('resolveModel:', JSON.stringify(resolved));

const prepared = await adapter.prepareCall('qoder-cn', 'DeepSeek-Flash');
console.log('prepareCall.model.id:', prepared.model.id);

const chunks = [];
const started = Date.now();
for await (const chunk of prepared.stream({
  provider: 'qoder-cn',
  model: 'DeepSeek-Flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：可用' }] }],
})) {
  chunks.push(chunk);
}
console.log(`\nchunks (${chunks.length}) in ${Date.now() - started}ms:`);
for (const c of chunks) {
  if (c.type === 'text-delta' || c.type === 'reasoning-delta') console.log(' ', c.type, JSON.stringify(c.text).slice(0, 120));
  else console.log(' ', c.type, JSON.stringify(c).slice(0, 160));
}
