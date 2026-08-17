import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source = fs.readFileSync(new URL('../shared/core.js', import.meta.url), 'utf8');
vm.runInThisContext(source);
const core = globalThis.CanvoraCore;

assert.deepEqual(core.parsePageRange('', 5), [1,2,3,4,5]);
assert.deepEqual(core.parsePageRange('1-3,5', 6), [1,2,3,5]);
assert.deepEqual(core.parsePageRange('3-', 5), [3,4,5]);
assert.deepEqual(core.parsePageRange('-2', 5), [1,2]);
assert.equal(core.sanitizeFilename('A:B/C*D?.pdf'), 'A-B-C-D-.pdf');

const jpg = 'data:image/jpeg;base64,/9j/2Q==';
const pdf = await core.makePdfFromImages([{dataUrl:jpg,width:10,height:20}], {sizeMode:'source'});
assert.equal(pdf.type, 'application/pdf');
assert.ok(pdf.size > 100);
const pdfText = new TextDecoder('latin1').decode(new Uint8Array(await pdf.arrayBuffer()));
assert.ok(pdfText.includes('/MediaBox [0 0 7.5 15]'), 'source PDF must use jsPDF px_scaling parity (0.75 pt/px)');


const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGUlEQVR4nAXBAQ0AAAjAINwsbvILImlH4h4/gAaBNbRWFQAAAABJRU5ErkJggg==';
const losslessPdf = await core.makePdfFromImages([{dataUrl:png,width:2,height:2}], {sizeMode:'source'});
assert.equal(losslessPdf.type, 'application/pdf');
const losslessText = new TextDecoder('latin1').decode(new Uint8Array(await losslessPdf.arrayBuffer()));
assert.ok(losslessText.includes('/FlateDecode'));
assert.ok(losslessText.startsWith('%PDF-1.4'));

const zip = core.makeStoreZip([{name:'hello.txt',bytes:new TextEncoder().encode('hello')}]);
assert.equal(zip.type, 'application/zip');
assert.ok(zip.size > 100);

console.log('Canvora core tests passed');
