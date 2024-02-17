# Picto Box
TypeScript library for interacting with several different image types used by the Wii U and 3DS.

## Installation
```
npm i @pretendonetwork/pictobox
```

## Supported files
- [x] BMP
- [x] TGA
- [x] PNG
- [ ] ETC1A4. Nintendo variant of [ETC1](https://registry.khronos.org/DataFormat/specs/1.1/dataformat.1.1.html#ETC1) with added alpha data. (Can decode but not encode)
- [ ] [Indexed images](https://github.com/PretendoNetwork/indexed-image-converter)

## Example
```ts
import fs from 'node:fs';
import BMP from '@pretendonetwork/pictobox/bmp';

const buffer = fs.readFileSync('image.bmp');
const bmp = new BMP();

bmp.parseFromBuffer(buffer);

const encoded = bmp.encode();

fs.writeFileSync('./image-2.bmp', encoded);
```