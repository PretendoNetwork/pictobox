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
- [x] RGB565A4. Nintendo variant of [RGB565](https://en.wikipedia.org/wiki/List_of_monochrome_and_RGB_color_formats#16-bit_RGB_.28also_known_as_RGB565.29) with added alpha data

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