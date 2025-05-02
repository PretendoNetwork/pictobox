/**
 * A class for writing binary data to a Buffer
 */
export default class StreamOut {
	private buffer: Buffer;
	public pos: number;

	/**
	 * Creates a new StreamOut instance with an empty buffer
	 */
	constructor() {
		this.buffer = Buffer.alloc(0);
		this.pos = 0;
	}

	/**
	 * Gets the current buffer
	 * @returns The current buffer
	 */
	public bytes(): Buffer {
		return this.buffer;
	}

	/**
	 * Gets the total size of the buffer
	 * @returns The total size of the buffer in bytes
	 */
	public size(): number {
		return this.buffer.length;
	}

	/**
	 * Skips the specified number of bytes by writing zeros
	 * @param length - Number of bytes to skip
	 */
	public skip(length: number): void {
		this.writeBytes(Buffer.alloc(length));
	}

	/**
	 * Sets the current write position
	 * @param pos - The new write position
	 */
	public seek(pos: number): void {
		this.pos = pos;
	}

	/**
	 * Writes bytes to the buffer
	 * @param bytes - The bytes to write
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
	 * Writes an unsigned 8-bit integer
	 * @param uint8 - The value to write
	 */
	public writeUint8(uint8: number): void {
		const bytes = Buffer.alloc(1);

		bytes.writeUint8(uint8);

		this.writeBytes(bytes);
	}

	/**
	 * Writes an unsigned 16-bit integer in little-endian format
	 * @param uint16 - The value to write
	 */
	public writeUint16LE(uint16: number): void {
		const bytes = Buffer.alloc(2);

		bytes.writeUint16LE(uint16);

		this.writeBytes(bytes);
	}

	/**
	 * Writes an unsigned 32-bit integer in little-endian format
	 * @param uint32 - The value to write
	 */
	public writeUint32LE(uint32: number): void {
		const bytes = Buffer.alloc(4);

		bytes.writeUint32LE(uint32);

		this.writeBytes(bytes);
	}

	/**
	 * Writes a signed 32-bit integer in little-endian format
	 * @param int32 - The value to write
	 */
	public writeInt32LE(int32: number): void {
		const bytes = Buffer.alloc(4);

		bytes.writeInt32LE(int32);

		this.writeBytes(bytes);
	}

	/**
	 * Writes an unsigned 16-bit integer in big-endian format
	 * @param uint16 - The value to write
	 */
	public writeUint16BE(uint16: number): void {
		const bytes = Buffer.alloc(2);

		bytes.writeUint16BE(uint16);

		this.writeBytes(bytes);
	}

	/**
	 * Writes an unsigned 32-bit integer in big-endian format
	 * @param uint32 - The value to write
	 */
	public writeUint32BE(uint32: number): void {
		const bytes = Buffer.alloc(4);

		bytes.writeUint32BE(uint32);

		this.writeBytes(bytes);
	}
}