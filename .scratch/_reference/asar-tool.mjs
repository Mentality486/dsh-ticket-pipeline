// Minimal asar reader: list and extract entries from an Electron asar archive.
// Usage:
//   node asar-tool.mjs <archive> list <prefix> [limit]
//   node asar-tool.mjs <archive> index <outFile>
//   node asar-tool.mjs <archive> extract <entry> <outFile>
import fs from 'node:fs'
import path from 'node:path'

const ARCHIVE = process.argv[2]
const CMD = process.argv[3]

const fd = fs.openSync(ARCHIVE, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)   // pickle size at offset 4
const jsonLen = head.readUInt32LE(12)     // string length at offset 12
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
let text = jsonBuf.toString('utf8')
const start = text.indexOf('{')
const header = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1))
const dataStart = 16 + jsonLen

function walk (node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (child.files) walk(child, p, out)
    else out.push({ path: p, size: child.size, offset: Number(child.offset), unpacked: !!child.unpacked })
  }
  return out
}

const all = walk(header, '', [])

if (CMD === 'list') {
  const prefix = process.argv[4] || ''
  const limit = Number(process.argv[5] || 200)
  let n = 0
  for (const e of all) {
    if (e.path.startsWith(prefix)) { if (n++ < limit) console.log((e.unpacked ? 'U' : ' ') + ' ' + String(e.size).padStart(9) + ' ' + e.path) }
  }
  console.log('matched ' + n)
} else if (CMD === 'index') {
  fs.writeFileSync(process.argv[4], all.map(e => e.path).join('\n'))
  console.log('entries ' + all.length + ' -> ' + process.argv[4])
} else if (CMD === 'extract') {
  const entry = process.argv[4]
  const outFile = process.argv[5]
  const e = all.find(x => x.path === entry)
  if (!e) { console.log('not found: ' + entry); process.exit(2) }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  const buf = Buffer.alloc(e.size)
  fs.readSync(fd, buf, 0, e.size, dataStart + e.offset)
  fs.writeFileSync(outFile, buf)
  console.log('wrote ' + outFile + ' (' + e.size + ' bytes)')
}
fs.closeSync(fd)
