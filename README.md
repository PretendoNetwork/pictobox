# Picto Box
TypeScript library for interacting with several different image types used by the Wii U and 3DS.

## Installation
```
npm i @pretendonetwork/pictobox
```

## Supported files
- [x] BMP
- [ ] TGA
- [ ] PNG
- [ ] ETC1
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