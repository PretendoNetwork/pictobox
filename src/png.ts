// * Based on:
// * - https://wikipedia.org/wiki/PNG

import crc32 from 'buffer-crc32';
import pako from 'pako';
import StreamIn from '@/stream-in';
import StreamOut from '@/stream-out';

// TODO - TSDoc comments

type Pixel = {
	red: number;
	green: number;
	blue: number;
	alpha?: number;
};

export default class PNG {
	private readStream: StreamIn;
	private writeStream: StreamOut;

	private lastChunkType: string;
	private seenIHDR = false;
	private seenPLTE = false;

	public width: number;
	public height: number;
	public bitDepth: number;
	public colorType: number;
	private colorChannels: number;
	public compressionMethod = 0;
	public filterMethod = 0;
	public interlaceMethod: number;
	public palette: Pixel[] = [];
	private compressedSampleData = Buffer.alloc(0); // * PNGs can have multiple IDAT chunks. Store them all here for later
	public pixels: Pixel[] = [];

	static Magic = Buffer.from([
		0x89,             // * Has the high bit set to detect transmission systems that do not support 8-bit data and to reduce the chance that a text file is mistakenly interpreted as a PNG, or vice versa.
		0x50, 0x4E, 0x47, // * In ASCII, the letters PNG, allowing a person to identify the format easily if it is viewed in a text editor.
		0x0D, 0x0A,       // * A DOS-style line ending (CRLF) to detect DOS-Unix line ending conversion of the data.
		0x1A,             // * A byte that stops display of the file under DOS when the command type has been used—the end-of-file character.
		0x0A              // * A Unix-style line ending (LF) to detect Unix-DOS line ending conversion.
	]);

	static BitDepths = {
		Bits1:  1,
		Bits2:  2,
		Bits4:  4,
		Bits8:  8,
		Bits16: 16
	};

	static ColorTypes = {
		Grayscale:          0,
		RGB:                2,
		Indexed:            3,
		GrayscaleWithAlpha: 4,
		RGBA:               6
	};

	static InterlaceMethods = {
		None:  0,
		Adam7: 1
	};

	// * Marked private and not static to not pollute intellisense
	private ScanlineFilterTypes = {
		None:    0, // * Raw data, no filtering
		Sub:     1, // * Byte A (to the left)
		Up:      2, // * Byte B (above)
		Average: 3, // * Mean of bytes A and B, rounded down
		Paeth:   4  // * A, B, or C, whichever is closest to p = A + B − C
	};

	// * Marked private and not static to not pollute intellisense
	private ChunkTypes = {
		IHDR: Buffer.from('IHDR'),
		PLTE: Buffer.from('PLTE'),
		IDAT: Buffer.from('IDAT'),
		IEND: Buffer.from('IEND')
	};

	// * Marked private and not static to not pollute intellisense
	private ColorTypeChannels = {
		[PNG.ColorTypes.Grayscale]:          1,
		[PNG.ColorTypes.RGB]:                3,
		[PNG.ColorTypes.Indexed]:            1,
		[PNG.ColorTypes.GrayscaleWithAlpha]: 2,
		[PNG.ColorTypes.RGBA]:               4
	};

	private validateBitDepth(): void {
		if (
			this.bitDepth !== PNG.BitDepths.Bits1 &&
			this.bitDepth !== PNG.BitDepths.Bits2 &&
			this.bitDepth !== PNG.BitDepths.Bits4 &&
			this.bitDepth !== PNG.BitDepths.Bits8 &&
			this.bitDepth !== PNG.BitDepths.Bits16
		) {
			throw new Error(`Invalid bit depth. Expected one of 1, 2, 4, 8, or 16. Got ${this.bitDepth}`);
		}
	}

	private validateColorType(): void {
		if (
			this.colorType !== PNG.ColorTypes.Grayscale &&
			this.colorType !== PNG.ColorTypes.RGB &&
			this.colorType !== PNG.ColorTypes.Indexed &&
			this.colorType !== PNG.ColorTypes.GrayscaleWithAlpha &&
			this.colorType !== PNG.ColorTypes.RGBA
		) {
			throw new Error(`Invalid color type. Expected one of 0 (grayscale), 2 (RGB), 3 (indexed), 4 (grayscale with alpha), or 6 (RGBA). Got ${this.colorType}`);
		}

		if (this.colorType === PNG.ColorTypes.Indexed && this.bitDepth === PNG.BitDepths.Bits16) {
			throw new Error('Invalid color type and both depth combination. Bit depth 16 cannot be used with the indexed color type');
		}

		if (this.colorType === PNG.ColorTypes.GrayscaleWithAlpha && this.bitDepth === PNG.BitDepths.Bits1) {
			throw new Error('Invalid color type and both depth combination. Bit depth 1 cannot be used with the grayscale with alpha color type');
		}

		if (this.colorType === PNG.ColorTypes.GrayscaleWithAlpha && this.bitDepth === PNG.BitDepths.Bits2) {
			throw new Error('Invalid color type and both depth combination. Bit depth 2 cannot be used with the grayscale with alpha color type');
		}

		if (this.colorType === PNG.ColorTypes.GrayscaleWithAlpha && this.bitDepth === PNG.BitDepths.Bits4) {
			throw new Error('Invalid color type and both depth combination. Bit depth 4 cannot be used with the grayscale with alpha color type');
		}

		if (this.colorType === PNG.ColorTypes.RGB && this.bitDepth === PNG.BitDepths.Bits1) {
			throw new Error('Invalid color type and both depth combination. Bit depth 1 cannot be used with the RGB color type');
		}

		if (this.colorType === PNG.ColorTypes.RGB && this.bitDepth === PNG.BitDepths.Bits2) {
			throw new Error('Invalid color type and both depth combination. Bit depth 2 cannot be used with the RGB color type');
		}

		if (this.colorType === PNG.ColorTypes.RGB && this.bitDepth === PNG.BitDepths.Bits4) {
			throw new Error('Invalid color type and both depth combination. Bit depth 4 cannot be used with the RGB color type');
		}

		if (this.colorType === PNG.ColorTypes.RGBA && this.bitDepth === PNG.BitDepths.Bits1) {
			throw new Error('Invalid color type and both depth combination. Bit depth 1 cannot be used with the RGBA color type');
		}

		if (this.colorType === PNG.ColorTypes.RGBA && this.bitDepth === PNG.BitDepths.Bits2) {
			throw new Error('Invalid color type and both depth combination. Bit depth 2 cannot be used with the RGBA color type');
		}

		if (this.colorType === PNG.ColorTypes.RGBA && this.bitDepth === PNG.BitDepths.Bits4) {
			throw new Error('Invalid color type and both depth combination. Bit depth 4 cannot be used with the RGBA color type');
		}
	}

	private validateCompressionMethod(): void {
		if (this.compressionMethod !== 0) {
			throw new Error(`Invalid compression method. Expected 0, got ${this.compressionMethod}`);
		}
	}

	private validateFilterMethod(): void {
		if (this.filterMethod !== 0) {
			throw new Error(`Invalid filter method. Expected 0, got ${this.filterMethod}`);
		}
	}

	private validateInterlaceMethod(): void {
		if (this.interlaceMethod !== PNG.InterlaceMethods.None && this.interlaceMethod !== PNG.InterlaceMethods.Adam7) {
			throw new Error(`Invalid interlace method. Expected either 0 (none) or 1 (Adam7), got ${this.interlaceMethod}`);
		}

		if (this.interlaceMethod !== PNG.InterlaceMethods.None) {
			throw new Error('Interlaced images not currently supported');
		}
	}

	public parseFromBuffer(buffer: Buffer): void {
		this.readStream = new StreamIn(buffer);
		this.parse();
	}

	private parse(): void {
		this.parseHeader();

		while (this.readStream.hasData()) {
			if (this.lastChunkType === 'IEND') {
				// * Image has ended, force stop parsing even if there's data left
				break;
			}

			this.readChunk();
		}
	}

	private parseHeader(): void {
		const highBit = this.readStream.readUint8();

		if (highBit !== 0x89) {
			throw new Error(`Invalid PNG header. Expected 0x89 high bit, got 0x${highBit.toString(16).toUpperCase()}`);
		}

		const asciiPNG = this.readStream.readBytes(3);

		if (!asciiPNG.equals(Buffer.from([ 0x50, 0x4E, 0x47 ]))) {
			throw new Error(`Invalid PNG header. Expected ascii PNG, got ${asciiPNG.toString()}`);
		}

		const dosLineEnding = this.readStream.readBytes(2);

		if (!dosLineEnding.equals(Buffer.from([ 0x0D, 0x0A ]))) {
			throw new Error(`Invalid PNG header. Expected DOS line-ending, got 0x${dosLineEnding.toString('hex').toUpperCase()}`);
		}

		const dosEOF = this.readStream.readUint8();

		if (highBit !== 0x89) {
			throw new Error(`Invalid PNG header. Expected DOS end of file byte, got 0x${dosEOF.toString(16).toUpperCase()}`);
		}

		const unixLineEnding = this.readStream.readUint8();

		if (highBit !== 0x89) {
			throw new Error(`Invalid PNG header. Expected Unix line ending, got 0x${unixLineEnding.toString(16).toUpperCase()}`);
		}
	}

	private readChunk(): void {
		const length = this.readStream.readUint32BE();
		const type = this.readStream.readBytes(4);
		const data = this.readStream.readBytes(length);
		const expectedCRC = this.readStream.readUint32BE();
		const typeString = type.toString();
		const calculatedCRC = crc32.unsigned(Buffer.concat([ type, data ]));

		if (calculatedCRC !== expectedCRC) {
			throw new Error(`Invalid chunk. Checksum validation failed for chunk ${typeString}. Expected ${expectedCRC}, got ${calculatedCRC}`);
		}

		if (!this.seenIHDR && !type.equals(this.ChunkTypes.IHDR)) {
			throw new Error(`Invalid PNG. First chunk must be IHDR, got ${typeString}`);
		}

		if (
			this.seenIHDR &&
			this.colorType === PNG.ColorTypes.Indexed &&
			!this.seenPLTE &&
			type.equals(this.ChunkTypes.IDAT)
		) {
			throw new Error('Invalid PNG. Found image data chunk (IDAT) before palette chunk (PLTE) while using indexed color type');
		}

		if (
			this.seenIHDR &&
			(this.colorType === PNG.ColorTypes.Grayscale || this.colorType === PNG.ColorTypes.GrayscaleWithAlpha) &&
			type.equals(this.ChunkTypes.PLTE)
		) {
			throw new Error('Invalid PNG. Found palette chunk (PLTE) while using a grayscale color type');
		}

		if (this.seenIHDR && type.equals(this.ChunkTypes.IHDR)) {
			throw new Error('Invalid PNG. Found multiple IHDR chunks');
		}

		if (this.seenPLTE && type.equals(this.ChunkTypes.PLTE)) {
			throw new Error('Invalid PNG. Found multiple PLTE chunks');
		}

		// * Ignore ancillary chunks for now, as they can be safely ignored
		if (type[0] < 65 || type[0] > 90) {
			this.lastChunkType = typeString;
			return;
		}

		switch (typeString) {
			case 'IHDR':
				this.parseIHDRChunk(data);
				break;
			case 'PLTE':
				this.parsePLTEChunk(data);
				break;
			case 'IDAT':
				// * A PNG image may have multiple IDAT chunks. These chunks are compressed,
				// * and so each chunk must first be obtained before the decompression and
				// * sample decoding can begin
				this.compressedSampleData = Buffer.concat([ this.compressedSampleData, data ]);
				break;
			case 'IEND':
				// * Assume the end of the file has been reached. Start the sample parsing
				// * process now
				this.processSampleData();
				break;
			default:
				throw new Error(`Invalid chunk. Unknown critical chunk type ${typeString}.`);
		}

		this.lastChunkType = typeString;
	}

	private parseIHDRChunk(data: Buffer): void {
		const dataStream = new StreamIn(data);

		this.width = dataStream.readUint32BE();
		this.height = dataStream.readUint32BE();
		this.bitDepth = dataStream.readUint8();

		this.validateBitDepth();

		this.colorType = dataStream.readUint8();

		this.validateColorType();

		this.compressionMethod = dataStream.readUint8();

		this.validateCompressionMethod();

		this.filterMethod = dataStream.readUint8();

		this.validateFilterMethod();

		this.interlaceMethod = dataStream.readUint8();

		this.validateInterlaceMethod();

		this.colorChannels = this.ColorTypeChannels[this.colorType];
		this.seenIHDR = true;
	}

	private parsePLTEChunk(data: Buffer): void {
		if (data.length % 3 !== 0) {
			throw new Error(`Invalid PLTE chunk. Length must be multiple of 3, got ${data.length}`);
		}

		const dataStream = new StreamIn(data);

		while (dataStream.hasData()) {
			this.palette.push({
				red: dataStream.readUint8(),
				green: dataStream.readUint8(),
				blue: dataStream.readUint8()
			});
		}
	}

	private processSampleData(): void {
		// * The PNG specification only has a single image filtering
		// * option (method 0), which does nothing. Should the
		// * specification be updated to include image filtering, this
		// * function should be updated to account for that
		// TODO - Support Adam7 interlacing

		const decompressed = pako.inflate(this.compressedSampleData);
		const pixelSize = (this.colorChannels * this.bitDepth) / 8;
		const scanlineSize = 1 + (pixelSize * this.width);
		const dataStream = new StreamIn(Buffer.from(decompressed));
		let previousScanline: Buffer | null = null;

		while (dataStream.hasData()) {
			const scanline = new StreamIn(dataStream.readBytes(scanlineSize));
			const filterType = scanline.readUint8();
			const filteredLine = scanline.readBytes(scanlineSize-1);
			let unfilteredScanline: Buffer;

			switch (filterType) {
				case this.ScanlineFilterTypes.None:
					unfilteredScanline = filteredLine;
					break;
				case this.ScanlineFilterTypes.Sub:
					unfilteredScanline = this.unfilterScanlineSub(filteredLine, pixelSize);
					break;
				case this.ScanlineFilterTypes.Up:
					unfilteredScanline = this.unfilterScanlineUp(filteredLine, previousScanline);
					break;
				case this.ScanlineFilterTypes.Average:
					unfilteredScanline = this.unfilterScanlineAverage(filteredLine, previousScanline, pixelSize);
					break;
				case this.ScanlineFilterTypes.Paeth:
					unfilteredScanline = this.unfilterScanlinePaeth(filteredLine, previousScanline, pixelSize);
					break;
				default:
					throw new Error(`Invalid scanline. Unknown filter type ${filterType}.`);
			}

			this.parseScanline(unfilteredScanline);

			previousScanline = unfilteredScanline;
		}
	}

	private unfilterScanlineSub(scanline: Buffer, pixelSize: number): Buffer {
		const unfiltered = Buffer.alloc(scanline.length);

		for (let i = 0; i < scanline.length; i++) {
			const byte = scanline[i];
			const left = i < pixelSize ? 0 : unfiltered[i - pixelSize];

			unfiltered[i] = (byte + left) & 0xFF;
		}

		return unfiltered;
	}

	private unfilterScanlineUp(scanline: Buffer, previousScanline: Buffer | null): Buffer {
		const unfiltered = Buffer.alloc(scanline.length);

		for (let i = 0; i < scanline.length; i++) {
			const byte = scanline[i];
			const above = previousScanline ? previousScanline[i] : 0;

			unfiltered[i] = (byte + above) & 0xFF;
		}

		return unfiltered;
	}

	private unfilterScanlineAverage(scanline: Buffer, previousScanline: Buffer | null, pixelSize: number): Buffer {
		const unfiltered = Buffer.alloc(scanline.length);

		for (let i = 0; i < scanline.length; i++) {
			const byte = scanline[i];
			const left = i < pixelSize ? 0 : unfiltered[i - pixelSize];
			const above = previousScanline ? previousScanline[i] : 0;

			unfiltered[i] = (byte + Math.floor((left + above) / 2)) & 0xFF;
		}

		return unfiltered;
	}

	private unfilterScanlinePaeth(scanline: Buffer, previousScanline: Buffer | null, pixelSize: number): Buffer {
		const unfiltered = Buffer.alloc(scanline.length);

		for (let i = 0; i < scanline.length; i++) {
			const byte = scanline[i];
			const left = i < pixelSize ? 0 : unfiltered[i - pixelSize];
			const above = previousScanline ? previousScanline[i] : 0;
			const upperLeft = (previousScanline && i >= pixelSize) ? previousScanline[i - pixelSize] : 0;

			unfiltered[i] = (byte + this.paethPredictor(left, above, upperLeft)) & 0xFF;
		}

		return unfiltered;
	}

	private paethPredictor(a: number, b: number, c: number): number {
		const p = a + b - c;
		const pa = Math.abs(p - a);
		const pb = Math.abs(p - b);
		const pc = Math.abs(p - c);
		let prediction = c;

		if (pa <= pb && pa <= pc) {
			prediction = a;
		} else if (pb <= pc) {
			prediction = b;
		}

		return prediction;
	}

	private parseScanline(scanline: Buffer): void {
		const scanlineStream = new StreamIn(scanline);
		while (scanlineStream.hasData()) {
			const pixel: Pixel = {
				red: 0,
				green: 0,
				blue: 0
			};

			switch (this.colorType) {
				case PNG.ColorTypes.Grayscale: {
					const color = this.readSample(scanlineStream);

					pixel.red = color;
					pixel.green = color;
					pixel.blue = color;

					break;
				}
				case PNG.ColorTypes.RGB:
					pixel.red = this.readSample(scanlineStream);
					pixel.green = this.readSample(scanlineStream);
					pixel.blue = this.readSample(scanlineStream);

					break;
				case PNG.ColorTypes.Indexed: {
					const paletteIndex = this.readSample(scanlineStream);
					const color = this.palette[paletteIndex];

					if (color) {
						pixel.red = color.red;
						pixel.green = color.green;
						pixel.blue = color.blue;
					}

					break;
				}
				case PNG.ColorTypes.GrayscaleWithAlpha: {
					const color = this.readSample(scanlineStream);

					pixel.red = color;
					pixel.green = color;
					pixel.blue = color;
					pixel.alpha = this.readSample(scanlineStream);

					break;
				}
				case PNG.ColorTypes.RGBA:
					pixel.red = this.readSample(scanlineStream);
					pixel.green = this.readSample(scanlineStream);
					pixel.blue = this.readSample(scanlineStream);
					pixel.alpha = this.readSample(scanlineStream);

					break;
			}

			this.pixels.push(pixel);
		}
	}

	private readSample(stream: StreamIn): number {
		let sample = 0;

		if (this.bitDepth === PNG.BitDepths.Bits8) {
			sample = stream.readUint8();
		} else if (this.bitDepth === PNG.BitDepths.Bits16) {
			sample = stream.readUint16BE();
		} else {
			// TODO - Support these
			throw new Error(`Bit depth ${this.bitDepth} not currently supported`);
		}

		return sample;
	}

	public encode(): Buffer {
		this.writeStream = new StreamOut();

		this.writeStream.writeBytes(PNG.Magic);
		this.encodeIHDRChunk();

		if (this.colorType === PNG.ColorTypes.Indexed) {
			this.encodePLTEChunk();
		}

		this.encodePixels();
		this.writeChunk(this.ChunkTypes.IEND, Buffer.alloc(0));

		return this.writeStream.bytes();
	}

	private encodeIHDRChunk(): void {
		this.validateBitDepth();
		this.validateColorType();
		this.validateCompressionMethod();
		this.validateFilterMethod();
		this.validateInterlaceMethod();

		const chunkStream = new StreamOut();

		chunkStream.writeUint32BE(this.width);
		chunkStream.writeUint32BE(this.height);
		chunkStream.writeUint8(this.bitDepth);
		chunkStream.writeUint8(this.colorType);
		chunkStream.writeUint8(this.compressionMethod);
		chunkStream.writeUint8(this.filterMethod);
		chunkStream.writeUint8(this.interlaceMethod);

		this.writeChunk(this.ChunkTypes.IHDR, chunkStream.bytes());
	}

	private encodePLTEChunk(): void {
		// * Assume if the palette length is 0, it still needs
		// * to be made. Assume if not 0, the palette is already
		// * made
		if (this.palette.length === 0) {
			for (const pixel of this.pixels) {
				// * Indexed images do not support alpha
				const index = this.palette.findIndex(({ red, green, blue }) => red === pixel.red && green === pixel.green && blue === pixel.blue);

				// * Only add unique colors to the palette
				if (index === -1) {
					this.palette.push(pixel);
				}
			}
		}

		const chunkStream = new StreamOut();

		for (const color of this.palette) {
			chunkStream.writeUint8(color.red);
			chunkStream.writeUint8(color.green);
			chunkStream.writeUint8(color.blue);
		}

		this.writeChunk(this.ChunkTypes.PLTE, chunkStream.bytes());
	}

	private encodePixels(): void {
		const scanlinesStream = new StreamOut();

		for (let y = 0; y < this.height; y++) {
			scanlinesStream.writeUint8(this.ScanlineFilterTypes.None); // * Never filter scanlines. Worse compression, but simpler encoding

			for (let x = 0; x < this.width; x++) {
				const pixelIndex = y * this.width + x;
				const pixel = this.pixels[pixelIndex];

				switch (this.colorType) {
					case PNG.ColorTypes.Grayscale: {
						this.writeSample(scanlinesStream, pixel.red); // * Only one color uses
						break;
					}
					case PNG.ColorTypes.RGB:
						this.writeSample(scanlinesStream, pixel.red);
						this.writeSample(scanlinesStream, pixel.green);
						this.writeSample(scanlinesStream, pixel.blue);

						break;
					case PNG.ColorTypes.Indexed: {
						// * Indexed images do not support alpha
						const index = this.palette.findIndex(({ red, green, blue }) => red === pixel.red && green === pixel.green && blue === pixel.blue);

						if (index === -1) {
							throw new Error('Failed to find color in palette. Ensure palette has all used colors');
						}

						this.writeSample(scanlinesStream, index);

						break;
					}
					case PNG.ColorTypes.GrayscaleWithAlpha: {
						this.writeSample(scanlinesStream, pixel.red);
						this.writeSample(scanlinesStream, pixel.alpha || 0);

						break;
					}
					case PNG.ColorTypes.RGBA:
						this.writeSample(scanlinesStream, pixel.red);
						this.writeSample(scanlinesStream, pixel.green);
						this.writeSample(scanlinesStream, pixel.blue);
						this.writeSample(scanlinesStream, pixel.alpha || 0);

						break;
				}
			}
		}

		const compressed = Buffer.from(pako.deflate(scanlinesStream.bytes()));

		// * Account for images with more than 0xFFFFFFFF pixels.
		// * Need multiple IDAT chunks in those cases
		for (let i = 0; i < compressed.length; i += 0xFFFFFFFF) {
			const chunk = compressed.subarray(i, i + 0xFFFFFFFF);

			this.writeChunk(this.ChunkTypes.IDAT, chunk);
		}
	}

	private writeChunk(type: Buffer, data: Buffer): void {
		this.writeStream.writeUint32BE(data.length);
		this.writeStream.writeBytes(type);
		this.writeStream.writeBytes(data);
		this.writeStream.writeUint32BE(crc32.unsigned(Buffer.concat([ type, data ])));
	}

	private writeSample(stream: StreamOut, sample: number): void {
		if (this.bitDepth === PNG.BitDepths.Bits8) {
			stream.writeUint8(sample);
		} else if (this.bitDepth === PNG.BitDepths.Bits16) {
			stream.writeUint16BE(sample);
		} else {
			// TODO - Support these
			throw new Error(`Bit depth ${this.bitDepth} not currently supported`);
		}
	}

	public pixelsRGB(): Buffer {
		const stream = new StreamOut();

		for (const pixel of this.pixels) {
			stream.writeUint8(pixel.red);
			stream.writeUint8(pixel.green);
			stream.writeUint8(pixel.blue);
		}

		return stream.bytes();
	}

	public pixelsRGBA(): Buffer {
		const stream = new StreamOut();

		for (const pixel of this.pixels) {
			stream.writeUint8(pixel.red);
			stream.writeUint8(pixel.green);
			stream.writeUint8(pixel.blue);
			stream.writeUint8(pixel.alpha || 0);
		}

		return stream.bytes();
	}
}