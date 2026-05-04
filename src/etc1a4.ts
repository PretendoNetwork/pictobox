// * Based on:
// * - https://registry.khronos.org/DataFormat/specs/1.1/dataformat.1.1.html#ETC1
// * - https://github.com/PretendoNetwork/ita-bag/blob/3a975effeaed54d8cef89afc1f9e9a236254b848/etc1.js
// * - https://github.com/ShaneYCG/wfETC/blob/443281432c4afe9e90f1632cd43229e623d28632/wfETC.c

import StreamIn from '@/stream-in';
import StreamOut from '@/stream-out';

type Pixel = {
	red: number;
	green: number;
	blue: number;
	alpha: number;
};

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
				this.clampTo255(red + modifier),
				this.clampTo255(green + modifier),
				this.clampTo255(blue + modifier)
			]);
		}

		return colorTable;
	}

	/**
	 * Clamps a value to the 0-255 range.
	 *
	 * @param input - The value of clamp.
	 * @returns The clamped value.
	 */
	private clampTo255(input: number): number {
		return Math.min(Math.max(input, 0), 255);
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

				for (let pixelX = 0; pixelX < 4; pixelX++) {
					for (let pixelY = 0; pixelY < 4; pixelY++) {
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

				const compressedColorBlock = this.compressColorBlock(blockPixels);

				if (this.hasAlpha) {
					// * ETC1A4 alpha data is stored as 4 bits of alpha data per pixel
					const alphaBlock = Buffer.alloc(8);

					for (let pixelX = 0; pixelX < 4; pixelX++) {
						for (let pixelY = 0; pixelY < 4; pixelY++) {
							const pixel = blockPixels[pixelX * 4 + pixelY];
							const nibble = (pixel.alpha >> 4) & 0xF;
							const alphaIndex = (pixelX * 4 + pixelY) >> 1;
							const shift = (pixelY % 2) * 4;

							alphaBlock[alphaIndex] |= (nibble << shift) & 0xFF;
						}
					}

					compressed.writeBytes(alphaBlock);
				}

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
		// TODO - This does not optimize for color accuracy, it just encodes the data as fast as possible. Optimize for color loss
		const flipBit = 0;
		const diffBit = 0;

		// * Just use the average of the pixels to be the base color because fuck it right now.
		// * I just want this to work, color loss be damned right now
		let subBlock1SumR = 0;
		let subBlock1SumG = 0;
		let subBlock1SumB = 0;
		let subBlock2SumR = 0;
		let subBlock2SumG = 0;
		let subBlock2SumB = 0;

		for (let pixelY = 0; pixelY < 4; pixelY++) {
			for (let pixelX = 0; pixelX < 2; pixelX++) {
				const pixel = blockPixels[pixelX * 4 + pixelY];
				subBlock1SumR += pixel.red;
				subBlock1SumG += pixel.green;
				subBlock1SumB += pixel.blue;
			}

			for (let pixelX = 2; pixelX < 4; pixelX++) {
				const pixel = blockPixels[pixelX * 4 + pixelY];
				subBlock2SumR += pixel.red;
				subBlock2SumG += pixel.green;
				subBlock2SumB += pixel.blue;
			}
		}

		const subblockPixelCount = blockPixels.length / 2;
		const subBlock1BaseR = (Math.round(subBlock1SumR / subblockPixelCount) >> 4) & 0xF;
		const subBlock1BaseG = (Math.round(subBlock1SumG / subblockPixelCount) >> 4) & 0xF;
		const subBlock1BaseB = (Math.round(subBlock1SumB / subblockPixelCount) >> 4) & 0xF;
		const subBlock2BaseR = (Math.round(subBlock2SumR / subblockPixelCount) >> 4) & 0xF;
		const subBlock2BaseG = (Math.round(subBlock2SumG / subblockPixelCount) >> 4) & 0xF;
		const subBlock2BaseB = (Math.round(subBlock2SumB / subblockPixelCount) >> 4) & 0xF;

		const subBlock1BaseR8 = (subBlock1BaseR << 4) | subBlock1BaseR;
		const subBlock1BaseG8 = (subBlock1BaseG << 4) | subBlock1BaseG;
		const subBlock1BaseB8 = (subBlock1BaseB << 4) | subBlock1BaseB;
		const subBlock2BaseR8 = (subBlock2BaseR << 4) | subBlock2BaseR;
		const subBlock2BaseG8 = (subBlock2BaseG << 4) | subBlock2BaseG;
		const subBlock2BaseB8 = (subBlock2BaseB << 4) | subBlock2BaseB;

		const subBlock1 = this.pickBestTable(blockPixels, subBlock1BaseR8, subBlock1BaseG8, subBlock1BaseB8, 0, 2);
		const subBlock2 = this.pickBestTable(blockPixels, subBlock2BaseR8, subBlock2BaseG8, subBlock2BaseB8, 2, 4);

		let pixelIndexBits = 0;

		for (let pixelX = 0; pixelX < 4; pixelX++) {
			for (let pixelY = 0; pixelY < 4; pixelY++) {
				const indices = pixelX < 2 ? subBlock1.indices : subBlock2.indices;
				const modifierIndex = indices[pixelX * 4 + pixelY];

				const msb = modifierIndex & 0x1;
				const lsb = (modifierIndex >> 1) & 0x1;
				const offset = pixelY + pixelX * 4;

				pixelIndexBits |= msb << offset;
				pixelIndexBits |= lsb << (offset + 16);
			}
		}

		const colorBlock = Buffer.alloc(8);
		let blockData = 0n;

		blockData |= BigInt(subBlock1BaseR) << 60n;
		blockData |= BigInt(subBlock2BaseR) << 56n;
		blockData |= BigInt(subBlock1BaseG) << 52n;
		blockData |= BigInt(subBlock2BaseG) << 48n;
		blockData |= BigInt(subBlock1BaseB) << 44n;
		blockData |= BigInt(subBlock2BaseB) << 40n;
		blockData |= BigInt(subBlock1.tableCodeword) << 37n;
		blockData |= BigInt(subBlock2.tableCodeword) << 34n;
		blockData |= BigInt(diffBit) << 33n;
		blockData |= BigInt(flipBit) << 32n;
		blockData |= BigInt(pixelIndexBits >>> 0);

		colorBlock.writeBigUInt64LE(blockData);

		return colorBlock;
	}

	/**
	 * Finds the modifier table and pixel modifiers for a given block
	 *
	 * @param blockPixels - All 16 pixels of the block.
	 * @param baseR - 8-bit red base color.
	 * @param baseG - 8-bit green base color.
	 * @param baseB - 8-bit blue base color.
	 * @param pixelXStart - First pixelX column of the subblock (inclusive).
	 * @param pixelXEnd - Last pixelX column of the subblock (exclusive).
	 * @returns The best table codeword and the per-pixel indices.
	 */
	private pickBestTable(blockPixels: Pixel[], baseR: number, baseG: number, baseB: number, pixelXStart: number, pixelXEnd: number): { tableCodeword: number; indices: number[] } {
		let bestTableCodeword = 0;
		let bestTotalError = Infinity;
		let bestIndices: number[] = new Array(16).fill(0);

		for (let tableCodeword = 0; tableCodeword < 8; tableCodeword++) {
			const modifierTable = this.ModifierTables[tableCodeword];
			const indices: number[] = new Array(16).fill(0);
			let totalError = 0;

			for (let pixelX = pixelXStart; pixelX < pixelXEnd; pixelX++) {
				for (let pixelY = 0; pixelY < 4; pixelY++) {
					const pixel = blockPixels[pixelX * 4 + pixelY];
					let bestModifierIndex = 0;
					let bestPixelError = Infinity;

					for (let modifierIndex = 0; modifierIndex < 4; modifierIndex++) {
						const modifier = modifierTable[modifierIndex];
						const red = this.clampTo255(baseR + modifier);
						const green = this.clampTo255(baseG + modifier);
						const blue = this.clampTo255(baseB + modifier);

						const deltaRed = red - pixel.red;
						const deltaGreen = green - pixel.green;
						const deltaBlue = blue - pixel.blue;
						const error = deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue;

						if (error < bestPixelError) {
							bestPixelError = error;
							bestModifierIndex = modifierIndex;
						}
					}

					indices[pixelX * 4 + pixelY] = bestModifierIndex;
					totalError += bestPixelError;
				}
			}

			if (totalError < bestTotalError) {
				bestTotalError = totalError;
				bestTableCodeword = tableCodeword;
				bestIndices = indices;
			}
		}

		return {
			tableCodeword: bestTableCodeword,
			indices: bestIndices
		};
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
