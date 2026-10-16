/**
 * Worker 线程入口。
 *
 * **只有 `worker-pool.mjs` 会 import 它**（通过 `new Worker(new URL('./worker-entry.mjs', import.meta.url))`）。
 * 任务实现**不在这个文件里** —— 在 `worker-tasks.mjs`，主线程的退路也 import 同一份。
 */
import { parentPort } from 'node:worker_threads'
import { WORKER_TASKS } from './worker-tasks.mjs'

if (parentPort) {
  parentPort.on('message', (msg) => {
    const { id, task, payload } = msg ?? {}
    const fn = WORKER_TASKS[task]
    if (typeof fn !== 'function') {
      parentPort.postMessage({ id, ok: false, error: `未知任务：${task}` })
      return
    }
    try {
      const value = fn(payload)
      /* 结果里带 `rgba`（Uint8Array）就顺手把它的 buffer 转移回去，省一次整块拷贝 */
      const transfer = value && value.rgba && value.rgba.buffer ? [value.rgba.buffer] : []
      parentPort.postMessage({ id, ok: true, value }, transfer)
    } catch (e) {
      parentPort.postMessage({ id, ok: false, error: e?.message ?? String(e) })
    }
  })
}
