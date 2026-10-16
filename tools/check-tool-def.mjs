/**
 * 自检：`src/tool-def.mjs` 的**内置兜底**（宿主 `@deepseek-ai/dsh-tools` 不可用时走的那条路）。
 *
 * 为什么单独立一个套件（原 `selfcheck.mjs:4041-4092` 的「宿主包缺省」段）：
 *   MCP 版**默认就是无宿主环境**（`mcp-mc-agent` 的 dependencies 里没有 dsh 的任何包），
 *   所以内置路不是"边缘兜底"，而是**唯一的路**。它的行为必须逐条钉死。
 *
 * 覆盖：
 *   A. 内置 `builtinDefineTool` 行为（不依赖宿主，任何环境都跑）
 *   B. 有宿主时与宿主编译/校验**逐字对拍**（本机没装宿主就 ℹ️ 跳过）
 *
 * 🔴 必须从包目录跑（源码树里 import 会缺 minecraft 依赖）：
 *      cd <profile>/node_modules/mcp-mc-agent && node tools/check-tool-def.mjs
 */
const toolDef = await import('../src/tool-def.mjs')

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}

console.log(`工具定义来源 kind=${toolDef.toolDefKind()}${toolDef.loadNote ? '（' + toolDef.loadNote + '）' : ''}`)

/* ── 代表性 spec：覆盖 29 个内置工具实际用到的**全部**参数形态 ─────────────── */
const repSpec = {
  mode: { type: 'string', description: '模式' },
  count: { type: 'number' },
  flag: { type: 'boolean' },
  patch: { type: 'object', additionalProperties: true, description: '补丁' },
  steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '步骤' },
  names: { type: 'array', items: { type: 'string' } },
  value: { type: 'json', description: '任意值' },
  must: { type: 'string', required: true },
}
const textOut = { type: 'object', properties: {}, additionalProperties: true }

/* ── A1：与宿主编译器逐字对拍（本机没宿主就跳过）──────────────────────────── */
console.log('\n--- A. 与宿主编译器逐字对拍 ---')
{
  const hostMod = toolDef.hostDefineTool ? await import('@deepseek-ai/dsh-tools').then(() => import('@deepseek-ai/dsh-tools'), () => null) : null
  if (!hostMod) {
    console.log('  ℹ️ 本环境没有宿主 @deepseek-ai/dsh-tools，跳过逐字对拍（MCP 版的**正常**情况）')
  } else {
    const sameParams = JSON.stringify(hostMod.parameterSchemaSpecToJsonSchema(repSpec)) === JSON.stringify(toolDef.parameterSchemaSpecToJsonSchema(repSpec))
    ok(sameParams, '内置编译器的 parameters JSON Schema 与宿主**逐字一致**（含 key 顺序）')
    const sameOut = JSON.stringify(hostMod.valueSchemaSpecToJsonSchema(textOut)) === JSON.stringify(toolDef.valueSchemaSpecToJsonSchema(textOut))
    ok(sameOut, 'output.schema 走同一编译（text() 的形态逐字一致）')
    const schemaH = hostMod.parameterSchemaSpecToJsonSchema(repSpec)
    const schemaB = toolDef.parameterSchemaSpecToJsonSchema(repSpec)
    const badArgs = [{}, { must: 'x', count: 'no' }, { must: 'x', patch: 123 }, { must: 'x', patch: { k: {} }, value: new Date() }, { must: 'x', steps: 'nope' }, { must: 'x', names: ['a', 2] }]
    const vSame = badArgs.every((a) => JSON.stringify(hostMod.validateJsonSchemaValue(schemaH, a, '')) === JSON.stringify(toolDef.validateJsonSchemaValue(schemaB, a, '')))
    ok(vSame, `内置校验的违规文案/路径与宿主**逐字一致**（${badArgs.length} 组坏入参）`)
  }
}

/* ── A2：内置 defineTool 行为 ─────────────────────────────────────────────── */
console.log('\n--- B. 内置 defineTool 行为（MCP 的默认路径）---')
{
  const def = toolDef.builtinDefineTool({
    name: 't_def', description: 'd', parameters: repSpec, output: { schema: textOut, render: () => [] }, timeoutMs: 5000,
    async execute (args) { return { got: args.must } },
  })
  ok(def.timeoutMs === 5000, 'timeoutMs 透传（host defineTool 同款）')
  ok(def.name === 't_def' && typeof def.execute === 'function' && def.output?.schema, '产出形状 = {name, description, parameters, output:{schema,render}, timeoutMs, execute}')
  ok(JSON.stringify(def.parameters) === JSON.stringify(toolDef.parameterSchemaSpecToJsonSchema(repSpec)), '`parameters` 已是**编译好的 JSON Schema**（MCP inputSchema 直接可用）')
  ok(def.parameters.type === 'object' && Array.isArray(def.parameters.required) && def.parameters.required.includes('must'), '属性上的 required:true 被收进父级 required 数组')
  ok(def.parameters.properties.value && def.parameters.properties.value.type === undefined, "type:'json' 编译成**无 type 的注解节点**（合法 JSON Schema）")

  const bad = await def.execute({}).then(() => null, (e) => e)
  ok(bad && bad.name === 'ToolArgsError' && bad.code === 'INVALID_ARGS' && bad.message === 'invalid arguments: missing required property "must"',
    '坏入参抛 ToolArgsError/INVALID_ARGS，文案与宿主逐字一致', bad ? JSON.stringify(bad.message) : '没抛')
  const good = await def.execute({ must: 'hi' }).then((r) => r, () => null)
  ok(good && good.got === 'hi', '合法入参放行到用户实现')

  const threw = (fn) => { try { fn(); return false } catch { return true } }
  ok(threw(() => toolDef.parameterSchemaSpecToJsonSchema({ x: { oneOf: [{ type: 'string' }] } })), '未支持形态（oneOf）抛错（防静默走样）')
  ok(threw(() => toolDef.parameterSchemaSpecToJsonSchema({ x: { type: 'object' } })), 'object 不写 additionalProperties 抛错（宿主同款约束）')
  ok(threw(() => toolDef.builtinDefineTool({ name: 't', description: 'd', parameters: {}, output: { schema: textOut, render: () => [] }, finalizeContent: () => {}, execute: async () => ({}) })), '未支持选项（finalizeContent）抛错（将来真要用会当场红）')
  ok(threw(() => toolDef.builtinDefineTool({ name: 't', description: 'd', parameters: {}, output: { schema: textOut, render: () => [] }, timeoutMs: 0, execute: async () => ({}) })), '非法 timeoutMs 抛错（宿主同款）')
}

/* ── C：MCP 专属契约 —— render 的返回形状必须能直接当 content block ────────── */
console.log('\n--- C. MCP 契约：output.render → content block ---')
{
  const text = toolDef.builtinDefineTool({
    name: 't_render', description: 'd', parameters: {}, output: { schema: textOut, render: () => [{ type: 'text', text: 'hello' }] },
    execute: async () => ({}),
  })
  const blocks = text.output.render({}, {})
  ok(Array.isArray(blocks) && blocks[0]?.type === 'text' && blocks[0]?.text === 'hello', 'render 返回 [{type:"text", text}]（= MCP content block 形状）')
  ok(toolDef.toolDefKind() === 'builtin' || toolDef.toolDefKind() === 'host', `toolDefKind() 有明确取值：${toolDef.toolDefKind()}`)
  ok(typeof toolDef.validateJsonSchemaValue === 'function' && typeof toolDef.parameterSchemaSpecToJsonSchema === 'function', '导出 parameterSchemaSpecToJsonSchema / validateJsonSchemaValue')
}

console.log(`\n${fail === 0 ? '✅ 全过' : '❌ 有失败'}：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail === 0 ? 0 : 1)
