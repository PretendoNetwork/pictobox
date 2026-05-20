// * Based on:
// * - https://github.com/PretendoNetwork/ita-bag/blob/3a975effeaed54d8cef89afc1f9e9a236254b848/rgb565.js

type Pixel = {
	red: number;
	green: number;
	blue: number;
	alpha: number;
};

/**
 * Represents Nintendo's RGB565 image format.
 *
 * RGB565A4 is a variant of RGB565 that:
 * - Uses 16-bit RGB565 color data.
 * - Stores pixel data in Z-order morton order rather than row-major order.
 *
 * See:
 * - https://www.3dbrew.org/wiki/SMDH#Icon_graphics
 * - https://en.widipedia.org/wiki/Z-order_curve
 */
export default class RGB565 {
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
	 *
	 * @throws If the buffer sizes do not match the expected image size.
	 */
	public parseFromBuffer(pixelData: Buffer): void {
		const expectedPixelDataSize = (this.width * this.height) * 2;

		if (pixelData.length > expectedPixelDataSize) {
			throw new Error('Bad RGB565 data. Not enough data for the given width and height');
		}

		if (pixelData.length % 2 !== 0) {
			throw new Error('Bad RGB565 data. Data length is not module of 2');
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
				const alpha = 0xFF;

				this.pixels.push({ red, green, blue, alpha });
			}
		}
	}

	/**
	 * Encodes the current {@link pixels} into RGB565A4 buffers.
	 *
	 * @returns Encoded RGBA pixel data, where the alpha channel is always set to 0xFF.
	 *
	 * @throws If {@link pixels} does not match the expected size (`width * height`).
	 */
	public encode(): Buffer {
		const pixelData = Buffer.alloc(this.width * this.height * 2);

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
			}
		}

		return pixelData;
	}
}
