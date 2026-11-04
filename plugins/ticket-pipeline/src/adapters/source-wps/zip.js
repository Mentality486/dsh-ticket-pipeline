/**
 * 最小 zip 读取器 —— 只为解 xlsx / docx 这类 OOXML 容器。
 *
 * 为什么自己写：本机不能 `npm install`（见 AGENTS.md 的零依赖约束），而 xlsx 就是
 * 一个 zip：只要读得懂 central directory 再用 `node:zlib` 的 `inflateRaw` 解开，
 * 就够把 `xl/worksheets/sheet1.xml` 与 `xl/media/*` 取出来。
 *
 * 不做的事：不解加密、不写 zip、不校验 CRC —— 这三样在「读一份人下载下来的表格」
 * 这个场景里都不会遇到。**遇到不支持的形状一律报 invalid-input 并说清是哪一步**，
 * 不要返回一个「看起来解开了」的空结果：调用方会把它当成「表里没有工单」。
 */

import { inflateRawSync } from 'node:zlib'

import { PipelineError } from '../../contracts/errors.js'

/** 本地文件头签名，同时也是「这是不是 zip」的判断依据。 */
const LOCAL_HEADER_SIG = 0x04034b50
/** `PK\005\006`：空 zip 只有这一条记录，没有 central directory。 */
const EOCD_SIG = 0x06054b50
/** `PK\001\002`：central directory 的每个文件条目。 */
const CENTRAL_HEADER_SIG = 0x02014b50

const EOCD_MIN_SIZE = 22
const MAX_COMMENT_LEN = 0xffff

/** 单个条目解压后上限。xlsx 里单个 XML 正常远小于这个数，超了基本是压缩炸弹。 */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

/**
 * @typedef {Object} ZipEntry
 * @property {string} name 条目路径，如 `xl/worksheets/sheet1.xml`
 * @property {number} method 0=stored，8=deflate
 * @property {number} compressedSize
 * @property {number} size 解压后字节数（来自 central directory，仅作参考，真值以解压结果为准）
 * @property {number} localHeaderOffset
 */

/**
 * 读 zip 的目录表（不解压）。
 *
 * 为什么从 central directory 读而不是顺着本地头往后走：本地头的「大小」字段在
 * 数据描述符（bit 3）存在时是 0，顺着头走会算出错误的下一项偏移。central directory
 * 是 zip 规范里的权威索引，所有写 zip 的工具都会写它。
 *
 * @param {Uint8Array} bytes
 * @returns {ZipEntry[]}
 */
export function readZipEntries (bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new PipelineError('invalid-input', '文件是空的，读不出 zip 目录')
  }
  if (bytes.length < EOCD_MIN_SIZE || readUint32(bytes, 0) !== LOCAL_HEADER_SIG) {
    throw new PipelineError('invalid-input', '这不是一个 zip 容器（xlsx 本质是 zip，请确认下载的是原始文件而不是网页 / 快捷方式）')
  }

  const eocdOffset = findEndOfCentralDirectory(bytes)
  if (eocdOffset < 0) {
    throw new PipelineError('invalid-input', 'zip 目录结尾记录（EOCD）找不到，文件可能被截断')
  }

  const total = readUint16(bytes, eocdOffset + 10)
  let cursor = readUint32(bytes, eocdOffset + 16)

  /** @type {ZipEntry[]} */
  const entries = []
  for (let i = 0; i < total; i += 1) {
    if (cursor + 46 > bytes.length || readUint32(bytes, cursor) !== CENTRAL_HEADER_SIG) {
      throw new PipelineError('invalid-input', `zip 目录第 ${i + 1} 项损坏，文件可能被截断`)
    }
    const method = readUint16(bytes, cursor + 10)
    const compressedSize = readUint32(bytes, cursor + 20)
    const size = readUint32(bytes, cursor + 24)
    const nameLen = readUint16(bytes, cursor + 28)
    const extraLen = readUint16(bytes, cursor + 30)
    const commentLen = readUint16(bytes, cursor + 32)
    const localHeaderOffset = readUint32(bytes, cursor + 42)
    const nameStart = cursor + 46
    const name = decodeUtf8(bytes.subarray(nameStart, nameStart + nameLen))
    entries.push({ name, method, compressedSize, size, localHeaderOffset })
    cursor = nameStart + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * 按名字取一个条目的解压后字节。
 *
 * @param {Uint8Array} bytes 整个 zip
 * @param {ZipEntry[]} entries `readZipEntries` 的结果
 * @param {string} name
 * @returns {Uint8Array | undefined} 条目不存在时返回 undefined（是否必须存在由调用方决定）
 */
export function readZipEntry (bytes, entries, name) {
  const entry = entries.find((item) => item.name === name)
  if (!entry) return undefined
  return extractEntry(bytes, entry)
}

/**
 * 解压单个条目。
 *
 * @param {Uint8Array} bytes
 * @param {ZipEntry} entry
 * @returns {Uint8Array}
 */
export function extractEntry (bytes, entry) {
  const { compressedSize } = entry
  if (compressedSize > bytes.length) {
    throw new PipelineError('invalid-input', `zip 条目 ${entry.name} 的长度字段越界，文件可能被截断`)
  }
  const start = localHeaderOffsetToDataStart(bytes, entry)
  const end = start + compressedSize
  if (end > bytes.length) {
    throw new PipelineError('invalid-input', `zip 条目 ${entry.name} 的数据越界，文件可能被截断`)
  }
  const raw = bytes.subarray(start, end)

  if (entry.method === 0) return raw
  if (entry.method !== 8) {
    throw new PipelineError('invalid-input', `zip 条目 ${entry.name} 用了不支持的压缩方式 ${entry.method}（只支持 stored / deflate）`)
  }

  let out
  try {
    out = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES })
  } catch (error) {
    throw new PipelineError(
      'invalid-input',
      `zip 条目 ${entry.name} 解压失败：${error instanceof Error ? error.message : String(error)}`,
      error,
    )
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

/**
 * 用条目自己的本地头定位数据起点。
 *
 * 为什么不用 central directory 里记的偏移直接用：两者理论上一致，但本地头的
 * 文件名长度与 central 的小概率不一致，按本地头算最稳。
 *
 * @param {Uint8Array} bytes
 * @param {ZipEntry} entry
 * @returns {number}
 */
function localHeaderOffsetToDataStart (bytes, entry) {
  const offset = entry.localHeaderOffset
  if (offset + 30 > bytes.length || readUint32(bytes, offset) !== LOCAL_HEADER_SIG) {
    throw new PipelineError('invalid-input', `zip 条目 ${entry.name} 的本地文件头损坏`)
  }
  const nameLen = readUint16(bytes, offset + 26)
  const extraLen = readUint16(bytes, offset + 28)
  return offset + 30 + nameLen + extraLen
}

/**
 * 从文件尾往前找 EOCD。
 *
 * 必须倒着找：EOCD 后面可能跟最多 64KB 的注释。正着找会把注释里恰好出现的
 * `PK\005\006` 当成目录结尾。
 *
 * @param {Uint8Array} bytes
 * @returns {number} 找不到返回 -1
 */
function findEndOfCentralDirectory (bytes) {
  const lowest = Math.max(0, bytes.length - EOCD_MIN_SIZE - MAX_COMMENT_LEN)
  for (let offset = bytes.length - EOCD_MIN_SIZE; offset >= lowest; offset -= 1) {
    if (readUint32(bytes, offset) === EOCD_SIG) return offset
  }
  return -1
}

/** @param {Uint8Array} bytes @param {number} offset */
function readUint16 (bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

/** @param {Uint8Array} bytes @param {number} offset */
function readUint32 (bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

const utf8Decoder = new TextDecoder('utf-8')

/** @param {Uint8Array} bytes @returns {string} */
export function decodeUtf8 (bytes) {
  return utf8Decoder.decode(bytes)
}
