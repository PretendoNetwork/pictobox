/**
 * Represents the StreamOut class.
 */
export default class StreamOut {
	private buffer: Buffer;

	/**
	 * The pos
	 */
	public pos: number;

	constructor() {
		this.buffer = Buffer.alloc(0);
		this.pos = 0;
	}

	/**
	 * Represents the buffer
	 *
	 * @returns the byte buffer
	 */
	public bytes(): Buffer {
		return this.buffer;
	}

	/**
	 * Represents the size number
	 *
	 * @returns the buffer length
	 */
	public size(): number {
		return this.buffer.length;
	}

	/**
	 * Writes memory at the length param
	 *
	 * @param length - the start point to write bytes
	 */
	public skip(length: number): void {
		this.writeBytes(Buffer.alloc(length));
	}

	/**
	 * Sets pos
	 *
	 * @param pos - the chosen pos
	 */
	public seek(pos: number): void {
		this.pos = pos;
	}

	/**
	 * Writes the byte buffer
	 *
	 * @param bytes - the buffer
	 */
	public writeBytes(bytes: Buffer): void {
		const before = this.buffer.subarray(0, this.pos);
		const after = this.buffer.subarray(this.pos);

		this.buffer = Buffer.concat([
			before,
			bytes,
			after
		]);

		this.pos += bytes.length;
	}

	/**
	 * Writes the uint8
	 *
	 * @param uint8 - the buffer
	 */
	public writeUint8(uint8: number): void {
		const bytes = Buffer.alloc(1);

		bytes.writeUint8(uint8);

		this.writeBytes(bytes);
	}

	/**
	 * Writes the uint16 as little-endian
	 *
	 * @param uint16 - the number
	 */
	public writeUint16LE(uint16: number): void {
		const bytes = Buffer.alloc(2);

		bytes.writeUint16LE(uint16);

		this.writeBytes(bytes);
	}

	/**
	 * Writes the uint32 as little-endian
	 *
	 * @param uint32 - the number
	 */
	public writeUint32LE(uint32: number): void {
		const bytes = Buffer.alloc(4);

		bytes.writeUint32LE(uint32);

		this.writeBytes(bytes);
	}

	/**
	 * Writes the int32 as little-endian
	 *
	 * @param int32 - the number
	 */
	public writeInt32LE(int32: number): void {
		const bytes = Buffer.alloc(4);

		bytes.writeInt32LE(int32);

		this.writeBytes(bytes);
	}

	/**
	 * Writes the uint16 as big-endian
	 *
	 * @param uint16 - the number
	 */
	public writeUint16BE(uint16: number): void {
		const bytes = Buffer.alloc(2);

		bytes.writeUint16BE(uint16);

		this.writeBytes(bytes);
	}

	/**
	 * Writes the uint32 as big-endian
	 *
	 * @param uint32 - the number
	 */
	public writeUint32BE(uint32: number): void {
		const bytes = Buffer.alloc(4);

		bytes.writeUint32BE(uint32);

		this.writeBytes(bytes);
	}
}