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

// * ETC1A4 is an extension of ETC1 made by Nintendo.
// * This extension makes the following changes:
// * - An additional alpha block can optionally be prepended to a color block
// * - Blocks are scrambled. See https://www.3dbrew.org/wiki/SMDH#Icon_graphics for details
export default class ETC1A4 {
	private readStream: StreamIn;

	public width: number;
	public height: number;
	private hasAlpha: boolean;
	private blocksPerRow: number;
	private blocksPerColumn: number;
	public pixels: Pixel[];

	private ModifierTables = [
		// * Table is reordered in oder to use the pixel
		// * index bits as a decimal index into the table
		[2 , 8  , -2 , -8  ],
		[5 , 17 , -5 , -17 ],
		[9 , 29 , -9 , -29 ],
		[13, 42 , -13, -42 ],
		[18, 60 , -18, -60 ],
		[24, 80 , -24, -80 ],
		[33, 106, -33, -106],
		[47, 183, -47, -183]
	];

	private subblockLayouts = [
		[ // * Flip bit is 0, the block is divided into two 2x4 subblocks side-by-side
			0, 0, 1, 1,
			0, 0, 1, 1,
			0, 0, 1, 1,
			0, 0, 1, 1,
		],
		[ // * Flip bit is 1, the block is divided into two 4x2 subblocks on top of each other
			0, 0, 0, 0,
			0, 0, 0, 0,
			1, 1, 1, 1,
			1, 1, 1, 1,
		]
	];

	public parseFromBuffer(buffer: Buffer): void {
		this.readStream = new StreamIn(buffer);
		this.parse();
	}

	private parse(): void {
		this.pixels = [];

		const decompressed = this.decompress();
		const descrambled = this.descramble(decompressed);

		for (let i = 0; i < descrambled.length; i+=4) {
			const [red, green, blue, alpha] = descrambled.subarray(i, i+4);

			this.pixels.push({ red, green, blue, alpha });
		}
	}

	private decompress(): Buffer {
		this.blocksPerRow = Math.floor(this.width / 4);
		this.blocksPerColumn = Math.floor(this.height / 4);

		const imageSize = this.width * this.height;
		const blockSize = imageSize / (this.blocksPerRow * this.blocksPerColumn);
		const decompressed = Buffer.alloc(imageSize * 4);

		// * If the determined block size is 16, assume the blocks contain alpha data
		// * (8 byte alpha block, 8 byte color block)
		this.hasAlpha = blockSize === 16;

		for (let blockY = 0; blockY < this.blocksPerRow; blockY++) {
			for (let blockX = 0; blockX < this.blocksPerColumn; blockX++) {
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
			const pixel2 = colorTables[row[1]][this.modifierIndex(pixelIndexBits, i+4)];
			const pixel3 = colorTables[row[2]][this.modifierIndex(pixelIndexBits, i+8)];
			const pixel4 = colorTables[row[3]][this.modifierIndex(pixelIndexBits, i+12)];

			// * Adding a default 0xFF alpha byte
			decompressed.writeBytes(Buffer.from([...pixel1, 0xFF]));
			decompressed.writeBytes(Buffer.from([...pixel2, 0xFF]));
			decompressed.writeBytes(Buffer.from([...pixel3, 0xFF]));
			decompressed.writeBytes(Buffer.from([...pixel4, 0xFF]));
		}

		return decompressed.bytes();
	}

	private twosComplement(bits: number): number {
		if (bits & 4) {
			return bits - 8;
		} else {
			return bits;
		}
	}

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

	private clampTo255(input: number): number {
		return Math.min(Math.max(input, 0), 255);
	}

	private modifierIndex(pixelIndexBits: number, offset: number): number {
		// * Pixel index bits are made of 2 16 byte sections. The first
		// * section holds the MSBs of the indexes, and the second holds
		// * the LSBs of the indexes. Each pixel a-p is stored in order.
		// * For example pixel f is made of bits 21 (MSB) and 5 (LSB)
		const msb = (pixelIndexBits >> offset) & 0x1;
		const lsb = (pixelIndexBits >> (16+offset)) & 0x1;

		return msb | lsb << 1;
	}

	private descramble(scrambled: Buffer): Buffer {
		// TODO - Add comments and rename/rework this. It's not super clear how the scrambling works
		const descrambled = Buffer.alloc(scrambled.length);
		const orderTable = this.getTileScrambledOrder();

		let i = 0;
		for (let tileY = 0; tileY < this.blocksPerRow; tileY++) {
			for (let tileX = 0; tileX < this.blocksPerColumn; tileX++) {
				const TX = orderTable[i] % this.blocksPerRow;
				const TY = Math.floor((orderTable[i] - TX) / this.blocksPerRow);

				for (let y = 0; y < 4; y++) {
					for (let x = 0; x < 4; x++) {
						const dataOffset   = ((TX * 4) + x + ((TY * 4 + y) * this.width)) * 4;
						const outputOffset = ((tileX * 4) + x + ((tileY * 4 + y) * this.width)) * 4;

						descrambled.fill(scrambled.subarray(dataOffset, dataOffset + 4), outputOffset, outputOffset+4);
					}
				}

				i += 1;
			}
		}

		return descrambled;
	}

	private getTileScrambledOrder(): number[] {
		// TODO - Add comments and rename/rework this. It's not super clear how the tile order is calculated
		const orderTable = new Array(this.blocksPerRow * this.blocksPerColumn);
		let baseAccumulator = 0;
		let rowAccumulator = 0;
		let baseNumber = 0;
		let rowNumber = 0;

		for (let tile = 0; tile < orderTable.length; tile++) {
			if ((tile % this.blocksPerRow == 0) && tile > 0) {
				if( rowAccumulator < 1) {
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
}