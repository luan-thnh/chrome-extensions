/*
 * QR Link Hunter local QR decoder
 * --------------------------------
 * A small, dependency-free QR Model 2 decoder for clean/static webpage images.
 * It deliberately avoids BarcodeDetector so the extension works consistently
 * across Chromium builds on Windows, macOS and Linux.
 *
 * Scope: QR Model 2 versions 1..40, numeric/alphanumeric/byte/ECI segments.
 * The decoder de-interleaves QR data blocks and is optimized for normal QR
 * images rendered in <img>/<canvas>. Native BarcodeDetector remains the fast
 * path when available; this file is the portable fallback.
 */
(() => {
  'use strict';

  const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

  // QR Model 2 block constants. Table order: Low, Medium, Quartile, High.
  const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];

  const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];

  // 2 format bits -> table index. QR format-bit values are L=1, M=0, Q=3, H=2.
  const FORMAT_ECL_TO_TABLE = { 0: 1, 1: 0, 2: 3, 3: 2 };

  function decode(imageData, width = imageData?.width, height = imageData?.height) {
    if (!imageData?.data || !Number.isFinite(width) || !Number.isFinite(height)) return null;
    if (width < 21 || height < 21) return null;

    const binary = binarize(imageData.data, width, height);
    if (!binary) return null;

    const bbox = findDarkBoundingBox(binary, width, height);
    if (!bbox) return null;

    const aspect = bbox.width / bbox.height;
    if (aspect < 0.72 || aspect > 1.38) return null;

    const candidates = [];
    for (let version = 1; version <= 40; version += 1) {
      const size = 17 + version * 4;
      const matrix = sampleMatrix(binary, width, height, bbox, size);

      let rotated = matrix;
      for (let rotation = 0; rotation < 4; rotation += 1) {
        const score = scoreStructure(rotated);
        if (score >= 0.72) {
          candidates.push({ version, matrix: rotated, score, rotation });
        }
        rotated = rotateClockwise(rotated);
      }
    }

    candidates.sort((a, b) => b.score - a.score);

    for (const candidate of candidates.slice(0, 12)) {
      const result = decodeMatrix(candidate.matrix, candidate.version);
      if (result?.data) {
        return {
          ...result,
          score: candidate.score,
          rotation: candidate.rotation,
        };
      }
    }

    return null;
  }

  function binarize(rgba, width, height) {
    const pixelCount = width * height;
    if (rgba.length < pixelCount * 4) return null;

    const gray = new Uint8Array(pixelCount);
    const histogram = new Uint32Array(256);

    for (let i = 0, p = 0; p < pixelCount; p += 1, i += 4) {
      const alpha = rgba[i + 3] / 255;
      const r = rgba[i] * alpha + 255 * (1 - alpha);
      const g = rgba[i + 1] * alpha + 255 * (1 - alpha);
      const b = rgba[i + 2] * alpha + 255 * (1 - alpha);
      const value = Math.max(0, Math.min(255, Math.round(r * 0.299 + g * 0.587 + b * 0.114)));
      gray[p] = value;
      histogram[value] += 1;
    }

    const threshold = otsuThreshold(histogram, pixelCount);
    const binary = new Uint8Array(pixelCount);
    let darkCount = 0;

    for (let i = 0; i < pixelCount; i += 1) {
      const dark = gray[i] <= threshold ? 1 : 0;
      binary[i] = dark;
      darkCount += dark;
    }

    const ratio = darkCount / pixelCount;
    if (ratio < 0.01 || ratio > 0.85) return null;
    return binary;
  }

  function otsuThreshold(histogram, total) {
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * histogram[i];

    let sumBackground = 0;
    let weightBackground = 0;
    let maxVariance = -1;
    let threshold = 127;

    for (let i = 0; i < 256; i += 1) {
      weightBackground += histogram[i];
      if (!weightBackground) continue;

      const weightForeground = total - weightBackground;
      if (!weightForeground) break;

      sumBackground += i * histogram[i];
      const meanBackground = sumBackground / weightBackground;
      const meanForeground = (sum - sumBackground) / weightForeground;
      const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;

      if (variance > maxVariance) {
        maxVariance = variance;
        threshold = i;
      }
    }

    // Avoid a pathological threshold of 0 on anti-aliased black/white images.
    return Math.max(16, Math.min(239, threshold));
  }

  function findDarkBoundingBox(binary, width, height) {
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        if (!binary[row + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    if (maxX < minX || maxY < minY) return null;
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    if (boxWidth < 21 || boxHeight < 21) return null;

    return { minX, minY, maxX, maxY, width: boxWidth, height: boxHeight };
  }

  function sampleMatrix(binary, imageWidth, imageHeight, bbox, size) {
    const matrix = Array.from({ length: size }, () => new Uint8Array(size));
    const stepX = bbox.width / size;
    const stepY = bbox.height / size;

    for (let y = 0; y < size; y += 1) {
      // Use a tiny 3x3 vote around the nominal module center. This makes resized
      // webpage QR images considerably less sensitive to anti-aliasing.
      const centerY = bbox.minY + (y + 0.5) * stepY;
      for (let x = 0; x < size; x += 1) {
        const centerX = bbox.minX + (x + 0.5) * stepX;
        let votes = 0;
        let samples = 0;
        const radiusX = Math.min(0.22 * stepX, 1.25);
        const radiusY = Math.min(0.22 * stepY, 1.25);

        for (const dy of [-radiusY, 0, radiusY]) {
          for (const dx of [-radiusX, 0, radiusX]) {
            const px = Math.max(0, Math.min(imageWidth - 1, Math.round(centerX + dx)));
            const py = Math.max(0, Math.min(imageHeight - 1, Math.round(centerY + dy)));
            votes += binary[py * imageWidth + px];
            samples += 1;
          }
        }

        matrix[y][x] = votes * 2 >= samples ? 1 : 0;
      }
    }

    return matrix;
  }

  function rotateClockwise(matrix) {
    const size = matrix.length;
    const out = Array.from({ length: size }, () => new Uint8Array(size));
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        out[y][x] = matrix[size - 1 - x][y];
      }
    }
    return out;
  }

  function scoreStructure(matrix) {
    const size = matrix.length;
    let matches = 0;
    let total = 0;

    const scoreFinder = (startX, startY) => {
      for (let y = 0; y < 7; y += 1) {
        for (let x = 0; x < 7; x += 1) {
          const dist = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          const expected = dist === 2 ? 0 : 1;
          matches += matrix[startY + y][startX + x] === expected ? 1 : 0;
          total += 1;
        }
      }
    };

    scoreFinder(0, 0);
    scoreFinder(size - 7, 0);
    scoreFinder(0, size - 7);

    // Separators around the three finders.
    for (let i = 0; i < 8; i += 1) {
      if (i < size) {
        const separators = [
          [7, i], [i, 7],
          [size - 8, i], [size - 1 - i, 7],
          [7, size - 1 - i], [i, size - 8],
        ];
        for (const [x, y] of separators) {
          if (x >= 0 && y >= 0 && x < size && y < size) {
            matches += matrix[y][x] === 0 ? 1 : 0;
            total += 1;
          }
        }
      }
    }

    // Timing patterns.
    for (let i = 8; i < size - 8; i += 1) {
      const expected = i % 2 === 0 ? 1 : 0;
      matches += matrix[6][i] === expected ? 1 : 0;
      matches += matrix[i][6] === expected ? 1 : 0;
      total += 2;
    }

    // Fixed dark module.
    matches += matrix[size - 8][8] === 1 ? 2 : 0;
    total += 2;

    return total ? matches / total : 0;
  }

  function decodeMatrix(matrix, version) {
    const size = matrix.length;
    if (size !== 17 + version * 4) return null;

    const format = readFormatInformation(matrix);
    if (!format) return null;

    const functionMask = buildFunctionMask(version, size);
    const rawBits = [];

    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;

      for (let vertical = 0; vertical < size; vertical += 1) {
        const y = upward ? size - 1 - vertical : vertical;
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          if (functionMask[y][x]) continue;
          let bit = matrix[y][x];
          if (maskApplies(format.mask, x, y)) bit ^= 1;
          rawBits.push(bit);
        }
      }

      upward = !upward;
    }

    const expectedRawModules = getNumRawDataModules(version);
    if (rawBits.length < Math.floor(expectedRawModules / 8) * 8) return null;

    const rawCodewords = Math.floor(expectedRawModules / 8);
    const codewords = new Uint8Array(rawCodewords);
    for (let i = 0; i < rawCodewords; i += 1) {
      let value = 0;
      for (let b = 0; b < 8; b += 1) value = (value << 1) | rawBits[i * 8 + b];
      codewords[i] = value;
    }

    const dataBytes = deinterleaveData(codewords, version, format.eclTableIndex);
    if (!dataBytes) return null;

    const data = parseSegments(dataBytes, version);
    if (!data) return null;

    return {
      data,
      version,
      mask: format.mask,
      errorCorrection: ['L', 'M', 'Q', 'H'][format.eclTableIndex],
    };
  }

  function readFormatInformation(matrix) {
    const size = matrix.length;
    let observedA = 0;
    let observedB = 0;

    const setA = (index, x, y) => {
      if (matrix[y][x]) observedA |= 1 << index;
    };
    const setB = (index, x, y) => {
      if (matrix[y][x]) observedB |= 1 << index;
    };

    for (let i = 0; i <= 5; i += 1) setA(i, 8, i);
    setA(6, 8, 7);
    setA(7, 8, 8);
    setA(8, 7, 8);
    for (let i = 9; i < 15; i += 1) setA(i, 14 - i, 8);

    for (let i = 0; i < 8; i += 1) setB(i, size - 1 - i, 8);
    for (let i = 8; i < 15; i += 1) setB(i, 8, size - 15 + i);

    let best = null;
    for (let data = 0; data < 32; data += 1) {
      const expected = makeFormatBits(data);
      const distanceA = hammingDistance15(observedA, expected);
      const distanceB = hammingDistance15(observedB, expected);
      const distance = Math.min(distanceA, distanceB);
      if (!best || distance < best.distance) {
        const eclBits = (data >>> 3) & 0b11;
        best = {
          distance,
          mask: data & 0b111,
          eclTableIndex: FORMAT_ECL_TO_TABLE[eclBits],
        };
      }
    }

    return best && best.distance <= 3 ? best : null;
  }

  function makeFormatBits(data) {
    let remainder = data;
    for (let i = 0; i < 10; i += 1) {
      remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) ? 0x537 : 0);
    }
    return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
  }

  function hammingDistance15(a, b) {
    let value = (a ^ b) & 0x7fff;
    let count = 0;
    while (value) {
      value &= value - 1;
      count += 1;
    }
    return count;
  }

  function buildFunctionMask(version, size) {
    const mask = Array.from({ length: size }, () => new Uint8Array(size));
    const mark = (x, y) => {
      if (x >= 0 && y >= 0 && x < size && y < size) mask[y][x] = 1;
    };

    // Timing patterns are drawn before finder patterns in the QR spec.
    for (let i = 0; i < size; i += 1) {
      mark(6, i);
      mark(i, 6);
    }

    const markFinder = (centerX, centerY) => {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) mark(centerX + dx, centerY + dy);
      }
    };

    markFinder(3, 3);
    markFinder(size - 4, 3);
    markFinder(3, size - 4);

    const align = getAlignmentPatternPositions(version, size);
    const last = align.length - 1;
    for (let i = 0; i < align.length; i += 1) {
      for (let j = 0; j < align.length; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
        const cx = align[i];
        const cy = align[j];
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) mark(cx + dx, cy + dy);
        }
      }
    }

    // Two copies of the 15 format bits.
    for (let i = 0; i <= 5; i += 1) mark(8, i);
    mark(8, 7);
    mark(8, 8);
    mark(7, 8);
    for (let i = 9; i < 15; i += 1) mark(14 - i, 8);
    for (let i = 0; i < 8; i += 1) mark(size - 1 - i, 8);
    for (let i = 8; i < 15; i += 1) mark(8, size - 15 + i);
    mark(8, size - 8); // Fixed dark module.

    // Version information for versions 7+.
    if (version >= 7) {
      for (let i = 0; i < 18; i += 1) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        mark(a, b);
        mark(b, a);
      }
    }

    return mask;
  }

  function getAlignmentPatternPositions(version, size) {
    if (version === 1) return [];
    const numAlign = Math.floor(version / 7) + 2;
    const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    const tail = [];
    for (let i = 0, pos = size - 7; i < numAlign - 1; i += 1, pos -= step) tail.unshift(pos);
    return result.concat(tail);
  }

  function maskApplies(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0;
      case 7: return ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0;
      default: return false;
    }
  }

  function getNumRawDataModules(version) {
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const numAlign = Math.floor(version / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  // QR uses Reed-Solomon over GF(256) with primitive polynomial 0x11D.
  // The first portable decoder version only de-interleaved data bytes, which
  // meant a slightly imperfect sample could turn a valid URL into characters
  // such as "`ttps://...". Correcting each RS block before parsing payload bytes
  // makes the fallback decoder behave much closer to native QR readers.
  const GF_EXP = new Uint16Array(512);
  const GF_LOG = new Int16Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < GF_EXP.length; i += 1) GF_EXP[i] = GF_EXP[i - 255];
    GF_LOG[0] = -1;
  })();

  function gfMultiply(a, b) {
    if (!a || !b) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function gfDivide(a, b) {
    if (!b) throw new Error('GF division by zero.');
    if (!a) return 0;
    let exponent = GF_LOG[a] - GF_LOG[b];
    if (exponent < 0) exponent += 255;
    return GF_EXP[exponent];
  }

  function gfPowAlpha(exponent) {
    let value = exponent % 255;
    if (value < 0) value += 255;
    return GF_EXP[value];
  }

  function evaluatePolynomial(coefficients, x) {
    // Coefficients are stored from highest degree to constant term.
    let result = 0;
    for (const coefficient of coefficients) result = gfMultiply(result, x) ^ coefficient;
    return result;
  }

  function computeSyndromes(received, eccLength) {
    const syndromes = new Uint8Array(eccLength);
    let hasError = false;
    for (let i = 0; i < eccLength; i += 1) {
      const syndrome = evaluatePolynomial(received, gfPowAlpha(i));
      syndromes[i] = syndrome;
      if (syndrome !== 0) hasError = true;
    }
    return { syndromes, hasError };
  }

  function findErrorLocator(syndromes, eccLength) {
    // Berlekamp-Massey on S0..S(n-1). Polynomials here are stored in
    // ascending order: C[0] + C[1]z + ...
    const c = new Uint8Array(eccLength + 1);
    const b = new Uint8Array(eccLength + 1);
    c[0] = 1;
    b[0] = 1;

    let locatorDegree = 0;
    let shift = 1;
    let previousDiscrepancy = 1;

    for (let n = 0; n < eccLength; n += 1) {
      let discrepancy = syndromes[n];
      for (let i = 1; i <= locatorDegree; i += 1) {
        discrepancy ^= gfMultiply(c[i], syndromes[n - i]);
      }

      if (discrepancy === 0) {
        shift += 1;
        continue;
      }

      const previousC = c.slice();
      const scale = gfDivide(discrepancy, previousDiscrepancy);
      for (let i = 0; i + shift < c.length; i += 1) {
        if (b[i]) c[i + shift] ^= gfMultiply(scale, b[i]);
      }

      if (2 * locatorDegree <= n) {
        locatorDegree = n + 1 - locatorDegree;
        b.set(previousC);
        previousDiscrepancy = discrepancy;
        shift = 1;
      } else {
        shift += 1;
      }
    }

    if (locatorDegree < 1 || locatorDegree > Math.floor(eccLength / 2)) return null;
    return { coefficients: c.slice(0, locatorDegree + 1), degree: locatorDegree };
  }

  function evaluateAscendingPolynomial(coefficients, x) {
    let result = 0;
    let power = 1;
    for (const coefficient of coefficients) {
      if (coefficient) result ^= gfMultiply(coefficient, power);
      power = gfMultiply(power, x);
    }
    return result;
  }

  function findErrorPositions(locator, messageLength) {
    const positions = [];
    const xValues = [];

    // A symbol at array index i is the coefficient of x^(messageLength-1-i).
    // Locator roots are alpha^(-degree).
    for (let degree = 0; degree < messageLength; degree += 1) {
      const rootCandidate = gfPowAlpha(-degree);
      if (evaluateAscendingPolynomial(locator.coefficients, rootCandidate) === 0) {
        positions.push(messageLength - 1 - degree);
        xValues.push(gfPowAlpha(degree));
      }
    }

    if (positions.length !== locator.degree) return null;
    return { positions, xValues };
  }

  function solveErrorMagnitudes(syndromes, xValues) {
    const count = xValues.length;
    const matrix = Array.from({ length: count }, () => new Uint8Array(count + 1));

    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        matrix[row][col] = row === 0 ? 1 : gfPowElement(xValues[col], row);
      }
      matrix[row][count] = syndromes[row];
    }

    // Gaussian elimination in GF(256).
    for (let col = 0; col < count; col += 1) {
      let pivot = col;
      while (pivot < count && matrix[pivot][col] === 0) pivot += 1;
      if (pivot === count) return null;

      if (pivot !== col) {
        const temp = matrix[col];
        matrix[col] = matrix[pivot];
        matrix[pivot] = temp;
      }

      const pivotValue = matrix[col][col];
      if (pivotValue !== 1) {
        const inverse = gfDivide(1, pivotValue);
        for (let j = col; j <= count; j += 1) matrix[col][j] = gfMultiply(matrix[col][j], inverse);
      }

      for (let row = 0; row < count; row += 1) {
        if (row === col) continue;
        const factor = matrix[row][col];
        if (!factor) continue;
        for (let j = col; j <= count; j += 1) matrix[row][j] ^= gfMultiply(factor, matrix[col][j]);
      }
    }

    return Uint8Array.from(matrix.map((row) => row[count]));
  }

  function gfPowElement(value, exponent) {
    if (exponent === 0) return 1;
    if (value === 0) return 0;
    return gfPowAlpha(GF_LOG[value] * exponent);
  }

  function correctReedSolomonBlock(block, eccLength) {
    const working = Uint8Array.from(block);
    const initial = computeSyndromes(working, eccLength);
    if (!initial.hasError) return working;

    const locator = findErrorLocator(initial.syndromes, eccLength);
    if (!locator) return null;

    const found = findErrorPositions(locator, working.length);
    if (!found) return null;

    const magnitudes = solveErrorMagnitudes(initial.syndromes, found.xValues);
    if (!magnitudes) return null;

    for (let i = 0; i < found.positions.length; i += 1) {
      const position = found.positions[i];
      if (position < 0 || position >= working.length) return null;
      working[position] ^= magnitudes[i];
    }

    return computeSyndromes(working, eccLength).hasError ? null : working;
  }

  function deinterleaveData(codewords, version, eclTableIndex) {
    const eccLen = ECC_CODEWORDS_PER_BLOCK[eclTableIndex]?.[version];
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[eclTableIndex]?.[version];
    if (!eccLen || !numBlocks || eccLen < 0 || numBlocks < 1) return null;

    const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
    if (codewords.length < rawCodewords) return null;

    const dataCodewords = rawCodewords - eccLen * numBlocks;
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortDataLen = shortBlockLen - eccLen;
    if (dataCodewords <= 0 || shortDataLen < 0) return null;

    const dataLengths = Array.from(
      { length: numBlocks },
      (_, block) => shortDataLen + (block < numShortBlocks ? 0 : 1)
    );
    const blocks = dataLengths.map((dataLength) => new Uint8Array(dataLength + eccLen));
    let index = 0;
    const maxDataLength = Math.max(...dataLengths);

    // QR interleaves all data columns first, skipping short blocks when needed.
    for (let column = 0; column < maxDataLength; column += 1) {
      for (let block = 0; block < numBlocks; block += 1) {
        if (column >= dataLengths[block]) continue;
        if (index >= rawCodewords) return null;
        blocks[block][column] = codewords[index++];
      }
    }

    // ECC bytes are then interleaved one column at a time across every block.
    for (let column = 0; column < eccLen; column += 1) {
      for (let block = 0; block < numBlocks; block += 1) {
        if (index >= rawCodewords) return null;
        blocks[block][dataLengths[block] + column] = codewords[index++];
      }
    }

    if (index !== rawCodewords) return null;

    const out = new Uint8Array(dataCodewords);
    let outIndex = 0;
    for (let block = 0; block < blocks.length; block += 1) {
      const corrected = correctReedSolomonBlock(blocks[block], eccLen);
      if (!corrected) return null;
      const dataLength = dataLengths[block];
      out.set(corrected.subarray(0, dataLength), outIndex);
      outIndex += dataLength;
    }

    return out;
  }

  class BitReader {
    constructor(bytes) {
      this.bytes = bytes;
      this.bitOffset = 0;
    }

    get remaining() {
      return this.bytes.length * 8 - this.bitOffset;
    }

    read(length) {
      if (length < 0 || this.remaining < length) return null;
      let value = 0;
      for (let i = 0; i < length; i += 1) {
        const byteIndex = this.bitOffset >>> 3;
        const bitInByte = 7 - (this.bitOffset & 7);
        value = value * 2 + ((this.bytes[byteIndex] >>> bitInByte) & 1);
        this.bitOffset += 1;
      }
      return value;
    }
  }

  function parseSegments(dataBytes, version) {
    const reader = new BitReader(dataBytes);
    const parts = [];
    let currentEncoding = 'utf-8';
    let safety = 0;

    while (reader.remaining >= 4 && safety++ < 128) {
      const mode = reader.read(4);
      if (mode === null || mode === 0) break;

      if (mode === 0x7) {
        const assignment = readEciAssignment(reader);
        if (assignment === null) return null;
        currentEncoding = eciToEncoding(assignment);
        continue;
      }

      if (mode === 0x1) {
        const countBits = version <= 9 ? 10 : version <= 26 ? 12 : 14;
        const count = reader.read(countBits);
        if (count === null) return null;
        const text = readNumeric(reader, count);
        if (text === null) return null;
        parts.push(text);
        continue;
      }

      if (mode === 0x2) {
        const countBits = version <= 9 ? 9 : version <= 26 ? 11 : 13;
        const count = reader.read(countBits);
        if (count === null) return null;
        const text = readAlphanumeric(reader, count);
        if (text === null) return null;
        parts.push(text);
        continue;
      }

      if (mode === 0x4) {
        const countBits = version <= 9 ? 8 : 16;
        const count = reader.read(countBits);
        if (count === null || count < 0 || reader.remaining < count * 8) return null;
        const bytes = new Uint8Array(count);
        for (let i = 0; i < count; i += 1) {
          const value = reader.read(8);
          if (value === null) return null;
          bytes[i] = value;
        }
        parts.push(decodeBytes(bytes, currentEncoding));
        continue;
      }

      // FNC1 first/second position: no payload, continue to the next segment.
      if (mode === 0x5 || mode === 0x9) continue;

      // Structured append or Kanji are uncommon for webpage URLs. Returning null
      // prevents a false positive rather than emitting corrupted text.
      return null;
    }

    const output = parts.join('').replace(/\u0000+$/g, '').trim();
    if (!output || output.length > 8192) return null;

    // Reject mostly-control-character garbage, which is a strong indication that
    // a wrong version/grid candidate happened to pass format checks by chance.
    let printable = 0;
    for (const ch of output) {
      const code = ch.codePointAt(0);
      if (code === 9 || code === 10 || code === 13 || code >= 32) printable += 1;
    }
    if (printable / Math.max(1, output.length) < 0.9) return null;

    return output;
  }

  function readNumeric(reader, count) {
    let out = '';
    let remaining = count;
    while (remaining >= 3) {
      const value = reader.read(10);
      if (value === null || value >= 1000) return null;
      out += String(value).padStart(3, '0');
      remaining -= 3;
    }
    if (remaining === 2) {
      const value = reader.read(7);
      if (value === null || value >= 100) return null;
      out += String(value).padStart(2, '0');
    } else if (remaining === 1) {
      const value = reader.read(4);
      if (value === null || value >= 10) return null;
      out += String(value);
    }
    return out;
  }

  function readAlphanumeric(reader, count) {
    let out = '';
    let remaining = count;
    while (remaining >= 2) {
      const value = reader.read(11);
      if (value === null) return null;
      const first = Math.floor(value / 45);
      const second = value % 45;
      if (first >= ALPHANUMERIC.length || second >= ALPHANUMERIC.length) return null;
      out += ALPHANUMERIC[first] + ALPHANUMERIC[second];
      remaining -= 2;
    }
    if (remaining === 1) {
      const value = reader.read(6);
      if (value === null || value >= ALPHANUMERIC.length) return null;
      out += ALPHANUMERIC[value];
    }
    return out;
  }

  function readEciAssignment(reader) {
    const first = reader.read(8);
    if (first === null) return null;
    if ((first & 0x80) === 0) return first & 0x7f;
    if ((first & 0xc0) === 0x80) {
      const second = reader.read(8);
      return second === null ? null : ((first & 0x3f) << 8) | second;
    }
    if ((first & 0xe0) === 0xc0) {
      const rest = reader.read(16);
      return rest === null ? null : ((first & 0x1f) << 16) | rest;
    }
    return null;
  }

  function eciToEncoding(assignment) {
    // Common QR ECI assignments used on the web.
    if (assignment === 26) return 'utf-8';
    if (assignment === 20) return 'shift_jis';
    if (assignment === 3) return 'iso-8859-1';
    return 'utf-8';
  }

  function decodeBytes(bytes, encoding) {
    try {
      return new TextDecoder(encoding, { fatal: false }).decode(bytes);
    } catch (_) {
      try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch (_) {
        let text = '';
        for (const value of bytes) text += String.fromCharCode(value);
        return text;
      }
    }
  }

  globalThis.QRLocalDecoder = Object.freeze({
    decode,
    version: '1.0.0',
  });
})();
