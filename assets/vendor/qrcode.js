/**
 * qrcode.js —— 零依赖 QR Code 生成器（Model 2，byte 模式）
 *
 * ## 为什么自己写
 *
 * 项目跑在 Cloudflare Pages 上，除了 Vue 与 FontAwesome **没有任何第三方
 * 前端依赖**（见 `vendor/`）。分享功能要显示二维码，但为一个 200 字符的
 * 文本去引入一整个库、并额外承担一次外部请求，性价比太低 —— 二维码的
 * 编码规范是公开且稳定的，纯 JS 实现约 400 行即可覆盖本站全部场景。
 *
 * ## 覆盖范围（刻意收窄）
 *
 *   · 模式：**仅 byte 模式**（ECT 0100）。分享链接是 ASCII URL，
 *     用 byte 模式编码 UTF-8 字节即可；数字 / 字母数字模式只是省几位，
 *     对 40 字符的 URL 没有意义，却要多出两套编码表与混合模式分段逻辑。
 *   · 版本：1 ~ 10。纠错级别 M 时最多容纳 213 字节，远超本站链接长度
 *     （`/s/<slug>` 形态的绝对 URL 通常 40 ~ 60 字符）。超出时明确报错，
 *     而不是静默生成一个扫不出来的码。
 *   · 纠错：L / M / Q / H 四档全支持（默认 M）。
 *
 * ## 规范要点
 *
 * 编码流程严格按 ISO/IEC 18004：
 *   数据码字 → 分块 + Reed-Solomon 纠错码字 → 交织 → 按锯齿路径填入矩阵
 *   → 放置功能图形（定位 / 对齐 / 定时 / 格式 / 版本信息）→ 八种掩码各算
 *   一次惩罚分，取最低者。
 *
 * 掩码必须真的挑：固定用 mask 0 在遇到大片同色区域时会显著降低扫描器
 * 的识别率（例如纯数字 URL 会产生规则条纹）。
 *
 * @module vendor/qrcode
 */

(function (global) {
  'use strict';

  /* ==========================================================
   * 1. 伽罗瓦域 GF(256) 与 Reed-Solomon
   * ========================================================== */

  // 本原多项式 x^8 + x^4 + x^3 + x^2 + 1（0x11D）
  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);

  (function initGaloisField() {
    var x = 1;
    for (var i = 0; i < 255; i += 1) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      // 溢出到 9 位时按本原多项式取模（异或 0x11D 的低 8 位）
      if (x & 0x100) x ^= 0x11d;
    }
    // 尾部复制一份，让 exp 表可以直接用大于 255 的下标做加法而不取模
    for (var j = 255; j < 512; j += 1) GF_EXP[j] = GF_EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  /**
   * 生成 n 个纠错码字对应的生成多项式（首项系数为 1，返回低次在前）。
   * 递推：g(x) = g(x) · (x - α^i)
   */
  function rsGeneratorPolynomial(degree) {
    var poly = [1];
    for (var i = 0; i < degree; i += 1) {
      var next = new Array(poly.length + 1).fill(0);
      for (var j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];                    // 乘以 x
        next[j + 1] ^= gfMul(poly[j], GF_EXP[i]); // 乘以 α^i
      }
      poly = next;
    }
    return poly;
  }

  /**
   * 综合除法求纠错码字。
   *
   * 两个容易踩空的地方，都写在断言式的注释里：
   *
   *  1. 余数长度是 `degree`（= 生成多项式项数 - 1），不是项数本身。
   *  2. 用的是 `generator[j + 1]` —— generator[0] 恒为 1，它的作用已经
   *     通过 `factor` 体现在「消掉最高项」这一步里了；再乘一遍等于把
   *     首项也减掉，整个余数会错位（这个 bug 的现场是：码字看着像对的，
   *     前几位甚至相同，但整块纠错码全错，扫出来的码无法识别）。
   *
   * @param data - 数据码字。
   * @param generator - {@link rsGeneratorPolynomial} 的结果（降幂，首项为 1）。
   * @returns 长度为 `degree` 的纠错码字数组。
   */
  function rsRemainder(data, generator) {
    var degree = generator.length - 1;
    var remainder = new Array(degree).fill(0);
    for (var i = 0; i < data.length; i += 1) {
      var factor = data[i] ^ remainder.shift();
      remainder.push(0);
      for (var j = 0; j < degree; j += 1) {
        remainder[j] ^= gfMul(generator[j + 1], factor);
      }
    }
    return remainder;
  }

  /* ==========================================================
   * 2. 版本 / 纠错参数表（版本 1 ~ 10）
   * ========================================================== */

  /**
   * 每个条目：[每块纠错码字数, 组1块数, 组1数据码字数, 组2块数, 组2数据码字数]
   * 组 2 为 0 表示该版本所有块大小相同。
   *
 * 这张表是规范里最易抄错的部分，改动后务必跑 `python3 scripts/verify-qrcode.py`：
 * 它拿本实现与 Python `qrcode` 库逐位比对矩阵。
   */
  var EC_TABLE = {
    L: [
      [7, 1, 19, 0, 0], [10, 1, 34, 0, 0], [15, 1, 55, 0, 0], [20, 1, 80, 0, 0],
      [26, 1, 108, 0, 0], [18, 2, 68, 0, 0], [20, 2, 78, 0, 0], [24, 2, 97, 0, 0],
      [30, 2, 116, 0, 0], [18, 2, 68, 2, 69],
    ],
    M: [
      [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
      [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
      [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
    ],
    Q: [
      [13, 1, 13, 0, 0], [22, 1, 22, 0, 0], [18, 2, 17, 0, 0], [26, 2, 24, 0, 0],
      [18, 2, 15, 2, 16], [24, 4, 19, 0, 0], [18, 2, 14, 4, 15], [22, 4, 18, 2, 19],
      [20, 4, 16, 4, 17], [30, 6, 19, 2, 20],
    ],
    H: [
      [17, 1, 9, 0, 0], [28, 1, 16, 0, 0], [22, 2, 13, 0, 0], [16, 4, 9, 0, 0],
      [22, 2, 11, 2, 12], [28, 4, 16, 0, 0], [26, 4, 13, 1, 14], [26, 4, 14, 2, 15],
      [24, 4, 12, 4, 13], [28, 6, 15, 2, 16],
    ],
  };

  /** 各版本的对齐图案中心坐标（版本 1 没有对齐图案）。 */
  var ALIGNMENT_POSITIONS = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42],
    [6, 26, 46], [6, 28, 50],
  ];

  var ECL_BITS = { L: 0x01, M: 0x00, Q: 0x03, H: 0x02 };
  var MAX_VERSION = 10;

  /* ==========================================================
   * 3. 数据编码
   * ========================================================== */

  /** UTF-8 编码。刻意手写而不用 TextEncoder：后者在极老的 Safari 上缺失。 */
  function utf8Bytes(text) {
    var bytes = [];
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
        // 代理对：算出真正的码点再编码为 4 字节
        var next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          var point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i += 1;
          bytes.push(
            0xf0 | (point >> 18),
            0x80 | ((point >> 12) & 0x3f),
            0x80 | ((point >> 6) & 0x3f),
            0x80 | (point & 0x3f)
          );
        } else {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return bytes;
  }

  /** 位流 writer：按 MSB-first 逐个 bit 追加。 */
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  };
  BitBuffer.prototype.putBytes = function (bytes) {
    for (var i = 0; i < bytes.length; i += 1) this.put(bytes[i], 8);
  };

  /** 数据容量（字节数）：由版本与纠错级别反推，用于选版本。 */
  function dataCapacity(version, ecl) {
    var cfg = EC_TABLE[ecl][version - 1];
    var dataCodewords = cfg[1] * cfg[2] + cfg[3] * cfg[4];
    var countBits = version < 10 ? 8 : 16;
    // 容量 = 数据码字位数 - 模式指示符(4) - 字符计数位，再除以 8 取整
    return Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
  }

  /** 选一个能装下这组字节的最小版本。 */
  function pickVersion(byteLength, ecl) {
    for (var v = 1; v <= MAX_VERSION; v += 1) {
      if (dataCapacity(v, ecl) >= byteLength) return v;
    }
    return 0;
  }

  /** 编码成数据码字数组。 */
  function encodeData(bytes, version, ecl) {
    var cfg = EC_TABLE[ecl][version - 1];
    var dataCodewords = cfg[1] * cfg[2] + cfg[3] * cfg[4];
    var buffer = new BitBuffer();

    buffer.put(0x04, 4);                       // byte 模式
    buffer.put(bytes.length, version < 10 ? 8 : 16);
    buffer.putBytes(bytes);

    // 终止符 + 补齐到字节边界
    var capacityBits = dataCodewords * 8;
    for (var i = 0; i < 4 && buffer.bits.length < capacityBits; i += 1) buffer.bits.push(0);
    while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);

    // 填充码字 0xEC / 0x11 交替
    var pads = [0xec, 0x11];
    var padIndex = 0;
    while (buffer.bits.length < capacityBits) {
      buffer.put(pads[padIndex % 2], 8);
      padIndex += 1;
    }

    var codewords = [];
    for (var b = 0; b < buffer.bits.length; b += 8) {
      var value = 0;
      for (var k = 0; k < 8; k += 1) value = (value << 1) | buffer.bits[b + k];
      codewords.push(value);
    }
    return codewords;
  }

  /* ==========================================================
   * 4. 分块 + 纠错码字 + 交织
   * ========================================================== */

  function buildBlocks(codewords, version, ecl) {
    var cfg = EC_TABLE[ecl][version - 1];
    var ecLen = cfg[0];
    var generator = rsGeneratorPolynomial(ecLen);

    var blocks = [];
    var offset = 0;

    /** 切一个数据块并附它的纠错码字。 */
    function slice(count) {
      var data = codewords.slice(offset, offset + count);
      offset += count;
      return { data: data, ec: rsRemainder(data, generator) };
    }

    var i;
    for (i = 0; i < cfg[1]; i += 1) blocks.push(slice(cfg[2]));
    for (i = 0; i < cfg[3]; i += 1) blocks.push(slice(cfg[4]));

    // 交织：先按列取所有块的数据码字，再按列取纠错码字。
    // 这样突发的局部污损会被打散到不同的纠错块里，才救得回来。
    var result = [];
    var maxData = Math.max(cfg[2], cfg[4] || 0);
    for (var col = 0; col < maxData; col += 1) {
      for (var b = 0; b < blocks.length; b += 1) {
        if (col < blocks[b].data.length) result.push(blocks[b].data[col]);
      }
    }
    for (var e = 0; e < ecLen; e += 1) {
      for (var b2 = 0; b2 < blocks.length; b2 += 1) result.push(blocks[b2].ec[e]);
    }
    return result;
  }

  /* ==========================================================
   * 5. 矩阵构建
   * ========================================================== */

  function createMatrix(version) {
    var size = version * 4 + 17;
    var modules = [];
    for (var r = 0; r < size; r += 1) modules.push(new Array(size).fill(null));
    return { size: size, modules: modules, reserved: [] };
  }

  /** 功能图形占位用的预留表：null = 未占用，其余为模块值。 */
  function createReserved(size) {
    var reserved = [];
    for (var r = 0; r < size; r += 1) reserved.push(new Array(size).fill(false));
    return reserved;
  }

  function placeFinderPatterns(matrix, reserved, size) {
    [[0, 0], [size - 7, 0], [0, size - 7]].forEach(function (origin) {
      for (var dr = -1; dr <= 7; dr += 1) {
        for (var dc = -1; dc <= 7; dc += 1) {
          var r = origin[0] + dr;
          var c = origin[1] + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          var inRing = dr >= 0 && dr <= 6 && (dc === 0 || dc === 6);
          var inRow = dc >= 0 && dc <= 6 && (dr === 0 || dr === 6);
          var inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
          var dark = inRing || inRow || inCore;
          matrix[r][c] = dark;
          reserved[r][c] = true;
        }
      }
    });
  }

  function placeAlignmentPatterns(matrix, reserved, version) {
    var centers = ALIGNMENT_POSITIONS[version - 1];
    if (!centers.length) return;
    for (var i = 0; i < centers.length; i += 1) {
      for (var j = 0; j < centers.length; j += 1) {
        var row = centers[i];
        var col = centers[j];
        // 三个角上已有定位图案，跳过
        if (
          (row === 6 && col === 6)
          || (row === 6 && col === matrix.length - 7)
          || (row === matrix.length - 7 && col === 6)
        ) continue;
        for (var dr = -2; dr <= 2; dr += 1) {
          for (var dc = -2; dc <= 2; dc += 1) {
            var r = row + dr;
            var c = col + dc;
            var dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            matrix[r][c] = dark;
            reserved[r][c] = true;
          }
        }
      }
    }
  }

  function placeTimingPatterns(matrix, reserved, size) {
    for (var i = 8; i < size - 8; i += 1) {
      var dark = i % 2 === 0;
      if (matrix[6][i] === null) { matrix[6][i] = dark; reserved[6][i] = true; }
      if (matrix[i][6] === null) { matrix[i][6] = dark; reserved[i][6] = true; }
    }
  }

  /** 格式信息的 15 位 BCH 编码（5 位数据 + 10 位 BCH，再异或 0x5412）。 */
  function formatInfoBits(ecl, mask) {
    var data = (ECL_BITS[ecl] << 3) | mask;
    var value = data << 10;
    for (var i = 4; i >= 0; i -= 1) {
      if ((value >> (i + 10)) & 1) {
        value ^= 0x537 << i; // 生成多项式 0b10100110111
      }
    }
    return ((data << 10) | value) ^ 0x5412;
  }

  function placeFormatInfo(matrix, reserved, size, ecl, mask) {
    var bits = formatInfoBits(ecl, mask);
    // 两份副本：一份绕左上，一份分置右上与左下 —— 任一处污损都还有备份
    for (var i = 0; i < 15; i += 1) {
      var bit = ((bits >> i) & 1) === 1;

      // 副本 1（左上角）
      if (i < 6) matrix[i][8] = bit;
      else if (i === 6) matrix[7][8] = bit;
      else if (i === 7) matrix[8][8] = bit;
      else if (i === 8) matrix[8][7] = bit;
      else matrix[8][14 - i] = bit;

      // 副本 2
      if (i < 8) matrix[8][size - 1 - i] = bit;
      else matrix[size - 15 + i][8] = bit;
    }
    // dark module：规范固定为 1
    matrix[size - 8][8] = true;
  }

  /** 版本信息（仅版本 ≥ 7）：18 位 BCH。 */
  function placeVersionInfo(matrix, reserved, version) {
    if (version < 7) return;
    var bits = version << 12;
    for (var i = 5; i >= 0; i -= 1) {
      if ((bits >> (i + 12)) & 1) bits ^= 0x1f25 << i; // 生成多项式 0b1111100100101
    }
    var value = (version << 12) | bits;

    for (var k = 0; k < 18; k += 1) {
      var bit = ((value >> k) & 1) === 1;
      var r = Math.floor(k / 3);
      var c = k % 3;
      matrix[r][matrix.length - 11 + c] = bit;      // 右上
      matrix[matrix.length - 11 + c][r] = bit;      // 左下
    }
    for (var rr = 0; rr < 6; rr += 1) {
      for (var cc = 0; cc < 3; cc += 1) {
        reserved[rr][matrix.length - 11 + cc] = true;
        reserved[matrix.length - 11 + cc][rr] = true;
      }
    }
  }

  /** 按规范的两列一组、上下往复的锯齿路径填数据位。 */
  function placeData(matrix, reserved, size, codewords) {
    var bitIndex = 0;
    var totalBits = codewords.length * 8;

    for (var right = size - 1; right >= 1; right -= 2) {
      // 第 6 列是竖直定时图案，永远跳过
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert += 1) {
        for (var j = 0; j < 2; j += 1) {
          var col = right - j;
          var upward = ((right + 1) & 2) === 0;
          var row = upward ? size - 1 - vert : vert;
          if (reserved[row][col] || matrix[row][col] !== null) continue;
          var bit = false;
          if (bitIndex < totalBits) {
            bit = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
            bitIndex += 1;
          }
          matrix[row][col] = bit;
        }
      }
    }
  }

  /* ==========================================================
   * 6. 掩码与惩罚评分
   * ========================================================== */

  var MASK_FNS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
    function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; },
  ];

  function applyMask(matrix, reserved, size, mask) {
    var fn = MASK_FNS[mask];
    for (var r = 0; r < size; r += 1) {
      for (var c = 0; c < size; c += 1) {
        if (!reserved[r][c] && fn(r, c)) matrix[r][c] = !matrix[r][c];
      }
    }
  }

  /**
   * 惩罚分：四条规则之和，越低越好。
   * 目的只有一个 —— 避免出现会被扫描器误判为定位图案的规则色块。
   */
  function penaltyScore(matrix, size) {
    var score = 0;
    var r, c, run, dark;

    // 规则 1：同色连续 ≥ 5，超出部分每个 +3
    function scanLine(getCell, length) {
      var s = 0;
      var runColor = null;
      var runLength = 0;
      for (var i = 0; i < length; i += 1) {
        var value = getCell(i);
        if (value === runColor) {
          runLength += 1;
        } else {
          if (runLength >= 5) s += 3 + (runLength - 5);
          runColor = value;
          runLength = 1;
        }
      }
      if (runLength >= 5) s += 3 + (runLength - 5);
      return s;
    }
    for (r = 0; r < size; r += 1) {
      score += scanLine(function (i) { return matrix[r][i]; }, size);
      score += scanLine(function (i) { return matrix[i][r]; }, size);
    }

    // 规则 2：2×2 同色块，每块 +3
    for (r = 0; r < size - 1; r += 1) {
      for (c = 0; c < size - 1; c += 1) {
        dark = matrix[r][c];
        if (dark === matrix[r][c + 1] && dark === matrix[r + 1][c] && dark === matrix[r + 1][c + 1]) {
          score += 3;
        }
      }
    }

    // 规则 3：出现 1:1:3:1:1 且前后各 4 个浅色模块的图形，每次 +40
    var PATTERN = [true, false, true, true, true, false, true];
    function hasPatternAt(row, col, horizontal) {
      for (var i = 0; i < 7; i += 1) {
        var rr = horizontal ? row : row + i;
        var cc = horizontal ? col + i : col;
        if (rr >= size || cc >= size || matrix[rr][cc] !== PATTERN[i]) return false;
      }
      // 前后各 4 个模块（越界按浅色处理）
      var before = 0;
      for (var b = 1; b <= 4; b += 1) {
        var br = horizontal ? row : row - b;
        var bc = horizontal ? col - b : col;
        if (br < 0 || bc < 0) break;
        if (matrix[br][bc]) break;
        before += 1;
      }
      var after = 0;
      for (var a = 1; a <= 4; a += 1) {
        var ar = horizontal ? row : row + 7 + a - 1;
        var ac = horizontal ? col + 7 + a - 1 : col;
        if (ar >= size || ac >= size) break;
        if (matrix[ar][ac]) break;
        after += 1;
      }
      return (before >= 4 || before + (horizontal ? col : row) < 4) && after >= 4;
    }
    for (r = 0; r < size; r += 1) {
      for (c = 0; c < size; c += 1) {
        if (hasPatternAt(r, c, true)) score += 40;
        if (hasPatternAt(r, c, false)) score += 40;
      }
    }

    // 规则 4：深色模块占比偏离 50% 的程度，每 5% +10
    var darkCount = 0;
    for (r = 0; r < size; r += 1) {
      for (c = 0; c < size; c += 1) if (matrix[r][c]) darkCount += 1;
    }
    var percent = (darkCount * 100) / (size * size);
    score += Math.floor(Math.abs(percent - 50) / 5) * 10;

    return score;
  }

  /* ==========================================================
   * 7. 对外 API
   * ========================================================== */

  /**
   * 生成二维码矩阵。
   *
   * @param {string} text - 待编码文本（URL / 任意 UTF-8 文本）。
   * @param {{ecl?: 'L'|'M'|'Q'|'H'}} [options]
   * @returns {{size: number, version: number, ecl: string, modules: boolean[][]}}
   * @throws 文本超出版本 10 的容量时抛错 —— 与其给一个扫不出的码，不如报错。
   */
  function matrix(text, options) {
    var opts = options || {};
    var ecl = EC_TABLE[opts.ecl] ? opts.ecl : 'M';
    var bytes = utf8Bytes(String(text == null ? '' : text));
    var version = pickVersion(bytes.length, ecl);
    if (!version) {
      throw new Error('QRCode: 内容过长（超过版本 ' + MAX_VERSION + ' 在 ' + ecl + ' 级别下的容量）。');
    }

    var codewords = encodeData(bytes, version, ecl);
    var interleaved = buildBlocks(codewords, version, ecl);

    var m = createMatrix(version);
    var reserved = createReserved(m.size);

    placeFinderPatterns(m.modules, reserved, m.size);
    placeAlignmentPatterns(m.modules, reserved, version);
    placeTimingPatterns(m.modules, reserved, m.size);
    // 格式信息区与版本信息区先占好位置，数据填充时才不会覆盖它们
    reserveFormatAreas(reserved, m.size, version);
    placeVersionInfo(m.modules, reserved, version);

    placeData(m.modules, reserved, m.size, interleaved);

    // 八种掩码各算一次，取惩罚分最低者
    var best = null;
    var bestScore = Infinity;
    for (var mask = 0; mask < 8; mask += 1) {
      var candidate = m.modules.map(function (row) { return row.slice(); });
      var candidateReserved = reserved.map(function (row) { return row.slice(); });
      applyMask(candidate, candidateReserved, m.size, mask);
      placeFormatInfo(candidate, candidateReserved, m.size, ecl, mask);
      var score = penaltyScore(candidate, m.size);
      if (score < bestScore) {
        bestScore = score;
        best = { modules: candidate, mask: mask };
      }
    }

    return { size: m.size, version: version, ecl: ecl, mask: best.mask, modules: best.modules };
  }

  /**
   * 预留格式信息（与版本信息）占用的格子。
   *
   * ⚠️ 只能精确标记规范里那 31 个格子。第 8 行 / 第 8 列的**其余部分是
   * 数据区** —— 早先这里图省事把整行整列都标记成保留，结果数据位绕开了
   * 它们，出来的码整体错位（与参考实现逐位比对时 100+ 个格子不同）。
   */
  function reserveFormatAreas(reserved, size, version) {
    var i;
    // 第一副本：竖直段 col=8 的 row 0..5 / 7 / 8，水平段 row=8 的 col 7 / 8 / 5..0
    for (i = 0; i <= 5; i += 1) reserved[i][8] = true;
    reserved[7][8] = true;
    reserved[8][8] = true;
    reserved[8][7] = true;
    for (i = 9; i < 15; i += 1) reserved[8][14 - i] = true;

    // 第二副本：水平段 row=8 的 col size-1..size-8，竖直段 col=8 的 row size-7..size-1
    for (i = 0; i < 8; i += 1) reserved[8][size - 1 - i] = true;
    for (i = 8; i < 15; i += 1) reserved[size - 15 + i][8] = true;

    // dark module：规范规定恒为深色
    reserved[size - 8][8] = true;
    if (version >= 7) {
      for (var r = 0; r < 6; r += 1) {
        for (var c = 0; c < 3; c += 1) {
          reserved[r][size - 11 + c] = true;
          reserved[size - 11 + c][r] = true;
        }
      }
    }
  }

  /**
   * 渲染成 SVG 字符串。
   *
   * 用 `currentColor` 作默认前景色：二维码要同时出现在浅色弹窗与深色
   * 分享页里，跟着 CSS 的 color 走就不用为两套主题各传一次颜色。
   *
   * @param {string} text
   * @param {{ecl?: string, margin?: number, size?: number, dark?: string,
   *          light?: string, title?: string}} [options]
   * @returns {string} 可直接 innerHTML 的 `<svg>` 片段。
   */
  function toSvg(text, options) {
    var opts = options || {};
    var m = matrix(text, { ecl: opts.ecl });
    var margin = opts.margin == null ? 2 : Number(opts.margin);
    var total = m.size + margin * 2;
    var scale = Number(opts.size) || 0; // 0 = 只用 viewBox，由 CSS 决定尺寸
    var dark = opts.dark || 'currentColor';
    var light = opts.light || 'transparent';

    var path = [];
    for (var r = 0; r < m.size; r += 1) {
      for (var c = 0; c < m.size; c += 1) {
        if (m.modules[r][c]) path.push('M' + (c + margin) + ' ' + (r + margin) + 'h1v1h-1z');
      }
    }

    var attrs = [
      'xmlns="http://www.w3.org/2000/svg"',
      'viewBox="0 0 ' + total + ' ' + total + '"',
      'shape-rendering="crispEdges"',
      'role="img"',
      'aria-label="' + escapeAttr(opts.title || text) + '"',
    ];
    if (scale) {
      attrs.push('width="' + scale * total + '"');
      attrs.push('height="' + scale * total + '"');
    }

    var background = light === 'transparent'
      ? ''
      : '<rect width="' + total + '" height="' + total + '" fill="' + light + '"/>';

    return '<svg ' + attrs.join(' ') + '>' + background
      + '<path d="' + path.join('') + '" fill="' + dark + '"/></svg>';
  }

  function escapeAttr(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** 把二维码塞进一个容器元素（innerHTML 一个 SVG）。 */
  function renderTo(element, text, options) {
    if (!element) return null;
    element.innerHTML = toSvg(text, options);
    return element;
  }

  var QRCode = {
    matrix: matrix,
    toSvg: toSvg,
    renderTo: renderTo,
    /** 指定内容在指定纠错级别下能否编码（超长时前端可改降级为不显示）。 */
    canEncode: function (text, ecl) {
      try {
        return pickVersion(utf8Bytes(String(text == null ? '' : text)).length, ecl || 'M') > 0;
      } catch (e) {
        return false;
      }
    },
    MAX_VERSION: MAX_VERSION,
  };

  if (typeof module === 'object' && module.exports) module.exports = QRCode;
  global.QRCode = QRCode;
})(typeof window !== 'undefined' ? window : globalThis);
