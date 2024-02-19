// * Based on:
// * - https://wikipedia.org/wiki/BMP_file_format
// * - https://www.ece.ualberta.ca/~elliott/ee552/studentAppNotes/2003_w/misc/bmp_file_format/bmp_file_format.htm
// * - https://paulbourke.net/dataformats/bmp

import StreamIn from '@/stream-in';
import StreamOut from '@/stream-out';

// TODO - TSDoc comments

type Pixel = {
	blue: number;
	green: number;
	red: number;
	quad: number; // * The BMP color palette is an array of RGBQUAD values, where the QUAD is reserved
};

export default class BMP {
	private readStream: StreamIn;
	private writeStream: StreamOut;

	private dataOffset: number;
	public width: number;
	public height: number;
	public planes: number;
	public infoHeaderType: number;
	public pixelDensity: number;
	public paletteColorCount: number;
	public compressionType: number;
	public compressedImageSize: number;
	public horizontalResolution: number;
	public verticalResolution: number;
	private usedColors: number;
	public importantColors: number;
	public palette: Pixel[];
	public scanlines: number[][][];
	public bottomUp = true;

	static Magic = Buffer.from('BM');

	static PixelDensities = {
		Monochrome:     1,  // * NumColors = 1
		Palletized4Bit: 4,  // * NumColors = 16
		Palletized8Bit: 8,  // * NumColors = 256
		RGB16Bit:       16, // * NumColors = 65536
		RGB24Bit:       24  // * NumColors = 16M
	};

	static CompressionTypes = {
		BI_RGB:            0,  // * No compression
		BI_RLE8:           1,  // * 8bit RLE encoding
		BI_RLE4:           2,  // * 4bit RLE encoding
		BI_BITFIELDS:      3,  // * OS22XBITMAPHEADER: Huffman 1D
		BI_JPEG:           4,  // * OS22XBITMAPHEADER: RLE-24
		BI_PNG:            5,  // * Not stated on wiki?
		BI_ALPHABITFIELDS: 6,  // * RGBA bit field masks
		BI_CMYK:           11, // * No compression
		BI_CMYKRLE8:       12, // * 8bit RLE encoding
		BI_CMYKRLE4:       13  // * 4bit RLE encoding
	};

	// * The size of the info header determines it's type
	static InfoHeaderTypes = {
		BITMAPCOREHEADER:   12,  // * Windows 2.0 or later
		OS21XBITMAPHEADER:  12,  // * OS/2 1.x
		OS22XBITMAPHEADER:  16,  // * Variant of BITMAPCOREHEADER2 with only the first 16 bytes. Remaining 48 are null
		BITMAPINFOHEADER:   40,  // * Windows NT, 3.1x or later. Extends bitmap width and height to 4 bytes. Adds 16 bpp and 32 bpp formats. Adds RLE compression
		BITMAPV2INFOHEADER: 52,  // * Proprietary Adobe format. Undocumented. Adds RGB bit masks
		BITMAPV3INFOHEADER: 56,  // * Proprietary Adobe format. Partially documented. Adds alpha channel bit mask
		BITMAPCOREHEADER2:  64,  // * OS/2 BITMAPCOREHEADER2. Adds halftoning. Adds RLE and Huffman 1D compression
		BITMAPV4HEADER:     108, // * Windows NT 4.0, 95 or later. Adds color space type and gamma correction
		BITMAPV5HEADER:     124  // * Windows NT 5.0, 98 or later. Adds ICC color profiles
	};

	constructor() {
		this.dataOffset = 0;
		this.width = 0;
		this.height = 0;
		this.planes = 1;
		this.pixelDensity = 0;
		this.paletteColorCount = 0;
		this.compressionType = 0;
		this.compressedImageSize = 0;
		this.horizontalResolution = 0;
		this.verticalResolution = 0;
		this.usedColors = 0;
		this.importantColors = 0;

		this.palette = [];
		this.scanlines = [];
	}

	private validateInfoHeaderType(infoHeaderType: number): void {
		if (
			infoHeaderType !== BMP.InfoHeaderTypes.BITMAPCOREHEADER &&
			infoHeaderType !== BMP.InfoHeaderTypes.OS21XBITMAPHEADER &&
			infoHeaderType !== BMP.InfoHeaderTypes.OS22XBITMAPHEADER &&
			infoHeaderType !== BMP.InfoHeaderTypes.BITMAPINFOHEADER &&
			infoHeaderType !== BMP.InfoHeaderTypes.BITMAPV2INFOHEADER &&
			infoHeaderType !== BMP.InfoHeaderTypes.BITMAPV3INFOHEADER &&
			infoHeaderType !== BMP.InfoHeaderTypes.BITMAPCOREHEADER2 &&
			infoHeaderType !== BMP.InfoHeaderTypes.BITMAPV4HEADER &&
			infoHeaderType !== BMP.InfoHeaderTypes.BITMAPV5HEADER
		) {
			throw new Error('Invalid BMP info header size');
		}

		// * Only support BITMAPINFOHEADER for now
		if (infoHeaderType !== BMP.InfoHeaderTypes.BITMAPINFOHEADER) {
			throw new Error('Only BITMAPINFOHEADER BMP images supported');
		}
	}

	private validatePixelDensity(pixelDensity: number): void {
		if (
			pixelDensity !== BMP.PixelDensities.Monochrome &&
			pixelDensity !== BMP.PixelDensities.Palletized4Bit &&
			pixelDensity !== BMP.PixelDensities.Palletized8Bit &&
			pixelDensity !== BMP.PixelDensities.RGB16Bit &&
			pixelDensity !== BMP.PixelDensities.RGB24Bit
		) {
			throw new Error('Invalid BMP pixel density');
		}

		// * Only support monochrome for now
		if (this.pixelDensity !== BMP.PixelDensities.Monochrome) {
			throw new Error('Only monochrome BMP images supported');
		}
	}

	private validateCompressionType(compressionType: number): void {
		if (
			compressionType !== BMP.CompressionTypes.BI_RGB &&
			compressionType !== BMP.CompressionTypes.BI_RLE8 &&
			compressionType !== BMP.CompressionTypes.BI_RLE4 &&
			compressionType !== BMP.CompressionTypes.BI_BITFIELDS &&
			compressionType !== BMP.CompressionTypes.BI_JPEG &&
			compressionType !== BMP.CompressionTypes.BI_PNG &&
			compressionType !== BMP.CompressionTypes.BI_ALPHABITFIELDS &&
			compressionType !== BMP.CompressionTypes.BI_CMYK &&
			compressionType !== BMP.CompressionTypes.BI_CMYKRLE8 &&
			compressionType !== BMP.CompressionTypes.BI_CMYKRLE4
		) {
			throw new Error('Invalid BMP compression type');
		}

		// * Don't support compression for now
		if (compressionType !== BMP.CompressionTypes.BI_RGB) {
			throw new Error('Only uncompressed BMP images supported');
		}
	}

	public parseFromBuffer(buffer: Buffer): void {
		this.readStream = new StreamIn(buffer);
		this.parse();
	}

	private parse(): void {
		this.parseHeader();
		this.parseInfoHeader();
		this.parsePalette();
		this.parseScanlines();
	}

	private parseHeader(): void {
		const magic = this.readStream.readBytes(2);

		if (!BMP.Magic.equals(magic)) {
			throw new Error('Invalid BMP magic');
		}

		const fileSize = this.readStream.readUint32LE();

		if (fileSize !== this.readStream.size()) {
			throw new Error('Invalid BMP file size');
		}

		this.readStream.skip(4); // * Reserved

		this.dataOffset = this.readStream.readUint32LE();
	}

	private parseInfoHeader(): void {
		this.infoHeaderType = this.readStream.readUint32LE();

		this.validateInfoHeaderType(this.infoHeaderType);

		// TODO - The others
		if (this.infoHeaderType === BMP.InfoHeaderTypes.BITMAPINFOHEADER) {
			this.parseBITMAPINFOHEADER();
		}
	}

	private parseBITMAPINFOHEADER(): void {
		this.width = this.readStream.readInt32LE();
		this.height = this.readStream.readInt32LE();

		if (this.height < 0) {
			this.bottomUp = false;
		}

		this.width = Math.abs(this.width); // TODO - Does a negative width mean anything?
		this.height = Math.abs(this.height);

		this.planes = this.readStream.readUint16LE();

		if (this.planes !== 1) {
			throw new Error('Invalid BMP planes count');
		}

		this.pixelDensity = this.readStream.readUint16LE();

		this.validatePixelDensity(this.pixelDensity);

		this.paletteColorCount = 1 << this.pixelDensity;
		this.compressionType = this.readStream.readUint32LE();

		this.validateCompressionType(this.compressionType);

		this.compressedImageSize = this.readStream.readUint32LE();

		if (this.compressedImageSize === 0 && this.compressionType !== 0) {
			throw new Error('Invalid BMP compressed image size');
		}

		this.horizontalResolution = this.readStream.readInt32LE();
		this.verticalResolution = this.readStream.readInt32LE();
		this.usedColors = this.readStream.readUint32LE();
		this.importantColors = this.readStream.readUint32LE();
	}

	private parsePalette(): void {
		if (this.pixelDensity > BMP.PixelDensities.Palletized8Bit) {
			// * Higher pixel densities do not use a palette
			return;
		}

		const paletteSize = this.usedColors === 0 ? this.paletteColorCount : this.usedColors;

		for (let i = 0; i < paletteSize; i++) {
			this.palette.push({
				red: this.readStream.readUint8(),
				green: this.readStream.readUint8(),
				blue: this.readStream.readUint8(),
				quad: this.readStream.readUint8() // * Per spec this should be unused
			});
		}
	}

	private parseScanlines(): void {
		this.readStream.seek(this.dataOffset);

		// TODO - The others
		if (this.pixelDensity === BMP.PixelDensities.Monochrome) {
			this.parseMonochromePixelData();
		}
	}

	private parseMonochromePixelData(): void {
		if (this.palette.length !== 2) {
			throw new Error(`Invalid monochrome palette. Palette should contain 2 colors, got ${this.palette.length}.`);
		}

		// * Scanlines are padded to multiples of 4 bytes
		const rowSize = Math.ceil((this.pixelDensity * this.width) / 32) * 4;
		const rowPadding = rowSize - (this.width * (this.pixelDensity / 8));

		// * Some images are written bottom-up, some are not (if the height is negative).
		// * Figure out which scanline to start with and how to step through them
		const startScanline = this.bottomUp ? this.height - 1 : 0;
		const step = this.bottomUp ? -1 : 1;

		for (let y = startScanline; y >= 0 && y < this.height; y += step) {
			const scanline = [];

			for (let x = 0; x < rowSize; x++) {
				const byte = this.readStream.readUint8();

				for (let bit = 7; bit >= 0; bit--) {
					const paletteIndex = (byte >> bit) & 1;
					const color = this.palette[paletteIndex];
					const pixel = [
						color.blue,
						color.green,
						color.red,
						color.quad,
					];

					scanline.push(pixel);
				}
			}

			this.readStream.skip(rowPadding);
			this.scanlines.push(scanline);
		}
	}

	public encode(): Buffer {
		this.writeStream = new StreamOut();

		this.encodeHeader();
		this.encodeInfoHeader();
		this.encodePalette();

		// * Neither the data offset nor the file size have been
		// * written to the buffer yet. Need to account for the
		// * missing bytes (4 for the data offset, 4 for the size)
		const dataOffset = this.writeStream.size()+8;

		this.encodeScanlines();

		const size = this.writeStream.size();

		this.writeStream.seek(0x2);
		this.writeStream.writeUint32LE(size+8);

		this.writeStream.seek(0xA);
		this.writeStream.writeUint32LE(dataOffset);

		return this.writeStream.bytes();
	}

	private encodeHeader(): void {
		this.writeStream.writeBytes(BMP.Magic);
		// * File size, write back later
		this.writeStream.skip(4); // * Reserved
		// * Data offset, write back later
	}

	private encodeInfoHeader(): void {
		this.validateInfoHeaderType(this.infoHeaderType);
		this.validatePixelDensity(this.pixelDensity);
		this.validateCompressionType(this.compressionType);

		if (this.planes !== 1) {
			throw new Error('Invalid BMP planes count');
		}

		this.paletteColorCount = 1 << this.pixelDensity;

		// TODO - The others
		if (this.infoHeaderType === BMP.InfoHeaderTypes.BITMAPINFOHEADER) {
			this.encodeBITMAPINFOHEADER();
		}
	}

	private encodeBITMAPINFOHEADER(): void {
		this.writeStream.writeUint32LE(this.infoHeaderType);
		this.writeStream.writeInt32LE(this.width);

		if (!this.bottomUp && this.height > 0) {
			this.writeStream.writeInt32LE(-this.height);
		} else {
			this.writeStream.writeInt32LE(this.height);
		}

		this.width = Math.abs(this.width); // TODO - Does a negative width mean anything?
		this.height = Math.abs(this.height);

		this.writeStream.writeUint16LE(this.planes);
		this.writeStream.writeUint16LE(this.pixelDensity);
		this.writeStream.writeUint32LE(this.compressionType);
		this.writeStream.writeUint32LE(0); // * Compressed image size. Do not compress
		this.writeStream.writeInt32LE(this.horizontalResolution); // TODO - Calculate this
		this.writeStream.writeInt32LE(this.verticalResolution); // TODO - Calculate this
		this.writeStream.writeUint32LE(this.usedColors); // TODO - Calculate this
		this.writeStream.writeUint32LE(this.importantColors); // * Generally ignored, just let the user set it if they want it
	}

	private encodePalette(): void {
		if (this.pixelDensity > BMP.PixelDensities.Palletized8Bit) {
			// * Higher pixel densities do not use a palette
			return;
		}

		const paletteSize = this.usedColors === 0 ? this.paletteColorCount : this.usedColors;

		for (let i = 0; i < paletteSize; i++) {
			const color = this.palette[i];

			this.writeStream.writeUint8(color.red);
			this.writeStream.writeUint8(color.green);
			this.writeStream.writeUint8(color.blue);
			this.writeStream.writeUint8(color.quad); // * Per spec this should be unused
		}
	}

	private encodeScanlines(): void {
		// TODO - The others
		if (this.pixelDensity === BMP.PixelDensities.Monochrome) {
			this.encodeMonochromePixelData();
		}
	}

	private encodeMonochromePixelData(): void {
		if (this.palette.length !== 2) {
			throw new Error(`Invalid monochrome palette. Palette should contain 2 colors, got ${this.palette.length}.`);
		}

		// * Scanlines are padded to multiples of 4 bytes
		const rowSize = Math.ceil((this.pixelDensity * this.width) / 32) * 4;
		const rowPadding = rowSize - (this.width * (this.pixelDensity / 8));

		const pixels = this.pixelsBGRQUAD();

		// * Some images are written bottom-up, some are not (if the height is negative).
		// * Figure out which scanline to start with and how to step through them
		const startScanline = this.bottomUp ? this.height - 1 : 0;
		const step = this.bottomUp ? -1 : 1;

		for (let scanline = startScanline; scanline >= 0 && scanline < this.height; scanline += step) {
			// * Monochrome BMPs encode each pixel as bits in a byte. One byte holds
			// * the palette information for 8 pixels, so get 8 at a time and pack
			for (let col = 0; col < this.width; col += 8) {
				const bytePixels = pixels.slice((scanline * this.width + col) * 4, (scanline * this.width + col + 8) * 4);
				let byte = 0;

				for (let bit = 0; bit < 8; bit++) {
					const [blue, green, red, quad] = bytePixels.slice(bit * 4, (bit * 4) + 4);
					const paletteIndex = this.palette.findIndex(color => {
						return color.blue === blue && color.green === green && color.red === red && color.quad === quad;
					});

					if (paletteIndex === -1) {
						throw new Error('Invalid color palette. Failed to find color for pixel');
					}

					byte |= (paletteIndex << (7 - bit));
				}

				this.writeStream.writeUint8(byte);
			}

			if (rowPadding > 0) {
				const padding = Buffer.alloc(rowPadding);
				this.writeStream.writeBytes(padding);
			}
		}
	}

	public pixelsBGR(): number[] {
		const scanlines = [...this.scanlines];

		if (this.bottomUp) {
			scanlines.reverse();
		}

		// * Remove the QUAD value
		const final = scanlines.map(scanline => scanline.map(colors => colors.slice(0, 3)));

		return final.flat(Infinity) as number[]; // TODO - Can this "as" be removed?
	}

	public pixelsBGRQUAD(): number[] {
		const scanlines = [...this.scanlines];

		if (this.bottomUp) {
			scanlines.reverse();
		}

		return scanlines.flat(Infinity) as number[]; // TODO - Can this "as" be removed?
	}

	public pixelsRGB(): number[] {
		const scanlines = [...this.scanlines];

		if (this.bottomUp) {
			scanlines.reverse();
		}

		// * Remove the QUAD value and swap from BGR to RGB
		const final = scanlines.map(scanline =>
			scanline.map(colors => {
				const bgr = colors.slice(0, 3);

				return [bgr[2], bgr[1], bgr[0]];
			})
		);

		return final.flat(Infinity) as number[]; // TODO - Can this "as" be removed?
	}

	public pixelsRGBQUAD(): number[] {
		const scanlines = [...this.scanlines];

		if (this.bottomUp) {
			scanlines.reverse();
		}

		// * Swap from BGR to RGB and add the QUAD
		const final = scanlines.map(scanline =>
			scanline.map(colors => {
				const bgr = colors.slice(0, 3);

				return [bgr[2], bgr[1], bgr[0], colors[3]];
			})
		);

		return final.flat(Infinity) as number[]; // TODO - Can this "as" be removed?
	}
}
