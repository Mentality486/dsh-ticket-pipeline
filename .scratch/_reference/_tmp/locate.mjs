import fs from 'node:fs'
const ARCHIVE='D:/ProgramFiles/workbuddy/resources/app.asar'
const fd=fs.openSync(ARCHIVE,'r')
const head=Buffer.alloc(16); fs.readSync(fd,head,0,16,0)
const jsonLen=head.readUInt32LE(12)
const jb=Buffer.alloc(jsonLen); fs.readSync(fd,jb,0,jsonLen,16)
let t=jb.toString('utf8'); t=t.slice(t.indexOf('{'),t.lastIndexOf('}')+1)
const header=JSON.parse(t); const dataStart=16+jsonLen
const out=[]
;(function walk(n,p){for(const [k,v] of Object.entries(n.files||{})){const q=p?p+'/'+k:k; if(v.files)walk(v,q); else out.push({path:q,size:v.size,off:Number(v.offset)})}})(header,'')
const target=Number(process.argv[2])
const hit=out.filter(e=>e.off<=target&&e.off+e.size>target)
for(const h of hit) console.log(h.path, h.size, h.off, 'rel', target-h.off)
