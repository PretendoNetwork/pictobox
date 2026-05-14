// * Based on:
// * - https://registry.khronos.org/DataFormat/specs/1.1/dataformat.1.1.html#ETC1
// * - https://github.com/PretendoNetwork/ita-bag/blob/3a975effeaed54d8cef89afc1f9e9a236254b848/etc1.js
// * - https://github.com/ShaneYCG/wfETC/blob/443281432c4afe9e90f1632cd43229e623d28632/wfETC.c
// * - https://github.com/glaubitz/ppsspp-debian/blob/7fd2c6f72ff8d639bb52bb9b2692cd1a88313a66/native/ext/etcpack/etcpack.cpp

import StreamIn from '@/stream-in';
import StreamOut from '@/stream-out';

type RGB = {
	red: number;
	green: number;
	blue: number;
};

type Pixel = RGB & {
	alpha: number;
};

type ColorAverage = RGB;

type SubblockOrientation = 'horizontal' | 'vertical';

type SubblockResult = {
	bestError: number;
	bestTable: number;
	pixelIndexBitsMSB: number;
	pixelIndexBitsLSB: number;
};

type SubblockCompressResult = {
	error: number;
	pixelIndexBitsMSB: number;
	pixelIndexBitsLSB: number;
};

/**
 * Quality level for ETC1 block compression. Lower values have worse quality, but are faster.
 *
 * Each level has a `Perceptual` variant that uses a perceptually-weighted color distance metric
 * instead of straight squared error, producing results that better match human visual perception
 * at the same speed as the non-perceptual variant.
 */
export enum QualityLevel {
	/**
	 * Single-pass encode using subblock averages. Fastest, but lowest quality.
	 */
	Fast,

	/**
	 * {@link Fast} with perceptual color distance.
	 */
	FastPerceptual,

	/**
	 * Exhaustive search over a narrow delta range around the subblock averages, only checking either
	 * individual or differential mode. Slightly faster than {@link Slow}, but with comparable results.
	 */
	Medium,

	/**
	 * {@link Medium} with perceptual color distance.
	 */
	MediumPerceptual,

	/**
	 * Exhaustive search over a wide delta range, plus unconditional individual mode search. Slowest, but highest quality
	 */
	Slow,

	/**
	 * {@link Slow} with perceptual color distance.
	 */
	SlowPerceptual
}

// * Emulates "int err1[SLOW_SCAN_RANGE][SLOW_SCAN_RANGE][SLOW_SCAN_RANGE];"
class Int32Array3D {
	private data: Int32Array;
	private stride1: number; // * Elements per i-step
	private stride2: number; // * Elements per j-step

	constructor(s1: number, s2: number, s3: number) {
		this.data = new Int32Array(s1 * s2 * s3);
		this.stride1 = s2 * s3;
		this.stride2 = s3;
	}

	get(i: number, j: number, k: number): number {
		return this.data[i * this.stride1 + j * this.stride2 + k];
	}

	set(i: number, j: number, k: number, value: number): void {
		this.data[i * this.stride1 + j * this.stride2 + k] = value;
	}
}

const PERCEPTUAL_WEIGHT_R_SQUARED = 0.299;
const PERCEPTUAL_WEIGHT_G_SQUARED = 0.587;
const PERCEPTUAL_WEIGHT_B_SQUARED = 0.114;

const FAST_SCAN_MIN = -4;
const FAST_SCAN_MAX = 3;

const MEDIUM_SCAN_MIN = -3;
const MEDIUM_SCAN_MAX = 3;
const MEDIUM_SCAN_RANGE = MEDIUM_SCAN_MAX - MEDIUM_SCAN_MIN + 1;
const MEDIUM_SCAN_OFFSET = -MEDIUM_SCAN_MIN;
const MEDIUM_TRY_MIN = -4 - MEDIUM_SCAN_MAX;
const MEDIUM_TRY_MAX = 3 - MEDIUM_SCAN_MIN;

const SLOW_SCAN_MIN = -5;
const SLOW_SCAN_MAX = 5;
const SLOW_SCAN_RANGE = SLOW_SCAN_MAX - SLOW_SCAN_MIN + 1;
const SLOW_SCAN_OFFSET = -SLOW_SCAN_MIN;
const SLOW_TRY_MIN = -4 - SLOW_SCAN_MAX;
const SLOW_TRY_MAX = 3 - SLOW_SCAN_MIN;

/**
 * ETC1A4 is an extension of ETC1 made by Nintendo.
 *
 * This extension makes the following changes:
 * - An additional alpha block can optionally be prepended to a color block.
 * - Blocks are scrambled.
 *
 * @see https://www.3dbrew.org/wiki/SMDH#Icon_graphics
 */
export default class ETC1A4 {
	private readStream: StreamIn;
	private blocksPerRow: number;
	private blocksPerColumn: number;

	public width: number;
	public height: number;
	public hasAlpha: boolean;
	public pixels: Pixel[];
	public quality = QualityLevel.SlowPerceptual;

	private ModifierTables = [
		// * Table is reordered in order to use the pixel
		// * index bits as a decimal index into the table
		[2, 8, -2, -8],
		[5, 17, -5, -17],
		[9, 29, -9, -29],
		[13, 42, -13, -42],
		[18, 60, -18, -60],
		[24, 80, -24, -80],
		[33, 106, -33, -106],
		[47, 183, -47, -183]
	];

	private subblockLayouts = [
		[ // * Flip bit is 0, the block is divided into two 2x4 subblocks side-by-side
			0, 0, 1, 1,
			0, 0, 1, 1,
			0, 0, 1, 1,
			0, 0, 1, 1
		],
		[ // * Flip bit is 1, the block is divided into two 4x2 subblocks on top of each other
			0, 0, 0, 0,
			0, 0, 0, 0,
			1, 1, 1, 1,
			1, 1, 1, 1
		]
	];

	constructor() {
		// * Default to assuming ETC1A4. The caller can disable this if no alpha block exists, however
		this.hasAlpha = true;
	}

	/**
	 * Parses an ETC1A4 image from a raw buffer.
	 *
	 * @param buffer - The raw ETC1A4-compressed image data.
	 */
	public parseFromBuffer(buffer: Buffer): void {
		this.readStream = new StreamIn(buffer);
		this.parse();
	}

	/** Main entry point for parsing an ETC1A4 image. */
	private parse(): void {
		this.pixels = [];

		const decompressed = this.decompress();
		const descrambled = this.descramble(decompressed);

		for (let i = 0; i < descrambled.length; i += 4) {
			const [red, green, blue, alpha] = descrambled.subarray(i, i + 4);

			this.pixels.push({ red, green, blue, alpha });
		}
	}

	/**
	 * Decompresses the ETC1A4 blocks into raw RGBA pixel data.
	 *
	 * @returns A buffer of decompressed pixel data in `[r,g,b,a]` order.
	 */
	private decompress(): Buffer {
		this.blocksPerRow = Math.floor(this.width / 4);
		this.blocksPerColumn = Math.floor(this.height / 4);

		const imageSize = this.width * this.height;
		const blockSize = this.hasAlpha ? 16 : 8;
		const decompressed = Buffer.alloc(imageSize * 4);

		for (let blockY = 0; blockY < this.blocksPerColumn; blockY++) {
			for (let blockX = 0; blockX < this.blocksPerRow; blockX++) {
				const blockData = this.readStream.readBytes(blockSize);
				let alphaBlock: Buffer;
				let colorBlock: Buffer;

				if (this.hasAlpha) {
					// * Image contains additional alpha blocks
					alphaBlock = blockData.subarray(0, 8);
					colorBlock = blockData.subarray(8);
				} else {
					// * If the image has no alpha data, just set it to all 0xFF
					alphaBlock = Buffer.alloc(8).fill(0xFF);
					colorBlock = blockData;
				}

				const decompressedColorBlock = this.decompressColorBlock(colorBlock);

				// * Pixels are stored as 4x4 blocks
				for (let pixelX = 0; pixelX < 4; pixelX++) {
					for (let pixelY = 0; pixelY < 4; pixelY++) {
						// * Pixels are stored as 4x4 blocks
						const decompressedPixelX = blockX * 4 + pixelX;
						const decompressedPixelY = ((blockY * 4 + pixelY) * this.width);
						const decompressedPixelIndex = (decompressedPixelX + decompressedPixelY) * 4;
						const decompressedColorIndex = (pixelX + (pixelY * 4)) * 4;
						const decompressedColor = decompressedColorBlock.subarray(decompressedColorIndex, decompressedColorIndex + 3);
						const [red, green, blue] = decompressedColor;

						// * ETC1A4 alpha data is stored as 4 bits of alpha data per pixel
						const alphaIndex = (pixelX * 4 + pixelY) >> 1;
						const alphaByte = alphaBlock[alphaIndex]; // * The actual byte with the data. Used twice to get both nibbles
						const shift = (pixelY % 2) * 4; // * Get either the high or low nibble
						let alpha = (alphaByte >> shift) & 0b1111; // * Only get the 4 bits we care about
						alpha = alpha | (alpha << 4); // * Expand the alpha to 8 bits by duplicating the first 4 bits

						decompressed[decompressedPixelIndex + 0] = red;
						decompressed[decompressedPixelIndex + 1] = green;
						decompressed[decompressedPixelIndex + 2] = blue;
						decompressed[decompressedPixelIndex + 3] = alpha;
					}
				}
			}
		}

		return decompressed;
	}

	/**
	 * Decompresses a single ETC1 color block (without alpha).
	 *
	 * @param block - The 8-byte color block to decompress.
	 * @returns A buffer containing a 4x4 block of RGB pixels (with alpha set to 0xFF).
	 */
	private decompressColorBlock(block: Buffer): Buffer {
		const blockData = block.readBigUInt64LE();

		const flipBit = Number((blockData >> 32n) & 1n); // * Determines if the subblocks are encoded as 2x4 or 4x2
		const diffBit = Number((blockData >> 33n) & 1n); // * Determines if the block uses differential or individual mode
		const tableCodeword1 = Number((blockData >> 37n) & 0b111n); // * Modifier tables index for subblock 1
		const tableCodeword2 = Number((blockData >> 34n) & 0b111n); // * Modifier tables index for subblock 2
		const pixelIndexBits = Number(blockData & 0xFFFFFFFFn); // * Remaining bits are the pixel index bits for the modifier table

		// * Blocks are split up into 2 subblocks,
		// * each with their own base color
		let subBlock1BaseR: number;
		let subBlock1BaseG: number;
		let subBlock1BaseB: number;
		let subBlock2BaseR: number;
		let subBlock2BaseG: number;
		let subBlock2BaseB: number;

		if (diffBit) {
			// * Differential mode.
			// * The first base color is encoded with 5 bits per component.
			subBlock1BaseR = Number((blockData >> 59n) & 0b11111n);
			subBlock1BaseG = Number((blockData >> 51n) & 0b11111n);
			subBlock1BaseB = Number((blockData >> 43n) & 0b11111n);

			// * The second base color is calculated using a 3-bit two's-complement
			// * for each component added to the 5 bit component of the base color 1.
			// * The two's-complement is added to the 5 bit component of the first base color.
			// * For example, if baseColor1R=28, and deltaRed=0b100=-4, then the five-bit
			// * representation for the red component is 28+(-4)=24=0b11000
			const deltaRed   = Number((blockData >> 56n) & 0b111n);
			const deltaGreen = Number((blockData >> 48n) & 0b111n);
			const deltaBlue  = Number((blockData >> 40n) & 0b111n);

			subBlock2BaseR = subBlock1BaseR + this.twosComplement(deltaRed);
			subBlock2BaseG = subBlock1BaseG + this.twosComplement(deltaGreen);
			subBlock2BaseB = subBlock1BaseB + this.twosComplement(deltaBlue);

			// * Extend both base colors to 8 bits by copying the first 3
			// * bits to the end. For example if baseColor1R=0b11000 this is
			// * extended to 0b11000110=198
			subBlock2BaseR = (subBlock2BaseR << 3) | (subBlock2BaseR >> 2);
			subBlock2BaseG = (subBlock2BaseG << 3) | (subBlock2BaseG >> 2);
			subBlock2BaseB = (subBlock2BaseB << 3) | (subBlock2BaseB >> 2);

			subBlock1BaseR = (subBlock1BaseR << 3) | subBlock1BaseR >> 2;
			subBlock1BaseG = (subBlock1BaseG << 3) | subBlock1BaseG >> 2;
			subBlock1BaseB = (subBlock1BaseB << 3) | subBlock1BaseB >> 2;
		} else {
			// * Individual mode.
			// * Each base color is encoded with 4 bits per component
			subBlock1BaseR = Number((blockData >> 60n) & 0b1111n);
			subBlock2BaseR = Number((blockData >> 56n) & 0b1111n);
			subBlock1BaseG = Number((blockData >> 52n) & 0b1111n);
			subBlock2BaseG = Number((blockData >> 48n) & 0b1111n);
			subBlock1BaseB = Number((blockData >> 44n) & 0b1111n);
			subBlock2BaseB = Number((blockData >> 40n) & 0b1111n);

			// * Each base color is extended from 4 bits to 8 bits
			// * by copying to upper 4 bits of the color to the end.
			// * For example 0b1110 (14) would become 0b11101110 (238)
			subBlock1BaseR = subBlock1BaseR << 4 | subBlock1BaseR;
			subBlock2BaseR = subBlock2BaseR << 4 | subBlock2BaseR;
			subBlock1BaseG = subBlock1BaseG << 4 | subBlock1BaseG;
			subBlock2BaseG = subBlock2BaseG << 4 | subBlock2BaseG;
			subBlock1BaseB = subBlock1BaseB << 4 | subBlock1BaseB;
			subBlock2BaseB = subBlock2BaseB << 4 | subBlock2BaseB;
		}

		const decompressed = new StreamOut();

		const subBlock1ModifierTable = this.ModifierTables[tableCodeword1];
		const subBlock2ModifierTable = this.ModifierTables[tableCodeword2];

		// * Taking the color table idea from https://github.com/ShaneYCG/wfETC/blob/master/wfETC.c
		// * Color tables are not part of the ETC1 spec, but they make this easier.
		// * A color table is a table of pre-calculated RGB values for both subblock base
		// * colors using the subblocks modifier table. The color table is then used as a
		// * lookup table for the pixels
		const colorTables = [
			// * Subblock 1
			this.buildColorTable(subBlock1ModifierTable, subBlock1BaseR, subBlock1BaseG, subBlock1BaseB),

			// * Subblock 2
			this.buildColorTable(subBlock2ModifierTable, subBlock2BaseR, subBlock2BaseG, subBlock2BaseB)
		];

		const layout = this.subblockLayouts[flipBit];

		for (let i = 0; i < 4; i++) {
			// * "row" contains a list of 4 numbers, either 0 or 1.
			// * These indicate the subblock being targeted for a pixel.
			// * Value 0 is the first subblock, value 1 is the second
			const row = layout.slice(i * 4, i * 4 + 4);

			// * Blocks are 4x4 pixels, so process each row of 4 pixels
			// * at once
			const pixel1 = colorTables[row[0]][this.modifierIndex(pixelIndexBits, i)];
			const pixel2 = colorTables[row[1]][this.modifierIndex(pixelIndexBits, i + 4)];
			const pixel3 = colorTables[row[2]][this.modifierIndex(pixelIndexBits, i + 8)];
			const pixel4 = colorTables[row[3]][this.modifierIndex(pixelIndexBits, i + 12)];

			// * Adding a default 0xFF alpha byte
			decompressed.writeBytes(Buffer.from([...pixel1, 0xFF]));
			decompressed.writeBytes(Buffer.from([...pixel2, 0xFF]));
			decompressed.writeBytes(Buffer.from([...pixel3, 0xFF]));
			decompressed.writeBytes(Buffer.from([...pixel4, 0xFF]));
		}

		return decompressed.bytes();
	}

	/**
	 * Converts a signed 3-bit number in two's complement format.
	 *
	 * @param bits - The raw 3-bit value.
	 * @returns The signed integer value.
	 */
	private twosComplement(bits: number): number {
		if (bits & 4) {
			return bits - 8;
		} else {
			return bits;
		}
	}

	/**
	 * Build a color lookup table for a subblock.
	 *
	 * @param modifierTable - The modifier table to apply.
	 * @param red - Base red channel value.
	 * @param green - Base green channel value.
	 * @param blue - Base blue channel value.
	 * @returns An array of possible `[r,g,b]` colors for this subblock.
	 */
	private buildColorTable(modifierTable: number[], red: number, green: number, blue: number): number[][] {
		const colorTable: number[][] = [];

		for (const modifier of modifierTable) {
			colorTable.push([
				this.clamp(red + modifier, 0, 255),
				this.clamp(green + modifier, 0, 255),
				this.clamp(blue + modifier, 0, 255)
			]);
		}

		return colorTable;
	}

	/**
	 * Clamps a value to a given range.
	 *
	 * @param input - The value to clamp.
	 * @param min - The minimum allowed value.
	 * @param max - The maximum allowed value.
	 * @returns The clamped value.
	 */
	private clamp(input: number, min: number, max: number): number {
		return Math.min(Math.max(input, min), max);
	}

	/**
	 * Gets the modifier index for a pixel based on its index bits.
	 *
	 * @param pixelIndexBits - Packed pixel index bits from the ETC1 block.
	 * @param offset - Bit offset for the current pixel.
	 * @returns The index into the modifier table (0-3).
	 */
	private modifierIndex(pixelIndexBits: number, offset: number): number {
		// * Pixel index bits are made of 2 16 byte sections. The first
		// * section holds the MSBs of the indexes, and the second holds
		// * the LSBs of the indexes. Each pixel a-p is stored in order.
		// * For example pixel f is made of bits 21 (MSB) and 5 (LSB)
		const msb = (pixelIndexBits >> offset) & 0x1;
		const lsb = (pixelIndexBits >> (16 + offset)) & 0x1;

		return msb | lsb << 1;
	}

	/**
	 * Compresses raw RGBA pixel data into ETC1A4 format.
	 *
	 * @param decompressed - The raw RGBA pixel buffer (already scrambled).
	 * @returns A buffer of ETC1A4-compressed image data.
	 */
	private compress(decompressed: Buffer): Buffer {
		this.blocksPerRow = Math.floor(this.width / 4);
		this.blocksPerColumn = Math.floor(this.height / 4);

		const scrambled = this.scramble(decompressed);
		const imageSize = this.width * this.height;
		const compressed = new StreamOut(imageSize);

		for (let blockY = 0; blockY < this.blocksPerColumn; blockY++) {
			for (let blockX = 0; blockX < this.blocksPerRow; blockX++) {
				// * Gather the 4x4 block of RGBA pixels from the scrambled buffer for this block
				const blockPixels: Pixel[] = [];

				for (let pixelY = 0; pixelY < 4; pixelY++) {
					for (let pixelX = 0; pixelX < 4; pixelX++) {
						const x = blockX * 4 + pixelX;
						const y = blockY * 4 + pixelY;
						const i = (x + y * this.width) * 4;

						blockPixels.push({
							red: scrambled[i + 0],
							green: scrambled[i + 1],
							blue: scrambled[i + 2],
							alpha: scrambled[i + 3]
						});
					}
				}

				if (this.hasAlpha) {
					// * ETC1A4 alpha data is stored as 4 bits of alpha data per pixel
					const alphaBlock = Buffer.alloc(8);

					for (let pixelY = 0; pixelY < 4; pixelY++) {
						for (let pixelX = 0; pixelX < 4; pixelX++) {
							const pixel = blockPixels[pixelY * 4 + pixelX];
							const nibble = (pixel.alpha >> 4) & 0xF;
							const alphaIndex = (pixelX * 4 + pixelY) >> 1;
							const shift = (pixelY % 2) * 4;

							alphaBlock[alphaIndex] |= (nibble << shift) & 0xFF;
						}
					}

					compressed.writeBytes(alphaBlock);
				}

				const compressedColorBlock = this.compressColorBlock(blockPixels);

				compressed.writeBytes(compressedColorBlock);
			}
		}

		return compressed.bytes();
	}

	/**
	 * Compresses a single 4x4 block of RGBA pixels into an ETC1 color block.
	 *
	 * @param blockPixels - The 16 pixels of the block.
	 * @returns The compressed ETC1 color block.
	 */
	private compressColorBlock(blockPixels: Pixel[]): Buffer {
		const output = Buffer.alloc(8);

		let normalBlock: bigint;
		let normalError: number;
		let flippedBlock: bigint;
		let flippedError: number;

		if (this.quality === QualityLevel.Fast || this.quality === QualityLevel.FastPerceptual) {
			[normalBlock, normalError] = this.compressFast(blockPixels, 'horizontal');
			[flippedBlock, flippedError] = this.compressFast(blockPixels, 'vertical');
		} else {
			[normalBlock, normalError] = this.compressExhaustive(blockPixels, 'horizontal');
			[flippedBlock, flippedError] = this.compressExhaustive(blockPixels, 'vertical');
		}

		const block = normalError <= flippedError ? normalBlock : flippedBlock;

		output.writeBigUInt64LE(block);

		return output;
	}

	/**
	 * Computes the average color for each of the two subblocks given an orientation.
	 *
	 * @param pixels - The 16 pixels of the block.
	 * @param orientation - Whether the block is split horizontally (2x4) or vertically (4x2).
	 * @returns A tuple of `[subblock1Average, subblock2Average]`.
	 */
	private computeSubblockAverages(pixels: RGB[], orientation: SubblockOrientation): [ColorAverage, ColorAverage] {
		let r1 = 0;
		let g1 = 0;
		let b1 = 0;
		let r2 = 0;
		let g2 = 0;
		let b2 = 0;

		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 4; x++) {
				const pixel = pixels[y * 4 + x];
				const inFirstSubblock = orientation === 'horizontal' ? x < 2 : y < 2;

				if (inFirstSubblock) {
					r1 += pixel.red;
					g1 += pixel.green;
					b1 += pixel.blue;
				} else {
					r2 += pixel.red;
					g2 += pixel.green;
					b2 += pixel.blue;
				}
			}
		}

		return [
			{
				red: Math.fround(r1 / 8.0),
				green: Math.fround(g1 / 8.0),
				blue: Math.fround(b1 / 8.0)
			},
			{
				red: Math.fround(r2 / 8.0),
				green: Math.fround(g2 / 8.0),
				blue: Math.fround(b2 / 8.0)
			}
		];
	}

	/**
	 * Compresses a single subblock given a base color and a modifier table codeword.
	 *
	 * @param pixels - The 16 pixels of the block.
	 * @param orientation - Whether the block is split horizontally or vertically.
	 * @param offset - The starting x (horizontal) or y (vertical) coordinate of the subblock.
	 * @param color - The base color used to derive pixel approximations.
	 * @param tableCodeword - The modifier table index to use.
	 * @returns The accumulated error and packed pixel index bits for this subblock.
	 */
	private compressSubblock(pixels: RGB[], orientation: SubblockOrientation, offset: number, color: RGB, tableCodeword: number): SubblockCompressResult {
		let pixelIndexBitsMSB = 0;
		let pixelIndexBitsLSB = 0;
		let sumError = Math.fround(0);

		const redWeight = orientation === 'horizontal' ? PERCEPTUAL_WEIGHT_R_SQUARED : Math.fround(PERCEPTUAL_WEIGHT_R_SQUARED);
		const greenWeight = orientation === 'horizontal' ? PERCEPTUAL_WEIGHT_G_SQUARED : Math.fround(PERCEPTUAL_WEIGHT_G_SQUARED);
		const blueWeight = orientation === 'horizontal' ? PERCEPTUAL_WEIGHT_B_SQUARED : Math.fround(PERCEPTUAL_WEIGHT_B_SQUARED);

		const xStart = orientation === 'horizontal' ? offset : 0;
		const yStart = orientation === 'vertical' ? offset : 0;
		const xEnd = orientation === 'horizontal' ? offset + 2 : 4;
		const yEnd = orientation === 'vertical' ? offset + 2 : 4;

		const table = this.ModifierTables[tableCodeword];

		let i = 0;
		for (let x = xStart; x < xEnd; x++) {
			for (let y = yStart; y < yEnd; y++) {
				let err: number;
				let bestModifer = 0;
				let bestError = Math.fround(255 * 255 * 3 * 16);
				const pixel = pixels[y * 4 + x];

				for (let modifier = 0; modifier < 4; modifier++) {
					const approximationR = this.clamp(color.red + table[modifier], 0, 255);
					const approximationG = this.clamp(color.green + table[modifier], 0, 255);
					const approximationB = this.clamp(color.blue + table[modifier], 0, 255);

					if (this.quality === QualityLevel.MediumPerceptual || this.quality === QualityLevel.SlowPerceptual) {
						if (orientation === 'horizontal') {
							err = Math.fround(redWeight * (approximationR - pixel.red) ** 2 + Math.fround(greenWeight) * (approximationG - pixel.green) ** 2 + Math.fround(blueWeight) * (approximationB - pixel.blue) ** 2);
						} else {
							err = Math.fround(redWeight * (approximationR - pixel.red) ** 2 + greenWeight * (approximationG - pixel.green) ** 2 + blueWeight * (approximationB - pixel.blue) ** 2);
						}
					} else {
						err = (approximationR - pixel.red) ** 2 + (approximationG - pixel.green) ** 2 + (approximationB - pixel.blue) ** 2;
					}

					if (err < bestError) {
						bestError = err;
						bestModifer = modifier;
					}
				}

				pixelIndexBitsMSB |= (bestModifer >> 1) << i;
				pixelIndexBitsLSB |= (bestModifer & 1) << i;

				i++;

				sumError = Math.fround(sumError + bestError);
			}

			if (orientation === 'vertical') {
				i += 2;
			}
		}

		return {
			error: sumError,
			pixelIndexBitsMSB,
			pixelIndexBitsLSB
		};
	}

	/**
	 * Tries all 8 modifier tables for both subblocks and returns the best per-subblock result.
	 *
	 * @param pixels - The 16 pixels of the block.
	 * @param orientation - Whether the block is split horizontally or vertically.
	 * @param color1 - Base color for subblock 1.
	 * @param color2 - Base color for subblock 2.
	 * @returns A tuple of best results for `[subblock1, subblock2]`.
	 */
	private tryAllTables(pixels: RGB[], orientation: SubblockOrientation, color1: RGB, color2: RGB): [SubblockResult, SubblockResult] {
		const subblock1: SubblockResult = {
			bestError: Number.MAX_VALUE,
			bestTable: 0,
			pixelIndexBitsMSB: 0,
			pixelIndexBitsLSB: 0
		};

		const subblock2: SubblockResult = {
			bestError: Number.MAX_VALUE,
			bestTable: 0,
			pixelIndexBitsMSB: 0,
			pixelIndexBitsLSB: 0
		};

		for (let tableCodeword = 0; tableCodeword < this.ModifierTables.length; tableCodeword++) {
			const result1 = this.compressSubblock(pixels, orientation, 0, color1, tableCodeword);
			const result2 = this.compressSubblock(pixels, orientation, 2, color2, tableCodeword);

			if (result1.error < subblock1.bestError) {
				subblock1.bestError = result1.error;
				subblock1.pixelIndexBitsMSB = result1.pixelIndexBitsMSB;
				subblock1.pixelIndexBitsLSB = result1.pixelIndexBitsLSB;
				subblock1.bestTable = tableCodeword;
			}

			if (result2.error < subblock2.bestError) {
				subblock2.bestError = result2.error;
				subblock2.pixelIndexBitsMSB = result2.pixelIndexBitsMSB;
				subblock2.pixelIndexBitsLSB = result2.pixelIndexBitsLSB;
				subblock2.bestTable = tableCodeword;
			}
		}

		return [subblock1, subblock2];
	}

	/**
	 * Packs the encoded subblock data into a 64-bit ETC1 color block.
	 *
	 * @param color1 - The encoded base color for subblock 1.
	 * @param color2 - The encoded base color for subblock 2.
	 * @param subblock1 - The chosen result for subblock 1.
	 * @param subblock2 - The chosen result for subblock 2.
	 * @param diff - True if using differential mode, false for individual mode.
	 * @param flip - True if using vertical (4x2) split, false for horizontal (2x4).
	 * @returns The packed 64-bit block ready to be serialized.
	 */
	private packBlockData(color1: RGB, color2: RGB, subblock1: SubblockResult, subblock2: SubblockResult, diff: boolean, flip: boolean): bigint {
		let block = 0n;

		if (diff) {
			const dr = color2.red - color1.red;
			const dg = color2.green - color1.green;
			const db = color2.blue - color1.blue;

			block |= BigInt(color1.red) << 59n;
			block |= BigInt(dr & 0x7) << 56n;
			block |= BigInt(color1.green) << 51n;
			block |= BigInt(dg & 0x7) << 48n;
			block |= BigInt(color1.blue) << 43n;
			block |= BigInt(db & 0x7) << 40n;
		} else {
			block |= BigInt(color1.red) << 60n;
			block |= BigInt(color2.red) << 56n;
			block |= BigInt(color1.green) << 52n;
			block |= BigInt(color2.green) << 48n;
			block |= BigInt(color1.blue) << 44n;
			block |= BigInt(color2.blue) << 40n;
		}

		block |= BigInt(subblock1.bestTable) << 37n;
		block |= BigInt(subblock2.bestTable) << 34n;
		block |= (diff ? 1n : 0n) << 33n;
		block |= (flip ? 1n : 0n) << 32n;

		const shift = flip ? 2 : 8;
		const msb = (subblock1.pixelIndexBitsMSB | (subblock2.pixelIndexBitsMSB << shift)) & 0xFFFF;
		const lsb = (subblock1.pixelIndexBitsLSB | (subblock2.pixelIndexBitsLSB << shift)) & 0xFFFF;

		block |= BigInt(msb) << 16n;
		block |= BigInt(lsb);

		return block;
	}

	/**
	 * Compresses a block for a given orientation using a fast single-pass approach.
	 * Used for {@link QualityLevel.Fast} and {@link QualityLevel.FastPerceptual} quality levels.
	 *
	 * @param pixels - The 16 pixels of the block.
	 * @param orientation - Whether the block is split horizontally or vertically.
	 * @returns A tuple of `[packedBlock, totalError]` for the mode used.
	 */
	private compressFast(pixels: RGB[], orientation: SubblockOrientation): [bigint, number] {
		const flip = orientation === 'vertical';

		const [averageColor1, averageColor2] = this.computeSubblockAverages(pixels, orientation);

		const encodedColor1 = {
			red: Math.round(31.0 * averageColor1.red / 255.0),
			green: Math.round(31.0 * averageColor1.green / 255.0),
			blue: Math.round(31.0 * averageColor1.blue / 255.0)
		};

		const encodedColor2 = {
			red: Math.round(31.0 * averageColor2.red / 255.0),
			green: Math.round(31.0 * averageColor2.green / 255.0),
			blue: Math.round(31.0 * averageColor2.blue / 255.0)
		};

		const colorDelta = {
			red: encodedColor2.red - encodedColor1.red,
			green: encodedColor2.green - encodedColor1.green,
			blue: encodedColor2.blue - encodedColor1.blue
		};

		const quantizedColor1 = {
			red: 0xFF,
			green: 0xFF,
			blue: 0xFF
		};

		const quantizedColor2 = {
			red: 0xFF,
			green: 0xFF,
			blue: 0xFF
		};

		const useDifferentialMode = colorDelta.red >= FAST_SCAN_MIN && colorDelta.red <= FAST_SCAN_MAX && colorDelta.green >= FAST_SCAN_MIN && colorDelta.green <= FAST_SCAN_MAX && colorDelta.blue >= FAST_SCAN_MIN && colorDelta.blue <= FAST_SCAN_MAX;

		if (useDifferentialMode) {
			quantizedColor1.red = encodedColor1.red << 3 | (encodedColor1.red >> 2);
			quantizedColor1.green = encodedColor1.green << 3 | (encodedColor1.green >> 2);
			quantizedColor1.blue = encodedColor1.blue << 3 | (encodedColor1.blue >> 2);

			quantizedColor2.red = encodedColor2.red << 3 | (encodedColor2.red >> 2);
			quantizedColor2.green = encodedColor2.green << 3 | (encodedColor2.green >> 2);
			quantizedColor2.blue = encodedColor2.blue << 3 | (encodedColor2.blue >> 2);
		} else {
			const roundingTolerance = Math.fround(0.0001);

			encodedColor1.red = Math.trunc(Math.fround(averageColor1.red) / 17.0 + 0.5 + roundingTolerance);
			encodedColor1.green = Math.trunc(Math.fround(averageColor1.green) / 17.0 + 0.5 + roundingTolerance);
			encodedColor1.blue = Math.trunc(Math.fround(averageColor1.blue) / 17.0 + 0.5 + roundingTolerance);

			encodedColor2.red = Math.trunc(Math.fround(averageColor2.red) / 17.0 + 0.5 + roundingTolerance);
			encodedColor2.green = Math.trunc(Math.fround(averageColor2.green) / 17.0 + 0.5 + roundingTolerance);
			encodedColor2.blue = Math.trunc(Math.fround(averageColor2.blue) / 17.0 + 0.5 + roundingTolerance);

			quantizedColor1.red = encodedColor1.red << 4 | encodedColor1.red;
			quantizedColor1.green = encodedColor1.green << 4 | encodedColor1.green;
			quantizedColor1.blue = encodedColor1.blue << 4 | encodedColor1.blue;

			quantizedColor2.red = encodedColor2.red << 4 | encodedColor2.red;
			quantizedColor2.green = encodedColor2.green << 4 | encodedColor2.green;
			quantizedColor2.blue = encodedColor2.blue << 4 | encodedColor2.blue;
		}

		const [subblock1, subblock2] = this.tryAllTables(pixels, orientation, quantizedColor1, quantizedColor2);
		const bestBlock = this.packBlockData(encodedColor1, encodedColor2, subblock1, subblock2, useDifferentialMode, flip);
		const bestError = subblock1.bestError + subblock2.bestError;

		return [bestBlock, bestError];
	}

	/**
	 * Compresses a block for a given orientation using exhaustive search, trying both differential and individual modes.
	 * Used for {@link QualityLevel.Medium}, {@link QualityLevel.MediumPerceptual}, {@link QualityLevel.Slow}, and {@link QualityLevel.SlowPerceptual} quality levels.
	 *
	 * @param pixels - The 16 pixels of the block.
	 * @param orientation - Whether the block is split horizontally or vertically.
	 * @returns A tuple of `[packedBlock, totalError]` for the best mode found.
	 */
	private compressExhaustive(pixels: RGB[], orientation: SubblockOrientation): [bigint, number] {
		const flip = orientation === 'vertical';
		const isMedium = this.quality === QualityLevel.Medium || this.quality === QualityLevel.MediumPerceptual;
		const isSlow = this.quality === QualityLevel.Slow || this.quality === QualityLevel.SlowPerceptual;
		let bestBlock = 0n;
		let bestError = isMedium ? 255 * 255 * 16 * 3 : 255 * 255 * 8 * 3;

		const [averageColor1, averageColor2] = this.computeSubblockAverages(pixels, orientation);

		const encodedColor1 = {
			red: Math.round(31.0 * averageColor1.red / 255.0),
			green: Math.round(31.0 * averageColor1.green / 255.0),
			blue: Math.round(31.0 * averageColor1.blue / 255.0)
		};

		const encodedColor2 = {
			red: Math.round(31.0 * averageColor2.red / 255.0),
			green: Math.round(31.0 * averageColor2.green / 255.0),
			blue: Math.round(31.0 * averageColor2.blue / 255.0)
		};

		const colorDelta = {
			red: encodedColor2.red - encodedColor1.red,
			green: encodedColor2.green - encodedColor1.green,
			blue: encodedColor2.blue - encodedColor1.blue
		};

		const tryMin = isMedium ? MEDIUM_TRY_MIN : SLOW_TRY_MIN;
		const tryMax = isMedium ? MEDIUM_TRY_MAX : SLOW_TRY_MAX;
		const scanRange = isMedium ? MEDIUM_SCAN_RANGE : SLOW_SCAN_RANGE;
		const scanMin = isMedium ? MEDIUM_SCAN_MIN : SLOW_SCAN_MIN;
		const scanMax = isMedium ? MEDIUM_SCAN_MAX : SLOW_SCAN_MAX;
		const scanOffset = isMedium ? MEDIUM_SCAN_OFFSET : SLOW_SCAN_OFFSET;
		const useDifferentialMode = colorDelta.red >= tryMin && colorDelta.red <= tryMax && colorDelta.green >= tryMin && colorDelta.green <= tryMax && colorDelta.blue >= tryMin && colorDelta.blue <= tryMax;

		if (useDifferentialMode) {
			// * Differential mode
			const baseColor1 = { ...encodedColor1 };
			const baseColor2 = { ...encodedColor2 };

			const subblockError1 = new Int32Array3D(scanRange, scanRange, scanRange);
			const subblockError2 = new Int32Array3D(scanRange, scanRange, scanRange);

			const quantizedColor1 = {
				red: 0xFF,
				green: 0xFF,
				blue: 0xFF
			};

			const quantizedColor2 = {
				red: 0xFF,
				green: 0xFF,
				blue: 0xFF
			};

			const candidateColor1 = {
				red: 0xFF,
				green: 0xFF,
				blue: 0xFF
			};

			const candidateColor2 = {
				red: 0xFF,
				green: 0xFF,
				blue: 0xFF
			};

			for (let deltaRed1 = scanMin; deltaRed1 <= scanMax; deltaRed1++) {
				for (let deltaGreen1 = scanMin; deltaGreen1 <= scanMax; deltaGreen1++) {
					for (let deltaBlue1 = scanMin; deltaBlue1 <= scanMax; deltaBlue1++) {
						candidateColor1.red = this.clamp(baseColor1.red + deltaRed1, 0, 31);
						candidateColor1.green = this.clamp(baseColor1.green + deltaGreen1, 0, 31);
						candidateColor1.blue = this.clamp(baseColor1.blue + deltaBlue1, 0, 31);

						quantizedColor1.red = candidateColor1.red << 3 | (candidateColor1.red >> 2);
						quantizedColor1.green = candidateColor1.green << 3 | (candidateColor1.green >> 2);
						quantizedColor1.blue = candidateColor1.blue << 3 | (candidateColor1.blue >> 2);

						candidateColor2.red = this.clamp(baseColor2.red + deltaRed1, 0, 31);
						candidateColor2.green = this.clamp(baseColor2.green + deltaGreen1, 0, 31);
						candidateColor2.blue = this.clamp(baseColor2.blue + deltaBlue1, 0, 31);

						quantizedColor2.red = candidateColor2.red << 3 | (candidateColor2.red >> 2);
						quantizedColor2.green = candidateColor2.green << 3 | (candidateColor2.green >> 2);
						quantizedColor2.blue = candidateColor2.blue << 3 | (candidateColor2.blue >> 2);

						const [subblock1, subblock2] = this.tryAllTables(pixels, orientation, quantizedColor1, quantizedColor2);

						subblockError1.set(deltaRed1 + scanOffset, deltaGreen1 + scanOffset, deltaBlue1 + scanOffset, subblock1.bestError);
						subblockError2.set(deltaRed1 + scanOffset, deltaGreen1 + scanOffset, deltaBlue1 + scanOffset, subblock2.bestError);
					}
				}
			}

			let bestDiffError = 255 * 255 * 3 * 8 * 2;

			for (let deltaRed1 = scanMin; deltaRed1 <= scanMax; deltaRed1++) {
				for (let deltaGreen1 = scanMin; deltaGreen1 <= scanMax; deltaGreen1++) {
					for (let deltaBlue1 = scanMin; deltaBlue1 <= scanMax; deltaBlue1++) {
						for (let deltaRed2 = scanMin; deltaRed2 <= scanMax; deltaRed2++) {
							for (let deltaGreen2 = scanMin; deltaGreen2 <= scanMax; deltaGreen2++) {
								for (let deltaBlue2 = scanMin; deltaBlue2 <= scanMax; deltaBlue2++) {
									candidateColor1.red = this.clamp(baseColor1.red + deltaRed1, 0, 31);
									candidateColor1.green = this.clamp(baseColor1.green + deltaGreen1, 0, 31);
									candidateColor1.blue = this.clamp(baseColor1.blue + deltaBlue1, 0, 31);
									candidateColor2.red = this.clamp(baseColor2.red + deltaRed2, 0, 31);
									candidateColor2.green = this.clamp(baseColor2.green + deltaGreen2, 0, 31);
									candidateColor2.blue = this.clamp(baseColor2.blue + deltaBlue2, 0, 31);

									colorDelta.red = candidateColor2.red - candidateColor1.red;
									colorDelta.green = candidateColor2.green - candidateColor1.green;
									colorDelta.blue = candidateColor2.blue - candidateColor1.blue;

									if ((colorDelta.red >= -4) && (colorDelta.red <= 3) && (colorDelta.green >= -4) && (colorDelta.green <= 3) && (colorDelta.blue >= -4) && (colorDelta.blue <= 3)) {
										const combinedError = subblockError1.get(deltaRed1 + scanOffset, deltaGreen1 + scanOffset, deltaBlue1 + scanOffset) + subblockError2.get(deltaRed2 + scanOffset, deltaGreen2 + scanOffset, deltaBlue2 + scanOffset);

										if (combinedError < bestDiffError) {
											bestDiffError = combinedError;

											encodedColor1.red = candidateColor1.red;
											encodedColor1.green = candidateColor1.green;
											encodedColor1.blue = candidateColor1.blue;
											encodedColor2.red = candidateColor2.red;
											encodedColor2.green = candidateColor2.green;
											encodedColor2.blue = candidateColor2.blue;
										}
									}
								}
							}
						}
					}
				}
			}

			if (bestDiffError < bestError) {
				bestError = bestDiffError;

				quantizedColor1.red = encodedColor1.red << 3 | (encodedColor1.red >> 2);
				quantizedColor1.green = encodedColor1.green << 3 | (encodedColor1.green >> 2);
				quantizedColor1.blue = encodedColor1.blue << 3 | (encodedColor1.blue >> 2);
				quantizedColor2.red = encodedColor2.red << 3 | (encodedColor2.red >> 2);
				quantizedColor2.green = encodedColor2.green << 3 | (encodedColor2.green >> 2);
				quantizedColor2.blue = encodedColor2.blue << 3 | (encodedColor2.blue >> 2);

				const [subblock1, subblock2] = this.tryAllTables(pixels, orientation, quantizedColor1, quantizedColor2);

				bestBlock = this.packBlockData(encodedColor1, encodedColor2, subblock1, subblock2, true, flip);
			}
		}

		if (isSlow || (isMedium && !useDifferentialMode)) {
			// * Individual mode
			// * Always run in slow mode, but only conditionally in medium mode

			const quantizedColor1 = {
				red: 0xFF,
				green: 0xFF,
				blue: 0xFF
			};

			const quantizedColor2 = {
				red: 0xFF,
				green: 0xFF,
				blue: 0xFF
			};

			const bestColor1 = {
				red: 0,
				green: 0,
				blue: 0
			};

			const bestColor2 = {
				red: 0,
				green: 0,
				blue: 0
			};

			let bestError1 = 255 * 255 * 3 * 8;
			let bestError2 = 255 * 255 * 3 * 8;

			for (let redIndex = 0; redIndex < 15; redIndex++) {
				for (let greenIndex = 0; greenIndex < 15; greenIndex++) {
					for (let blueIndex = 0; blueIndex < 15; blueIndex++) {
						quantizedColor1.red = (redIndex << 4) | redIndex;
						quantizedColor1.green = (greenIndex << 4) | greenIndex;
						quantizedColor1.blue = (blueIndex << 4) | blueIndex;

						quantizedColor2.red = (redIndex << 4) | redIndex;
						quantizedColor2.green = (greenIndex << 4) | greenIndex;
						quantizedColor2.blue = (blueIndex << 4) | blueIndex;

						const [subblock1, subblock2] = this.tryAllTables(pixels, orientation, quantizedColor1, quantizedColor2);

						if (subblock1.bestError < bestError1) {
							bestColor1.red = redIndex;
							bestColor1.green = greenIndex;
							bestColor1.blue = blueIndex;
							bestError1 = subblock1.bestError;
						}

						if (subblock2.bestError < bestError2) {
							bestColor2.red = redIndex;
							bestColor2.green = greenIndex;
							bestColor2.blue = blueIndex;
							bestError2 = subblock2.bestError;
						}
					}
				}
			}

			const totalIndividualError = bestError1 + bestError2;

			if (totalIndividualError < bestError) {
				bestError = totalIndividualError;

				encodedColor1.red = bestColor1.red;
				encodedColor1.green = bestColor1.green;
				encodedColor1.blue = bestColor1.blue;
				encodedColor2.red = bestColor2.red;
				encodedColor2.green = bestColor2.green;
				encodedColor2.blue = bestColor2.blue;

				quantizedColor1.red = (encodedColor1.red << 4) | encodedColor1.red;
				quantizedColor1.green = (encodedColor1.green << 4) | encodedColor1.green;
				quantizedColor1.blue = (encodedColor1.blue << 4) | encodedColor1.blue;
				quantizedColor2.red = (encodedColor2.red << 4) | encodedColor2.red;
				quantizedColor2.green = (encodedColor2.green << 4) | encodedColor2.green;
				quantizedColor2.blue = (encodedColor2.blue << 4) | encodedColor2.blue;

				const [subblock1, subblock2] = this.tryAllTables(pixels, orientation, quantizedColor1, quantizedColor2);

				bestBlock = this.packBlockData(encodedColor1, encodedColor2, subblock1, subblock2, false, flip);
			}
		}

		return [bestBlock, bestError];
	}

	/**
	 * Descramble tile order into the correct raster order.
	 *
	 * @param scrambled - The scrambled decompressed buffer.
	 * @returns A descrambled buffer in normal raster order.
	 */
	private descramble(scrambled: Buffer): Buffer {
		// TODO - Add comments and rename/rework this. It's not super clear how the scrambling works
		const descrambled = Buffer.alloc(scrambled.length);
		const orderTable = this.getTileScrambledOrder();

		let i = 0;
		for (let tileY = 0; tileY < this.blocksPerColumn; tileY++) {
			for (let tileX = 0; tileX < this.blocksPerRow; tileX++) {
				const TX = orderTable[i] % this.blocksPerRow;
				const TY = Math.floor((orderTable[i] - TX) / this.blocksPerRow);

				for (let y = 0; y < 4; y++) {
					for (let x = 0; x < 4; x++) {
						const dataOffset   = ((TX * 4) + x + ((TY * 4 + y) * this.width)) * 4;
						const outputOffset = ((tileX * 4) + x + ((tileY * 4 + y) * this.width)) * 4;

						descrambled.fill(scrambled.subarray(dataOffset, dataOffset + 4), outputOffset, outputOffset + 4);
					}
				}

				i += 1;
			}
		}

		return descrambled;
	}

	/**
	 * Descramble tile order into the correct raster order.
	 *
	 * @param descrambled - The scrambled compressed buffer.
	 * @returns A scrambled buffer in Z-order.
	 */
	private scramble(descrambled: Buffer): Buffer {
		// TODO - Add comments and rename/rework this. It's not super clear how the scrambling works
		const scrambled = Buffer.alloc(descrambled.length);
		const orderTable = this.getTileScrambledOrder();

		let i = 0;
		for (let tileY = 0; tileY < this.blocksPerColumn; tileY++) {
			for (let tileX = 0; tileX < this.blocksPerRow; tileX++) {
				const TX = orderTable[i] % this.blocksPerRow;
				const TY = Math.floor((orderTable[i] - TX) / this.blocksPerRow);

				for (let y = 0; y < 4; y++) {
					for (let x = 0; x < 4; x++) {
						const dataOffset   = ((TX * 4) + x + ((TY * 4 + y) * this.width)) * 4;
						const outputOffset = ((tileX * 4) + x + ((tileY * 4 + y) * this.width)) * 4;

						scrambled.fill(descrambled.subarray(outputOffset, outputOffset + 4), dataOffset, dataOffset + 4);
					}
				}

				i += 1;
			}
		}

		return scrambled;
	}

	/**
	 * Generates the tile scrambling order used by Nintendo's ETC1A4.
	 *
	 * @returns An array describing the tile reordering pattern.
	 */
	private getTileScrambledOrder(): number[] {
		// TODO - Add comments and rename/rework this. It's not super clear how the tile order is calculated
		const orderTable = new Array(this.blocksPerRow * this.blocksPerColumn);
		let baseAccumulator = 0;
		let rowAccumulator = 0;
		let baseNumber = 0;
		let rowNumber = 0;

		for (let tile = 0; tile < orderTable.length; tile++) {
			if ((tile % this.blocksPerRow == 0) && tile > 0) {
				if (rowAccumulator < 1) {
					rowAccumulator += 1;
					rowNumber += 2;
					baseNumber = rowNumber;
				} else {
					rowAccumulator = 0;
					baseNumber -= 2;
					rowNumber = baseNumber;
				}
			}

			orderTable[tile] = baseNumber;

			if (baseAccumulator < 1) {
				baseAccumulator += 1;
				baseNumber += 1;
			} else {
				baseAccumulator = 0;
				baseNumber += 3;
			}
		}

		return orderTable;
	}

	/**
	 * Exports pixels in RGBA format.
	 *
	 * @returns A buffer containing `[r,g,b,a]` pixel data.
	 */
	public pixelsRGBA(): Buffer {
		const stream = new StreamOut();

		for (const pixel of this.pixels) {
			stream.writeBytes(Buffer.from([
				pixel.red,
				pixel.green,
				pixel.blue,
				pixel.alpha
			]));
		}

		return stream.bytes();
	}

	/**
	 * Encodes a buffer containing `[r,g,b,a]` pixel data into ETC1A4.
	 *
	 * @returns A buffer containing ETC1A4 texture data.
	 */
	public encodeFromRGBA(pixels: Buffer): Buffer {
		return this.compress(pixels);
	}
}
