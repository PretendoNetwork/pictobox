# Picto Box
TypeScript library for interacting with several different image types, including those exclusive to the Wii U and 3DS

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
// Convert an RGB565 (with alpha) image to a PNG

import fs from 'node:fs';
import RGB565A4 from '@pretendonetwork/pictobox/rgb565a4';
import PNG from '@pretendonetwork/pictobox/png';

const rgb565Data = fs.readFileSync('./badge.rgb565');
const rgb565Alpha = fs.readFileSync('./badge.a4');

const rgb565 = new RGB565A4();

rgb565.width = 64;
rgb565.height = 64;
rgb565.parseFromBuffer(rgb565Data, rgb565Alpha);

const png = new PNG();

png.width = rgb565.width;
png.height = rgb565.height;
png.pixels = rgb565.pixels;
png.bitDepth = PNG.BitDepths.Bits8;
png.colorType = PNG.ColorTypes.RGBA;
png.interlaceMethod = PNG.InterlaceMethods.None;

const pngEncoded = png.encode();

fs.writeFileSync('./badge.png', pngEncoded);
```