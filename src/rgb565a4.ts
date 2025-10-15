// * Based on:
// * - https://github.com/PretendoNetwork/ita-bag/blob/3a975effeaed54d8cef89afc1f9e9a236254b848/rgb565.js

type Pixel = {
	red: number;
	green: number;
	blue: number;
	alpha: number;
};

/**
 * Represents Nintendo's RGB565A4 image format.
 *
 * RGB565A4 is a variant of RGB565 that:
 * - Uses 16-bit RGB565 color data.
 * - Optionally includes a separate 4-bit alpha channel.
 * - Stores pixel data in Z-order morton order rather than row-major order.
 *
 * See:
 * - https://www.3dbrew.org/wiki/SMDH#Icon_graphics
 * - https://en.widipedia.org/wiki/Z-order_curve
 */
export default class RGB565A4 {
	public width: number;
	public height: number;
	public pixels: Pixel[] = [];

	/**
     * Computes a Z-order index from XY coordinates.
     *
     * The Z-order curve is used to scramble pixels within an 8x8 tile
     * so that spatial locality is preserved in memory.
     *
     * @param x - X coordinate within the tile (0-7).
     * @param y - Y coordinate within the tile (0-7).
     * @returns The Z-order index of the pixel.
     *
     * @see https://en.wikipedia.org/wiki/Z-order_curve
     */
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

	/**
     * Parses raw RGB565A4 data from buffers and populates {@link pixels}.
     *
     * @param pixelData - Buffer containing RGB565 pixel data.
     * @param alphaData - Optional buffer containing packed 4-bit alpa data.
     *   If omitted, all pixels are assumed fully opaque (alpha=255).
     *   If undefined but extra data exists at the end of `pixelData`,
     *   it is interpreted as alpha data.
     *
     * @throws If the buffer sizes do not match the expected image size.
     */
	public parseFromBuffer(pixelData: Buffer, alphaData: Buffer | undefined): void {
		const expectedPixelDataSize = (this.width * this.height) * 2;
		const expectedAlphaDataSize = Math.ceil((this.width * this.height) / 2);

		if (pixelData.length > expectedPixelDataSize) {
			throw new Error('Bad RGB565 data. Not enough data for the given width and height');
		}

		if (pixelData.length % 2 !== 0) {
			throw new Error('Bad RGB565 data. Data length is not module of 2');
		}

		if (alphaData && alphaData.length !== expectedAlphaDataSize) {
			throw new Error('Bad alpha data. Data length does not match the width and height');
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

				this.pixels.push({ red, green, blue, alpha });
			}
		}
	}

	/**
     * Encodes the current {@link pixels} into RGB565A4 buffers.
     *
     * @returns An object containing:
     * - `pixelData`: Buffer with RGB565 pixel data.
     * - `alphaData`: Buffer with packed 4-bit alpa data.
     *
     * @throws If {@link pixels} does not match the expected size
     *      (`width * height`).
     */
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

				const pixel = this.pixels[y * this.width + x];

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
}
