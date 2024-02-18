// * Based on:
// * - https://github.com/PretendoNetwork/ita-bag/blob/3a975effeaed54d8cef89afc1f9e9a236254b848/rgb565.js

type Pixel = {
	red: number;
	green: number;
	blue: number;
	alpha: number;
};

// * RGB565A4 is a variant of RGB565 made by Nintendo.
// * This variant makes the following changes:
// * - Following the RGB565 color data, an additional chunk of alpha data may optionally be present
// * - Blocks are z-order scrambled. See https://www.3dbrew.org/wiki/SMDH#Icon_graphics for details
export default class RGB565A4 {
	public width: number;
	public height: number;
	private pixelData: Pixel[] = [];

	// * https://en.wikipedia.org/wiki/Z-order_curve
	// * https://www.3dbrew.org/wiki/SMDH#Icon_graphics
	private getZFromXY(x: number, y: number): number {
		let z = 0;

		for (let bit = 0; x >> bit; bit++) {
			z |= (x & (1 << bit)) << bit;
		}

		for (let bit = 0; y >> bit; bit++) {
			z |= (y & (1 << bit)) << (bit + 1);
		}

		return z;
	}

	public parseFromBuffer(pixelData: Buffer, alphaData: Buffer | undefined): void {
		const expectedPixelDataSize = (this.width * this.height) * 2;
		const expectedAlphaDataSize = Math.ceil((this.width * this.height) / 2);

		if (pixelData.length > expectedPixelDataSize) {
			throw new Error('Bad RGB565 data. Not enough data for the given width and height');
		}

		if (pixelData.length % 2 !== 0) {
			throw new Error('Bad RGB565 data. Data length is not module of 2');
		}

		if (alphaData) {
			if (alphaData.length !== expectedAlphaDataSize) {
				throw new Error('Bad alpha data. Data length does not match the width and height');
			}
		} else if (pixelData.length === expectedPixelDataSize+expectedAlphaDataSize) {
			// * Assume pixelData contains the alpha data at the end
			pixelData = pixelData.subarray(0, expectedPixelDataSize);
			alphaData = pixelData.subarray(expectedPixelDataSize);
		}

		for (let y = 0; y < this.height; y++) {
			for (let x = 0; x < this.width; x++) {
				// TODO - This is the same in `encode`. Break this out into it's own function, like `getZFromXY`?
				const tileX = Math.floor(x / 8);
				const tileY = Math.floor(y / 8);
				const z = this.getZFromXY(x % 8, y % 8);
				const tileIndex = tileY * (this.width / 8) + tileX;
				const i = z + tileIndex * 64;

				const color = pixelData.readUint16LE(i * 2);
				const red   = (color & 0b1111100000000000) >> 8;
				const green = (color & 0b0000011111100000) >> 3;
				const blue  = (color & 0b0000000000011111) << 3;
				let alpha   = 0xFF;

				if (alphaData) {
					const alphaIndex = Math.floor(i / 2);
					const alphaNibble = (i % 2) * 4; // * High or low nibble. 2 pixels per byte
					const alphaByte = alphaData[alphaIndex];

					alpha = (alphaByte >> alphaNibble) & 0x0F; // * Get the 4 bits from the byte we care about for the pixel
					alpha = alpha * 0x11; // * Scale up from 4 bits to 8
				}

				this.pixelData.push({ red, green, blue, alpha });
			}
		}
	}

	public encode(): { pixelData: Buffer, alphaData: Buffer } {
		const pixelData = Buffer.alloc(this.width * this.height * 2);
		const alphaData = Buffer.alloc(Math.ceil(this.width * this.height / 2));

		for (let y = 0; y < this.height; y++) {
			for (let x = 0; x < this.width; x++) {
				const tileX = Math.floor(x / 8);
				const tileY = Math.floor(y / 8);
				const z = this.getZFromXY(x % 8, y % 8);
				const tileIndex = tileY * (this.width / 8) + tileX;
				const i = z + tileIndex * 64;

				const pixel = this.pixelData[y * this.width + x];

				const r = pixel.red >> 3;
				const g = pixel.green >> 2;
				const b = pixel.blue >> 3;
				const color = (r << 11) | (g << 5) | b;

				pixelData.writeUInt16LE(color, i * 2);

				const alphaIndex = Math.floor(i / 2);
				const alphaNibble = (i % 2) * 4; // * High or low nibble. 2 pixels per byte
				const a = pixel.alpha >> 4; // * Scale down to 4 bits
				const alphaByte = alphaData[alphaIndex];

				alphaData[alphaIndex] = alphaByte | (a << alphaNibble);
			}
		}

		return { pixelData, alphaData };
	}

	public pixels(): Pixel[] {
		return this.pixelData;
	}
}