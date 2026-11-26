// 极简 zip 写入器：边生成边写进 HTTP 响应，一次只在内存里放一个文件（Render 免费版内存小）。
// 文本类压缩（deflate），图片/压缩包等已压缩的直接存储；文件名用 UTF-8（中文名在 Windows / Mac 解压都正常）。
'use strict';
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
const STORE_EXT = /\.(png|jpe?g|gif|webp|avif|zip|gz|7z|rar|mp3|m4a|aac|ogg|mp4|mov|webm|pdf|docx|xlsx|pptx|woff2?)$/i;

class ZipWriter {
  constructor(out) { this.out = out; this.offset = 0; this.entries = []; }
  async write(buf) {
    this.offset += buf.length;
    if (!this.out.write(buf)) await new Promise(r => this.out.once('drain', r)); // 尊重背压，慢网络不撑爆内存
  }
  async add(name, data, mtime = new Date()) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const store = STORE_EXT.test(name) || raw.length < 64;
    const body = store ? raw : zlib.deflateRawSync(raw, { level: 6 });
    const nameBuf = Buffer.from(name, 'utf8');
    // 非英文文件名再加一个 Info-ZIP Unicode Path 扩展字段（0x7075）：有些解压工具不看 UTF-8 标记，但认这个
    let extra = Buffer.alloc(0);
    if (/[^\x20-\x7e]/.test(name)) {
      extra = Buffer.alloc(9 + nameBuf.length);
      extra.writeUInt16LE(0x7075, 0); extra.writeUInt16LE(5 + nameBuf.length, 2); extra.writeUInt8(1, 4);
      extra.writeUInt32LE(crc32(nameBuf), 5); nameBuf.copy(extra, 9);
    }
    const { time, date } = dosTime(mtime);
    const crc = crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); // bit 11：文件名是 UTF-8
    h.writeUInt16LE(store ? 0 : 8, 8); h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(extra.length, 28);
    this.entries.push({ nameBuf, extra, crc, csize: body.length, size: raw.length, method: store ? 0 : 8, time, date, offset: this.offset });
    await this.write(h); await this.write(nameBuf); await this.write(extra); await this.write(body);
  }
  async end() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10); c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt16LE(e.extra.length, 30); // 32..41：注释、磁盘号、属性都为 0
      c.writeUInt32LE(e.offset, 42);
      await this.write(c); await this.write(e.nameBuf); await this.write(e.extra);
    }
    const size = this.offset - start;
    const z = Buffer.alloc(22);
    z.writeUInt32LE(0x06054b50, 0); z.writeUInt16LE(this.entries.length, 8); z.writeUInt16LE(this.entries.length, 10);
    z.writeUInt32LE(size, 12); z.writeUInt32LE(start, 16);
    await this.write(z);
    this.out.end();
  }
}
module.exports = { ZipWriter, crc32 };
