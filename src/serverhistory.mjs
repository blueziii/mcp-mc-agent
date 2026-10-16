// -*- coding: utf-8 -*-
/**
 * mcp-mc-agent / serverhistory.mjs —— 「连接到MC」弹窗的**服务器地址历史**（全局）
 * ============================================================================
 * 用户在弹窗里**手动**连过的服务器地址（**只存地址字符串**，不存账户、不存凭据）。
 * 落盘：`<状态目录>/servers.json`（= `<状态目录>/servers.json`）—— **全局**，不按工作区。
 *
 * 规矩：
 *   · 只记"在本弹窗里点「连接」"的地址；**局域网探测到的直连不记**（调用方负责别调 `record`）；
 *   · 去重、最近优先、封顶 {@link MAX_SERVERS} 条；
 *   · 读宽容（坏文件按空跑、绝不抛）、写克制（失败只记 `lastError`）。
 * ============================================================================
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 文件名（与 accounts.json / config.json 同在状态目录根级） */
export const SERVERS_FILE = 'servers.json'
/** 封顶条数 */
export const MAX_SERVERS = 20

export class ServerHistory {
  /** @param {{dir:string}} opts dir = 状态目录（`<状态目录>`；自检里是临时目录） */
  constructor ({ dir } = {}) {
    this.dir = dir
    this.file = join(dir, SERVERS_FILE)
    this.data = { version: 1, recent: [] }
    this.lastError = null
    this._loadFailed = false
    this._loadError = null
    this.load()
  }

  load () {
    try {
      if (!existsSync(this.file)) { this.data = { version: 1, recent: [] }; return }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const recent = Array.isArray(parsed?.recent)
        ? parsed.recent.map((x) => String(x ?? '').trim()).filter(Boolean)
        : []
      this.data = { version: 1, recent }
    } catch (e) {
      this.data = { version: 1, recent: [] }
      this.lastError = `服务器历史读取失败（已按空跑）：${e.message}`
      /* 🟡 2026-10-15 审计（报告 E 第 9 条）：`lastError` 全仓无人读 ⇒ 读失败静默按空跑。
       *   另开一对只读访问器给 UI 用（见 `loadFailed` / `loadError`）。 */
      this._loadFailed = true
      this._loadError = this.lastError
    }
  }

  save () {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      /* 🟡 2026-10-15 审计（报告 E 第 9 条）：原来直接 `writeFileSync` —— 写一半断电/被杀就留下
       *   半个 JSON（下次启动就是"读失败"，历史全空）。与 `src/wsconfig.mjs:112-116` 统一成
       *   先写临时文件再 rename（同分区上原子）。 */
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      renameSync(tmp, this.file)
      return true
    } catch (e) {
      this.lastError = `服务器历史写入失败：${e.message}`
      return false
    }
  }

  /** 最近优先的地址列表（副本） */
  list () { return this.data.recent.slice() }

  /** 读失败过没有（`load()` 里按空跑时的原因）—— UI 用它提示"历史可能丢了" */
  get loadFailed () { return Boolean(this._loadFailed) }
  get loadError () { return this._loadError ?? null }

  /** 记一条（去重、最近优先、封顶）。空串忽略。返回最新列表。 */
  record (address) {
    const addr = String(address ?? '').trim()
    if (!addr) return this.list()
    this.data.recent = [addr, ...this.data.recent.filter((a) => a !== addr)].slice(0, MAX_SERVERS)
    /* 🟡 2026-10-15 审计（报告 E 第 9 条）：`save()` 失败只记 `lastError`，全仓无人读 ——
     *   用户以为记下了，其实没落盘。这里补一行日志（有 logger 才打）。 */
    if (!this.save()) try { this.logger?.warn?.(this.lastError) } catch { /* 日志失败无所谓 */ }
    return this.list()
  }

  /** 删一条（没这条就原样）。返回最新列表。 */
  remove (address) {
    const addr = String(address ?? '').trim()
    this.data.recent = this.data.recent.filter((a) => a !== addr)
    this.save()
    return this.list()
  }
}
