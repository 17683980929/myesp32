/**
 * unzip.mjs — 极简 zip 解包（只支持 store / deflate，够 CI 打的包用）
 * 只写文件，不保留权限；调用方负责路径校验。
 */
import { inflateRawSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

/** 读中央目录，返回 [{ name, method, compSize, size, offset }] */
function entries(buf) {
  // 从尾部找 EOCD（0x06054b50），注释最长 65535
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是 zip 文件");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    out.push({ name, method, compSize, size, offset });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/** 解出单个条目内容 */
function read(buf, e) {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error("本地头损坏: " + e.name);
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error("不支持的压缩方式: " + e.method);
}

/**
 * 解包到 destDir，返回写出的文件列表。
 * 拒绝绝对路径、..、以及不在白名单前缀下的条目。
 */
export function unzipTo(buf, destDir, { allowPrefix, maxBytes = 16 * 1024 * 1024 }) {
  const list = entries(buf);
  let total = 0;
  const written = [];
  for (const e of list) {
    if (e.name.endsWith("/")) continue;
    const norm = e.name.replace(/\\/g, "/");
    if (norm.startsWith("/") || norm.includes("..")) throw new Error("非法路径: " + e.name);
    if (!allowPrefix.some((p) => norm.startsWith(p))) throw new Error("不允许的目录: " + e.name);
    if (e.size > maxBytes || (total += e.size) > maxBytes) throw new Error("包太大");
    const dst = path.join(destDir, norm);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, read(buf, e));
    written.push(norm);
  }
  return written;
}
