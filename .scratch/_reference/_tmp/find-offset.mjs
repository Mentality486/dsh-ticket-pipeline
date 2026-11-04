import fs from 'node:fs'
const idx = JSON.parse(fs.readFileSync('.scratch/_reference/_tmp/wb-asars.json','utf8'))
// idx is array of {path,size,offset,unpacked}? check shape
console.log(Array.isArray(idx), Object.keys(idx).slice(0,5))
