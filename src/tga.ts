// * Based on:
// * - https://wikipedia.org/wiki/Truevision_TGA
// * - https://paulbourke.net/dataformats/tga

import StreamIn from '@/stream-in';
import StreamOut from '@/stream-out';

type Pixel = {
	blue: number;
	green: number;
	red: number;
	attribute: number; // * Only present in 4 byte color maps
};

/**
 * A parser and encoder for the Truevision TGA (Targa) image format.
 */
export default class TGA {
	private readStream: StreamIn;
	private writeStream: StreamOut;

	private imageIdentificationLength: number;
	public identification: Buffer;
	public colorMapType: number;
	public imageType: number;
	public colorMapSpecification: {
		firstEntryIndex: number;
		length: number;
		entrySize: number;
	};

	public imageSpecification: {
		originX: number;
		originY: number;
		width: number;
		height: number;
		pixelDensity: number;
		attributeDensity: number;
		bottomUp: boolean;
		leftToRight: boolean;
	};

	public colorMap: Pixel[];
	public pixels: Pixel[];

	/**
     * Magic string used in the optional TGA footer
     * to identify Truevision files.
     */
	static Magic = Buffer.from('TRUEVISION-XFILE.\0'); // * Used in the optional footer. Unused here

	static ColorMapTypes = {
		None:       0,                                           // * No color map
		Present:    1,                                           // * Has a color map
		Truevision: Array.from({ length: 126 }, (_, i) => i + 2),  // * 2-127. Reserved by Truevision?
		Developer:  Array.from({ length: 128 }, (_, i) => i + 128) // * 128-255. Available for developer use?
	};

	static ColorMapEntrySizes = {
		None:    0,  // * No color map used
		Targa16: 16, // * 2 bytes per entry. ARRRRRGG GGGBBBBB. Each letter is a bit. "A" represents an attribute bit
		Targa24: 24, // * 3 bytes per entry. BGR
		Targa32: 32  // * 4 bytes per entry. BGRA. "A" represents an attribute byte
	};

	static ImageTypes = {
		NoData:                  0,  // * No image data is present
		UncompressedColorMapped: 1,  // * Uncompressed color-mapped image
		UncompressedTrueColor:   2,  // * Uncompressed true-color image
		UncompressedGrayscale:   3,  // * Uncompressed grayscale image
		RLEColorMapped:          9,  // * RLE color-mapped image
		RLETrueColor:            10, // * RLE true-color image
		RLEGrayscale:            11  // * RLE grayscale image
	};

	static PixelDensities = {
		Targa16: 16,
		Targa24: 24,
		Targa32: 32
	};

	// TODO - Should these be renamed to to size of the attribute, not the size of the pixels?
	static AttributeDensities = {
		Targa16: 1, // * 16 bit pixels have 1 bit for the attribute
		Targa24: 0, // * 24 bit pixels have no attribute
		Targa32: 8  // * 32 bit pixels have 1 byte for the attribute
	};

	/**
     * Creates a new TGA instance with default metadata fields
     * (uncompressed 32-bit true-color image, no color map)
     */
	constructor() {
		this.imageIdentificationLength = 0;
		this.identification = Buffer.alloc(0);
		this.colorMapType = TGA.ColorMapTypes.None;
		this.imageType = TGA.ImageTypes.UncompressedTrueColor;
		this.colorMapSpecification = {
			firstEntryIndex: 0,
			length: 0,
			entrySize: 0
		};
		this.imageSpecification = {
			originX: 0,
			originY: 0,
			width: 0,
			height: 0,
			pixelDensity: TGA.PixelDensities.Targa32,
			attributeDensity: TGA.AttributeDensities.Targa32,
			bottomUp: true,
			leftToRight: true
		};
		this.colorMap = [];
		this.pixels = [];
	}

	/**
     * Validates the color map type.
     *
     * @param colorMapType - The color map type value.
     * @throws If the type is invalid or unsupported.
     */
	private validateColorMapType(colorMapType: number): void {
		if (
			colorMapType !== TGA.ColorMapTypes.None &&
			colorMapType !== TGA.ColorMapTypes.Present &&
			!TGA.ColorMapTypes.Truevision.includes(colorMapType) &&
			!TGA.ColorMapTypes.Developer.includes(colorMapType)
		) {
			throw new Error(`Got invalid color map type. Expected one of 0 (None), 1 (Present), 2-127 (reserved by Truevision), 128-255 (available for developer use). Got ${colorMapType}`);
		}

		// * Only support no color map images for now
		if (colorMapType !== TGA.ColorMapTypes.None) {
			throw new Error('Only images with no color map supported');
		}
	}

	/**
     * Validates the color image type.
     *
     * @param imageType - The image type value.
     * @throws If the type is invalid or unsupported.
     */
	private validateImageType(imageType: number): void {
		if (
			imageType !== TGA.ImageTypes.NoData &&
			imageType !== TGA.ImageTypes.UncompressedColorMapped &&
			imageType !== TGA.ImageTypes.UncompressedTrueColor &&
			imageType !== TGA.ImageTypes.UncompressedGrayscale &&
			imageType !== TGA.ImageTypes.RLEColorMapped &&
			imageType !== TGA.ImageTypes.RLETrueColor &&
			imageType !== TGA.ImageTypes.RLEGrayscale
		) {
			throw new Error(`Got invalid image type. Expected one of 0 (No image data is present), 1 (Uncompressed color-mapped image), 2 (Uncompressed true-color image), 3 (Uncompressed grayscale image), 9 (RLE color-mapped image), 10 (RLE true-color image), 11 (RLE grayscale image). Got ${imageType}`);
		}

		// * Only support uncompressed true color for now
		if (imageType !== TGA.ImageTypes.UncompressedTrueColor) {
			throw new Error('Only images with no color map supported');
		}
	}

	/**
     * Validates the color map entry size.
     *
     * @param colorMapEntrySize - The entry size value.
     * @throws If invalid or unsupported.
     */
	private validateColorMapEntrySize(colorMapEntrySize: number): void {
		if (
			colorMapEntrySize !== TGA.ColorMapEntrySizes.None &&
			colorMapEntrySize !== TGA.ColorMapEntrySizes.Targa16 &&
			colorMapEntrySize !== TGA.ColorMapEntrySizes.Targa24 &&
			colorMapEntrySize !== TGA.ColorMapEntrySizes.Targa32
		) {
			throw new Error(`Got invalid color map entry size. Expected one of 16 (2 bytes), 24 (3 bvytes) or 32 (4 bytes). Got ${colorMapEntrySize}`);
		}

		// * Only support no color map images for now
		if (colorMapEntrySize !== TGA.ColorMapEntrySizes.None) {
			throw new Error('Only images with no color map supported');
		}
	}

	/**
     * Validates the pixel density.
     *
     * @param pixelDensity - The pixel density in bits.
     * @throws If not one of 16, 24 or 32.
     */
	private validatePixelDensity(pixelDensity: number): void {
		if (
			pixelDensity !== TGA.PixelDensities.Targa16 &&
			pixelDensity !== TGA.PixelDensities.Targa24 &&
			pixelDensity !== TGA.PixelDensities.Targa32
		) {
			throw new Error(`Got invalid pixel density. Expected one of 16 (2 bytes), 24 (3 bvytes) or 32 (4 bytes). Got ${pixelDensity}`);
		}

		// * Only support BGRA images for now
		if (pixelDensity !== TGA.PixelDensities.Targa32) {
			throw new Error('Only Targa32 images supported');
		}
	}

	/**
     * Validates the attribute density.
     *
     * @param attributeDensity - The attribute density in bits.
     * @throws If invalid for the given pixel depth.
     */
	private validateAttributeDensity(attributeDensity: number): void {
		if (
			attributeDensity !== TGA.AttributeDensities.Targa16 &&
			attributeDensity !== TGA.AttributeDensities.Targa24 &&
			attributeDensity !== TGA.AttributeDensities.Targa32
		) {
			throw new Error(`Got invalid attribute density. Expected one of 1 (2 bytes), 0 (3 bvytes) or 8 (4 bytes). Got ${attributeDensity}`);
		}

		if (this.imageSpecification.pixelDensity === TGA.PixelDensities.Targa16 && attributeDensity !== TGA.AttributeDensities.Targa16) {
			throw new Error(`Got invalid attribute density. 16 bit pixels uses 1 bit attributes. Got ${attributeDensity}`);
		}

		if (this.imageSpecification.pixelDensity === TGA.PixelDensities.Targa24 && attributeDensity !== TGA.AttributeDensities.Targa24) {
			throw new Error(`Got invalid attribute density. 24 bit pixels have no attribute bits. Got ${attributeDensity}`);
		}

		if (this.imageSpecification.pixelDensity === TGA.PixelDensities.Targa32 && attributeDensity !== TGA.AttributeDensities.Targa32) {
			throw new Error(`Got invalid attribute density. 32 bit pixels uses 8 bit (1 byte) attributes. Got ${attributeDensity}`);
		}

		// * Only support BGRA images for now
		if (attributeDensity !== TGA.AttributeDensities.Targa32) {
			throw new Error('Only Targa32 images supported');
		}
	}

	/**
     * Parses a TGA image from a raw buffer.
     *
     * @param buffer - The buffer containing TGA image data.
     */
	public parseFromBuffer(buffer: Buffer): void {
		this.readStream = new StreamIn(buffer);
		this.parse();
	}

	/** Parses the image structure. */
	private parse(): void {
		this.parseHeader();
		this.identification = this.readStream.readBytes(this.imageIdentificationLength);
		this.parseColorMap();
		this.parseImageData();
		// * Ignoring optional areas for now
	}

	/** Parses the TGA header. */
	private parseHeader(): void {
		this.imageIdentificationLength = this.readStream.readUint8();
		this.colorMapType = this.readStream.readUint8();

		this.validateColorMapType(this.colorMapType);

		this.imageType = this.readStream.readUint8();

		this.validateImageType(this.imageType);

		this.parseColorMapSpecification();
		this.parseImageSpecification();
	}

	/** Parses the color map specification section. */
	private parseColorMapSpecification(): void {
		this.colorMapSpecification.firstEntryIndex = this.readStream.readUint16LE();
		this.colorMapSpecification.length = this.readStream.readUint16LE();
		this.colorMapSpecification.entrySize = this.readStream.readUint8();

		this.validateColorMapEntrySize(this.colorMapSpecification.entrySize);
	}

	/** Parses the image specification section. */
	private parseImageSpecification(): void {
		this.imageSpecification.originX = this.readStream.readUint16LE();
		this.imageSpecification.originY = this.readStream.readUint16LE();
		this.imageSpecification.width = this.readStream.readUint16LE();
		this.imageSpecification.height = this.readStream.readUint16LE();
		this.imageSpecification.pixelDensity = this.readStream.readUint8();

		this.validatePixelDensity(this.imageSpecification.pixelDensity);

		const imageDescriptor = this.readStream.readUint8();

		const attributeDensity = imageDescriptor & 0x0F; // * Bits 3-0 give the number of attribute bits for each pixel (usually alpha)
		const pixelOrdering = (imageDescriptor >> 4) & 0x03; // * Bits 5-4 give pixel ordering
		const leftToRight = (pixelOrdering & 0x01) !== 0; // * Bit 4 indicates right-to-left if set
		const bottomUp = (pixelOrdering & 0x02) !== 0; // * Bit 5 indicates an ordering of top-to-bottom if set

		this.imageSpecification.attributeDensity = attributeDensity;
		this.imageSpecification.bottomUp = bottomUp;
		this.imageSpecification.leftToRight = leftToRight;

		this.validateAttributeDensity(this.imageSpecification.attributeDensity);
	}

	/** Parses the color map entries (if present). */
	private parseColorMap(): void {
		// * Not all images have a color map
		if (this.colorMapType === TGA.ColorMapTypes.None) {
			return;
		}

		if (this.imageType !== TGA.ImageTypes.UncompressedColorMapped && this.imageType !== TGA.ImageTypes.RLEColorMapped) {
			return;
		}

		if (this.colorMapSpecification.length === 0) {
			throw new Error('Color map length is 0. Image type and color map specification indicate image has color map');
		}

		if (this.colorMapSpecification.length  < this.colorMapSpecification.entrySize) {
			throw new Error('Color map entry size does not fit inside specified length. Color map length is less than entry size');
		}

		if (this.colorMapSpecification.length  % this.colorMapSpecification.entrySize !== 0) {
			throw new Error('Color map entry size does not fit inside specified length. Color map length is not a multiple of entry size');
		}

		const entries = this.colorMapSpecification.length / this.colorMapSpecification.entrySize;

		for (let i = 0; i < entries; i++) {
			this.colorMap.push(this.parseColor());
		}
	}

	/**
     * Parses a single color from the input stream.
     *
     * @returns A parsed pixel.
     */
	private parseColor(): Pixel {
		const color = {
			blue: 0,
			green: 0,
			red: 0,
			attribute: 0
		};

		if (this.colorMapSpecification.entrySize === TGA.ColorMapEntrySizes.Targa16) {
			// * ARRRRRGG GGGBBBBB. Each letter is a bit. "A" represents an attribute bit.
			// * Because of the lo-hi storage order, the first byte coming from the file
			// * will actually be GGGBBBBB, and the second will be ARRRRRGG
			// * http://www.paulbourke.net/dataformats/tga/
			const byte1 = this.readStream.readUint8();
			const byte2 = this.readStream.readUint8();

			const GGG = (byte1 >> 3) & 0x1F;
			const BBBB = byte1 & 0x07;

			const A = (byte2 >> 7) & 0x01;
			const RRRRR = (byte2 >> 2) & 0x1F;
			const GG = (byte2 << 3) & 0x1C;

			color.red = (RRRRR << 3);
			color.green = (GG | (GGG >> 2));
			color.blue = (BBBB << 3);
			color.attribute = A;
		} else if (this.colorMapSpecification.entrySize === TGA.ColorMapEntrySizes.Targa24) {
			color.blue = this.readStream.readUint8();
			color.green = this.readStream.readUint8();
			color.red = this.readStream.readUint8();
		} else {
			color.blue = this.readStream.readUint8();
			color.green = this.readStream.readUint8();
			color.red = this.readStream.readUint8();
			color.attribute = this.readStream.readUint8();
		}

		return color;
	}

	/** Parses image pixel data. */
	private parseImageData(): void {
		// TODO - The others
		if (this.imageType === TGA.ImageTypes.UncompressedTrueColor) {
			this.parseUncompressedTrueColor();
		}
	}

	/** Parses uncompressed true-color pixel data. */
	private parseUncompressedTrueColor(): void {
		const pixels = this.imageSpecification.width * this.imageSpecification.height;

		for (let i = 0; i < pixels; i++) {
			this.pixels.push(this.parseColor());
		}
	}

	/**
     * Encodes the current TGA instance into a buffer.
     *
     * @returns A buffer containing TGA image data.
     */
	public encode(): Buffer {
		this.writeStream = new StreamOut();

		this.encodeHeader();
		this.writeStream.writeBytes(this.identification);
		this.encodeColorMap();
		this.encodeImageData();
		// * Ignoring optional areas for now

		return this.writeStream.bytes();
	}

	/**
     * Encodes the header fields into the output stream.
     */
	private encodeHeader(): void {
		this.validateColorMapType(this.colorMapType);
		this.validateImageType(this.imageType);

		if (this.identification.length > 255) {
			throw new Error('Image identification field may only be up to 255 bytes long');
		}

		this.writeStream.writeUint8(this.identification.length);
		this.writeStream.writeUint8(this.colorMapType);
		this.writeStream.writeUint8(this.imageType);

		this.encodeColorMapSpecification();
		this.encodeImageSpecification();
	}

	/** Encodes the color map specification fields. */
	private encodeColorMapSpecification(): void {
		this.validateColorMapEntrySize(this.colorMapSpecification.entrySize);

		// TODO - Support color maps properly. The first 2 fields should always be 0 right now
		this.writeStream.writeUint16LE(this.colorMapSpecification.firstEntryIndex);
		this.writeStream.writeUint16LE(this.colorMapSpecification.length);
		this.writeStream.writeUint8(this.colorMapSpecification.entrySize);
	}

	/** Encodes the image specification fields. */
	private encodeImageSpecification(): void {
		this.validatePixelDensity(this.imageSpecification.pixelDensity);
		this.validateAttributeDensity(this.imageSpecification.attributeDensity);

		this.writeStream.writeUint16LE(this.imageSpecification.originX);
		this.writeStream.writeUint16LE(this.imageSpecification.originY);
		this.writeStream.writeUint16LE(this.imageSpecification.width);
		this.writeStream.writeUint16LE(this.imageSpecification.height);
		this.writeStream.writeUint8(this.imageSpecification.pixelDensity);

		let imageDescriptor = 0;

		imageDescriptor |= this.imageSpecification.attributeDensity & 0x0F; // * Bits 3-0 give the number of attribute bits for each pixel (usually alpha)
		imageDescriptor |= (this.imageSpecification.bottomUp ? 1 : 0) << 4; // * Bit 4 indicates right-to-left if set
		imageDescriptor |= (this.imageSpecification.leftToRight ? 1 : 0) << 5; // * Bit 5 indicates an ordering of top-to-bottom if set

		this.writeStream.writeUint8(imageDescriptor);
	}

	/**
     * Encodes the color map entries (if present).
     *
     * @throws If inconsistent with the specification.
     */
	private encodeColorMap(): void {
		// * Not all images have a color map
		if (this.colorMapType === TGA.ColorMapTypes.None) {
			return;
		}

		if (this.imageType !== TGA.ImageTypes.UncompressedColorMapped && this.imageType !== TGA.ImageTypes.RLEColorMapped) {
			return;
		}

		if (this.colorMap.length === 0) {
			throw new Error('Color map length is 0. Image type and color map specification indicate image has color map');
		}

		for (const color of this.colorMap) {
			this.encodeColor(color);
		}
	}

	/**
     * Encodes a single color entry.
     *
     * @param color - The pixel to encode.
     */
	private encodeColor(color: Pixel): void {
		if (this.colorMapSpecification.entrySize === TGA.ColorMapEntrySizes.Targa16) {
			const byte1 = ((color.green >> 3) & 0x1F) | ((color.blue & 0x1C) >> 3);
			const byte2 = ((color.attribute & 0x01) << 7) | ((color.red >> 3) & 0x1F) | ((color.green & 0x07) << 2);

			this.writeStream.writeUint8(byte1);
			this.writeStream.writeUint8(byte2);
		} else if (this.colorMapSpecification.entrySize === TGA.ColorMapEntrySizes.Targa24) {
			this.writeStream.writeUint8(color.blue);
			this.writeStream.writeUint8(color.green);
			this.writeStream.writeUint8(color.red);
		} else {
			this.writeStream.writeUint8(color.blue);
			this.writeStream.writeUint8(color.green);
			this.writeStream.writeUint8(color.red);
			this.writeStream.writeUint8(color.attribute);
		}
	}

	/** Encodes image pixel data. */
	private encodeImageData(): void {
		// TODO - The others
		if (this.imageType === TGA.ImageTypes.UncompressedTrueColor) {
			this.encodeUncompressedTrueColor();
		}
	}

	/**
     * Encodes uncompressed 32-bit true-color image.
     *
     * @throws If the number of pixels does not match
     * the specified dimensions.
     */
	private encodeUncompressedTrueColor(): void {
		if (this.imageSpecification.width * this.imageSpecification.height !== this.pixels.length) {
			throw new Error(`Got bad image dimensions. Set to ${this.imageSpecification.width}x${this.imageSpecification.height}, but got ${this.pixels.length} pixels`);
		}

		for (const pixel of this.pixels) {
			this.encodeColor(pixel);
		}
	}
}
