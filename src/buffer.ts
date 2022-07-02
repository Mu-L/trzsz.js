/**
 * trzsz: https://github.com/trzsz/trzsz.js
 * Copyright(c) 2022 Lonny Wong <lonnywong@qq.com>
 * @license MIT
 */

/* eslint-disable require-jsdoc */

import { strToUint8, uint8ToStr, TrzszError } from "./comm";

function isVT100End(c: number): boolean {
  if (0x61 <= c && c <= 0x7a) {
    // 'a' <= c && c <= 'z'
    return true;
  }
  if (0x41 <= c && c <= 0x5a) {
    // 'A' <= c && c <= 'Z'
    return true;
  }
  return false;
}

function isTrzszLetter(c: number): boolean {
  if (0x61 <= c && c <= 0x7a) {
    // 'a' <= c && c <= 'z'
    return true;
  }
  if (0x41 <= c && c <= 0x5a) {
    // 'A' <= c && c <= 'Z'
    return true;
  }
  if (0x30 <= c && c <= 0x39) {
    // '0' <= c && c <= '9'
    return true;
  }
  if (c == 0x23 || c == 0x3A || c == 0x2B || c == 0x2F || c == 0x3D) {
    // c == '#' || c == ':' || c == '+' || c == '/' || c == '='
    return true;
  }
  return false;
}

export class TrzszBuffer {
  private bufArray: (string | ArrayBuffer | Uint8Array | Blob | null)[] = [];
  private resolve: Function | null = null;
  private reject: Function | null = null;
  private bufHead: number = 0;
  private bufTail: number = 0;
  private nextIdx: number = 0;
  private nextBuf: Uint8Array | null = null;
  private arrBuf: ArrayBuffer = new ArrayBuffer(128);

  public addBuffer(buf: string | ArrayBuffer | Uint8Array | Blob) {
    this.bufArray[this.bufTail++] = buf;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
      this.reject = null;
    }
  }

  public stopBuffer() {
    if (this.reject) {
      this.reject(new TrzszError("Stopped"));
      this.reject = null;
      this.resolve = null;
    }
  }

  public drainBuffer() {
    this.bufArray = [];
    this.bufHead = 0;
    this.bufTail = 0;
  }

  private async toUint8Array(buf: string | ArrayBuffer | Uint8Array | Blob) {
    if (typeof buf === "string") {
      return strToUint8(buf);
    } else if (buf instanceof ArrayBuffer) {
      return new Uint8Array(buf);
    } else if (buf instanceof Uint8Array) {
      return buf;
    } else if (buf instanceof Blob) {
      const buffer = await buf.arrayBuffer();
      return new Uint8Array(buffer);
    } else {
      throw new TrzszError("The buffer type is not supported", null, true);
    }
  }

  private async nextBuffer() {
    if (this.nextBuf && this.nextIdx < this.nextBuf.length) {
      return this.nextBuf.subarray(this.nextIdx);
    }
    if (this.bufHead === this.bufTail) {
      if (this.bufHead !== 0) {
        this.bufHead = 0;
        this.bufTail = 0;
      }
      await new Promise((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
      });
    }
    const buf = this.bufArray[this.bufHead];
    this.bufArray[this.bufHead] = null;
    this.bufHead++;
    this.nextBuf = await this.toUint8Array(buf);
    this.nextIdx = 0;
    return this.nextBuf;
  }

  private growBuffer(dst: Uint8Array, idx: number, min: number) {
    const len = Math.max(dst.length * 2, idx + min);
    this.arrBuf = new ArrayBuffer(len);
    const buf = new Uint8Array(this.arrBuf);
    buf.set(dst.subarray(0, idx));
    return buf;
  }

  private appendBuffer(dst: Uint8Array, idx: number, src: Uint8Array) {
    const buf = dst.length >= idx + src.length ? dst : this.growBuffer(dst, idx, src.length);
    buf.set(src, idx);
    return buf;
  }

  public async readLine() {
    let buf = new Uint8Array(this.arrBuf);
    let len = 0;
    while (true) {
      let next = await this.nextBuffer();
      const newLineIdx = next.indexOf(0x0a); // '\n'
      if (newLineIdx >= 0) {
        this.nextIdx += newLineIdx + 1; // +1 to ignroe the '\n'
        next = next.subarray(0, newLineIdx);
      } else {
        this.nextIdx += next.length;
      }
      if (next.includes(0x03)) {
        // `ctrl + c` to interrupt
        throw new TrzszError("Interrupted");
      }
      buf = this.appendBuffer(buf, len, next);
      len += next.length;
      if (newLineIdx >= 0) {
        return uint8ToStr(buf.subarray(0, len));
      }
    }
  }

  public async readBinary(len: number) {
    if (this.arrBuf.byteLength < len) {
      this.arrBuf = new ArrayBuffer(len);
    }
    const buf = new Uint8Array(this.arrBuf, 0, len);
    let idx = 0;
    while (idx < len) {
      const left = len - idx;
      let next = await this.nextBuffer();
      if (next.length > left) {
        this.nextIdx += left;
        next = next.subarray(0, left);
      } else {
        this.nextIdx += next.length;
      }
      buf.set(next, idx);
      idx += next.length;
    }
    return buf;
  }

  public async readLineOnWindows() {
    let buf = new Uint8Array(this.arrBuf);
    let skipVT100 = false;
    let idx = 0;
    while (true) {
      let next = await this.nextBuffer();
      const newLineIdx = next.indexOf(0x21); // '!'
      if (newLineIdx >= 0) {
        this.nextIdx += newLineIdx + 1; // +1 to ignroe the '\n'
        next = next.subarray(0, newLineIdx);
      } else {
        this.nextIdx += next.length;
      }
      for (let i = 0; i < next.length; i++) {
        const c = next[i];
        if (c == 0x03) {
          // `ctrl + c` to interrupt
          throw new TrzszError("Interrupted");
        }
        if (skipVT100) {
          if (isVT100End(c)) {
            skipVT100 = false;
          }
        } else if (c == 0x1b) {
          skipVT100 = true;
        } else if (isTrzszLetter(c)) {
          if (idx >= buf.length) {
            buf = this.growBuffer(buf, idx, next.length);
          }
          buf[idx++] = c;
        }
      }
      if (newLineIdx >= 0) {
        return uint8ToStr(buf.subarray(0, idx));
      }
    }
  }
}
