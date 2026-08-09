#!/usr/bin/env node
/*
 * build_asar.js —— 轻量 asar 打包/解包工具
 * ---------------------------------------------------------------
 * 沙箱内 electron-builder 与官方 asar CLI 不可用时的兜底。
 * 用法：
 *   node build_asar.js packApp <projectRoot> <outAsar>
 *       把 package.json / main.js / preload.js / index.html / assets/** 打包为 asar
 *   node build_asar.js pack <srcDir> <outAsar>   打包整个目录
 *   node build_asar.js extract <asar> <outDir>   解包
 *   node build_asar.js list <asar>               列出文件
 *
 * asar 格式：8 字节 uint64 LE 头长度 + 头 JSON（按 4 字节补齐）+ 文件数据顺序拼接。
 * 文件 offset/size 相对数据段起点；Electron 据此随机读取，无需解压全部。
 */
'use strict';
const fs = require('fs');
const path = require('path');

function collect(dir, base, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) collect(abs, rel, out);
    else if (e.isFile()) out.push({ rel, abs });
  }
}

function buildTree(files) {
  const root = {};
  for (const f of files) {
    const parts = f.rel.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (!node[p] || !node[p].files) node[p] = { files: {} };
      node = node[p].files;
    }
    const name = parts[parts.length - 1];
    node[name] = { size: String(f.size), offset: String(f.offset), mode: f.mode, executable: false };
  }
  return root;
}

function packFromFiles(files, outAsar) {
  let offset = 0;
  for (const f of files) {
    const st = fs.statSync(f.abs);
    f.size = st.size; f.mode = st.mode; f.offset = offset; offset += f.size;
  }
  const header = { files: buildTree(files) };
  const headerJSON = JSON.stringify(header);
  const headerBuf = Buffer.from(headerJSON, 'utf8');
  const pad = (4 - (headerBuf.length % 4)) % 4;
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeUInt32LE(headerBuf.length, 0); // 低 32 位；高 32 位为 0（头远小于 4GB）
  const ws = fs.createWriteStream(outAsar);
  ws.write(sizeBuf);
  ws.write(headerBuf);
  if (pad) ws.write(Buffer.alloc(pad, 0));
  for (const f of files) ws.write(fs.readFileSync(f.abs));
  ws.end();
  ws.on('finish', () => console.log('[asar] packed', files.length, 'files ->', outAsar,
    '(' + fs.statSync(outAsar).size + ' bytes)'));
}

function pack(dir, outAsar) {
  const files = [];
  collect(dir, '', files);
  packFromFiles(files, outAsar);
}

function packApp(root, outAsar) {
  const files = [];
  for (const m of ['package.json', 'main.js', 'preload.js', 'index.html']) {
    files.push({ rel: m, abs: path.join(root, m) });
  }
  collect(path.join(root, 'assets'), 'assets', files);
  packFromFiles(files, outAsar);
}

function readHeader(asar) {
  const fd = fs.openSync(asar, 'r');
  const sizeBuf = Buffer.alloc(8);
  fs.readSync(fd, sizeBuf, 0, 8, 0);
  const headerSize = sizeBuf.readUInt32LE(0);
  const headerBuf = Buffer.alloc(headerSize);
  fs.readSync(fd, headerBuf, 0, headerSize, 8);
  const header = JSON.parse(headerBuf.toString('utf8'));
  const pad = (4 - (headerSize % 4)) % 4;
  const dataStart = 8 + headerSize + pad;
  fs.closeSync(fd);
  return { header, dataStart };
}

function walkFiles(node, prefix, out) {
  for (const [name, val] of Object.entries(node)) {
    const rel = prefix ? prefix + '/' + name : name;
    if (val.files) walkFiles(val.files, rel, out);
    else out.push({ rel, ...val });
  }
}

function extract(asar, outDir) {
  const { header, dataStart } = readHeader(asar);
  const files = [];
  walkFiles(header.files, '', files);
  const fd = fs.openSync(asar, 'r');
  for (const f of files) {
    const buf = Buffer.alloc(Number(f.size));
    fs.readSync(fd, buf, 0, Number(f.size), dataStart + Number(f.offset));
    const dest = path.join(outDir, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }
  fs.closeSync(fd);
  console.log('[asar] extracted', files.length, 'files ->', outDir);
}

function list(asar) {
  const { header } = readHeader(asar);
  const files = [];
  walkFiles(header.files, '', files);
  for (const f of files) console.log(String(f.size).padEnd(10), f.rel);
}

const cmd = process.argv[2];
if (cmd === 'packApp') packApp(process.argv[3], process.argv[4]);
else if (cmd === 'pack') pack(process.argv[3], process.argv[4]);
else if (cmd === 'extract') extract(process.argv[3], process.argv[4]);
else if (cmd === 'list') list(process.argv[3]);
else { console.log('usage: node build_asar.js <packApp|pack|extract|list> <in> <out>'); process.exit(1); }
